// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 进程装配：把数据目录变成一个可用的 `AppState`。
//!
//! 独立形态（`main.rs`）和 DBX 插件形态（`plugin/backend`）走的是同一条启动路径，
//! 差别只在装配完之后接什么传输：前者挂 axum 路由并写发现文件，后者把
//! `state.events` 转发到 stdio。凡是「与传输无关但必须在启动时做一次」的事情都
//! 属于这里——打开数据库、起音频 actor、从 settings 恢复音量/模式/DSP/音质偏好、
//! 注入 `weak_self`、起事件泵、迁移凭据、起目录监听、回收在线缓存。
//!
//! 之所以必须在 crate 内部：`AppState` 的 `qr`、`weak_self` 等字段是 `pub(crate)`，
//! 外部 crate 连结构体都拼不出来。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::broadcast;
use vmusic_audio::{spawn, BackendKind};

use crate::config::Config;
use crate::diag;
use crate::online;
use crate::persist;
use crate::scan;
use crate::state::{spawn_event_pump, AppState, DspConfig};

/// 装配完成的运行时。调用方必须把它保活到进程结束。
pub struct Booted {
    pub state: Arc<AppState>,
    pub config: Config,
    /// 真正生效的音频后端名。请求 cpal 但拿不到设备时会回落到 null，而
    /// 「有声吗」正是播放诊断的第一问句，所以记的是跑起来的那个。
    pub backend_label: String,
    /// 音频 actor 的专属线程。
    pub audio_thread: std::thread::JoinHandle<()>,
}

/// 建好数据目录并读出配置。
///
/// 单独拆出来是因为日志初始化要读 `config.log`，而它必须发生在 [`boot`] 之前——
/// 否则启动早期的日志全丢。
pub async fn prepare(data_dir: &Path) -> anyhow::Result<Config> {
    tokio::fs::create_dir_all(data_dir).await?;
    Ok(Config::load(data_dir)?)
}

/// 装配出完整的运行时。
///
/// `token` 只被 HTTP 形态用来鉴权；插件形态的 stdio 天然可信，传什么都行，
/// 但 `AppState` 的字段要求有值，所以由调用方决定策略而不是在这里生成。
pub async fn boot(data_dir: PathBuf, config: Config, token: String) -> anyhow::Result<Booted> {
    let db = vmusic_store::open(&data_dir).await?;

    let backend = match config.audio.backend.as_str() {
        "null" => BackendKind::Null,
        _ => BackendKind::cpal(),
    };
    let mut backend_label = config.audio.backend.clone();
    let (audio, audio_thread) = match spawn(backend).await {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!("requested backend unavailable ({e}); falling back to null");
            backend_label = "null".to_string();
            spawn(BackendKind::Null).await?
        }
    };

    // 开发者选项里的播放诊断日志：默认关闭，开着则跨重启继续录（settings 为权威）。
    diag::init(&data_dir, &backend_label);
    let diag_enabled = vmusic_store::settings::get(&db, diag::SETTING_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    diag::set_enabled(diag_enabled);

    // 音量/模式以服务端 settings 为权威；缺键才回落到 config 默认。
    let (restore_volume, restore_mode) =
        persist::load_player_prefs(&db, config.audio.volume, vmusic_core::PlayMode::Repeat).await;
    audio.set_volume(restore_volume).await.ok();
    audio.set_mode(restore_mode).await.ok();

    // 逐源音质偏好以 settings 为权威；缺键/坏值由 load 内部回落为缺省表。
    let quality_prefs = online::quality::load(&db).await.unwrap_or_default();
    // 用户显式保留的缓存条目（跨重启保留）。
    let keep_list: Vec<String> = persist::load_strings(&db, "online_keep")
        .await
        .unwrap_or_default();
    // DSP 设置：EQ/响度归一化/交叉淡化，跨重启恢复。
    let dsp_config = DspConfig::from_settings(
        &vmusic_store::settings::get_all(&db)
            .await
            .unwrap_or_default(),
    );

    let (events, _) = broadcast::channel(128);
    let state = Arc::new(AppState {
        db,
        audio,
        config: Arc::new(config.clone()),
        data_dir: data_dir.clone(),
        token: token.clone(),
        events,
        queue: Default::default(),
        cursor: Default::default(),
        radio: Default::default(),
        radio_fetch: Default::default(),
        scan: Default::default(),
        scan_cancel: Default::default(),
        qr: online::qr::Registry::new(),
        play_generation: Default::default(),
        play_commit: Default::default(),
        buffering: Default::default(),
        online_meta: Default::default(),
        downloads: Default::default(),
        protected: Default::default(),
        keep: tokio::sync::Mutex::new(keep_list),
        dsp: tokio::sync::Mutex::new(dsp_config.clone()),
        auto_failures: Default::default(),
        quality: tokio::sync::Mutex::new(quality_prefs),
        stage_beats: Default::default(),
        weak_self: Default::default(),
    });
    // 供 on_track_committed detach 'static 后台任务用；set 失败只可能是
    // 重复注入，启动路径只走一次，忽略即可。
    let _ = state.weak_self.set(Arc::downgrade(&state));
    spawn_event_pump(state.clone());
    // DSP 即时下发（播放时再按曲目追加 track_gain）。
    let _ = state
        .audio
        .set_dsp(vmusic_core::DspParams {
            eq_gains_db: dsp_config.eq_gains_db,
            preamp_db: dsp_config.preamp_db,
            track_gain_db: 0.0,
        })
        .await;
    let _ = state.audio.set_crossfade(dsp_config.crossfade_ms).await;

    // 凭据迁移：SQLite 旧明文凭据 → 系统钥匙串。失败保留旧数据并记 ERROR。
    let db_handle = state.db.clone();
    tokio::spawn(async move {
        online::cred::migrate_secrets_to_keyring(&db_handle).await;
    });
    scan::spawn_watcher(state.clone());

    // 清掉上次崩溃留下的半截下载，并按配置做一次缓存容量回收。
    {
        let cache_dir = state.online_cache_dir();
        online::cache::clean_parts(&cache_dir).await;
        let max = state.config.online.cache_max_bytes;
        if let Err(e) = online::cache::enforce_limit(&cache_dir, max, &[]).await {
            tracing::warn!("缓存 LRU 回收失败: {e}");
        }
    }

    Ok(Booted {
        state,
        config,
        backend_label,
        audio_thread,
    })
}
