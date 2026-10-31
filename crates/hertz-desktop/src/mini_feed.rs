// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 小窗的只读来源与呈现时钟。
//!
//! 与歌词同源同凭据形态：读发现、读窄钥匙、有界 GET，全部走 `bridge`。
//! 差别只有两点——小窗要多取一张封面，以及它要自己把播放位置往前推。

use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::bridge;
use crate::config::Profile;

/// 小窗协议版本。服务端 discovery 里必须对得上 `desktopMiniProtocol`，
/// 对不上就当来源不支持，不要降级猜字段。
pub(crate) const PROTOCOL: u32 = 1;

/// 封面字节上限。封面是小窗唯一的大块数据，必须和 bridge 的其它响应一样设闸门。
const MAX_COVER_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MiniSnapshot {
    pub(crate) protocol: u32,
    pub(crate) seq: u64,
    pub(crate) server: MiniServer,
    /// 曲目代的标识。换曲或换源都会变，用来重置封面缓存与时钟锚点。
    pub(crate) generation: String,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) playing: bool,
    #[serde(default)]
    pub(crate) buffering: bool,
    #[serde(default)]
    pub(crate) volume: Option<f64>,
    pub(crate) track: Option<MiniTrack>,
    /// 主窗口的可见性回传。小窗靠它决定要不要自动接管，也靠它决定收不收回去。
    #[serde(default)]
    pub(crate) main: MainSurface,
    #[serde(default)]
    pub(crate) timing: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MiniServer {
    pub(crate) session: String,
    pub(crate) edition: String,
    pub(crate) version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MiniTrack {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) artist: Option<String>,
    #[serde(default)]
    pub(crate) album: Option<String>,
    #[serde(default)]
    pub(crate) duration_ms: Option<u64>,
    /// 封面的缓存键。变了才重新拉图，避免每拍一次请求。
    #[serde(default)]
    pub(crate) cover_key: Option<String>,
    #[serde(default)]
    pub(crate) online: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainSurface {
    #[serde(default)]
    pub(crate) visible: bool,
    /// 主窗口上次说「我还可见」到现在过了多少毫秒。用来判定是不是真的被最小化了，
    /// 而不是一次 Alt-Tab 的抖动。
    #[serde(default)]
    pub(crate) since_ms: u64,
}

/// 呈现时钟：两次快照之间靠墙钟往前推。
///
/// 小窗每秒只问服务端两三次，进度条不能按这个频率跳——必须本地插值。
/// 服务端给的 `positionMs` 是「呈现时刻」的位置（与歌词同一语义），
/// 我们把它当锚点，之后自己走。
#[derive(Clone, Copy, Debug)]
pub(crate) struct PresentationClock {
    anchor_ms: u64,
    anchor_at: Instant,
    playing: bool,
    duration_ms: Option<u64>,
    generation: u64,
}

/// 预测值和上报值差多少就重新锚定。小于这个值说明只是网络抖动，
/// 重新锚定反而会让进度条回跳。
const RESYNC_MS: u64 = 1200;

impl Default for PresentationClock {
    fn default() -> Self {
        Self {
            anchor_ms: 0,
            anchor_at: Instant::now(),
            playing: false,
            duration_ms: None,
            generation: 0,
        }
    }
}

impl PresentationClock {
    /// 用一次新快照校正。返回是否重新锚定（用于日志排查「进度条跳」）。
    pub(crate) fn sync(
        &mut self,
        position_ms: u64,
        duration_ms: Option<u64>,
        playing: bool,
        generation: u64,
    ) -> bool {
        let predicted = self.now_ms();
        let drift = position_ms.abs_diff(predicted);
        // 换曲、播放态变化、对不上拍——这三种都必须重锚，插值的前提不成立。
        let forced = generation != self.generation || playing != self.playing || drift > RESYNC_MS;
        self.duration_ms = duration_ms;
        self.generation = generation;
        if forced {
            self.anchor_ms = position_ms;
            self.anchor_at = Instant::now();
            self.playing = playing;
        }
        forced
    }

    /// 当前呈现位置（毫秒）。暂停时锚点不动，天然停在原处。
    pub(crate) fn now_ms(&self) -> u64 {
        if !self.playing {
            return self.anchor_ms;
        }
        let elapsed = self.anchor_at.elapsed().as_millis() as u64;
        let value = self.anchor_ms.saturating_add(elapsed);
        match self.duration_ms {
            Some(duration) if duration > 0 => value.min(duration),
            _ => value,
        }
    }

    pub(crate) fn playing(&self) -> bool {
        self.playing
    }
}

pub(crate) struct MiniFeed {
    client: reqwest::blocking::Client,
    profile: Profile,
    session: Option<String>,
    cover_key: Option<String>,
    clock: PresentationClock,
    generation: u64,
    generation_token: Option<String>,
}

pub(crate) struct MiniUpdate {
    pub(crate) snapshot: MiniSnapshot,
    /// 新封面；没换曲就是 None。
    pub(crate) cover: Option<Vec<u8>>,
}

impl MiniFeed {
    pub(crate) fn new(profile: Profile) -> Result<Self> {
        Ok(Self {
            client: bridge::client()?,
            profile,
            session: None,
            cover_key: None,
            clock: PresentationClock::default(),
            generation: 0,
            generation_token: None,
        })
    }

    pub(crate) fn clock(&self) -> PresentationClock {
        self.clock
    }

    /// 轮询间隔：播着的时候要跟手，暂停和隐藏时要把请求降下来。
    pub(crate) fn poll_interval(&self, visible: bool) -> Duration {
        if !visible {
            Duration::from_secs(5)
        } else if self.clock.playing() {
            Duration::from_millis(500)
        } else {
            Duration::from_secs(2)
        }
    }

    pub(crate) fn poll(&mut self) -> Result<MiniUpdate> {
        let discovery = bridge::read_discovery(&self.profile)?;
        if let Some(edition) = discovery.edition.as_deref() {
            if self.profile.edition != "custom" && edition != self.profile.edition {
                bail!(
                    "数据目录属于 {} 发行版，当前 profile 是 {}",
                    edition,
                    self.profile.edition
                );
            }
        }
        if discovery.desktop_mini_protocol != Some(PROTOCOL) {
            bail!("Hertz 服务版本不支持小窗协议 {PROTOCOL}，请升级服务后重启");
        }
        if self
            .session
            .as_deref()
            .is_some_and(|session| Some(session) != discovery.server_instance_id.as_deref())
        {
            // 换了一次服务实例：封面缓存和代号全部作废。
            self.cover_key = None;
            self.generation_token = None;
        }
        self.session = discovery.server_instance_id.clone();
        // 每拍重读钥匙：删文件重启即可轮换，不需要组件重启（与歌词同源同策略）。
        let key = bridge::read_key(&self.profile.data_dir, "desktop-mini-key", "小窗")?;
        let base = format!("http://127.0.0.1:{}", discovery.port);

        let snapshot: MiniSnapshot = bridge::get_json(
            &self.client,
            &base,
            "/v1/desktop-mini/snapshot",
            "Desktop",
            &key,
        )?;
        if snapshot.protocol != PROTOCOL {
            bail!(
                "服务快照协议 {} 与组件协议 {PROTOCOL} 不一致",
                snapshot.protocol
            );
        }
        if snapshot.timing != "presentation_applied" {
            bail!("服务返回的时间语义不是 presentation_applied");
        }
        if discovery
            .server_instance_id
            .as_deref()
            .is_some_and(|session| session != snapshot.server.session)
        {
            self.cover_key = None;
            bail!("服务会话已变化，等待新快照");
        }

        self.track_generation(&snapshot);
        self.clock.sync(
            snapshot.position_ms,
            snapshot.duration_ms,
            snapshot.playing,
            self.generation,
        );

        let cover = self.fetch_cover(&base, &key, &snapshot)?;
        Ok(MiniUpdate { snapshot, cover })
    }

    /// 把字符串曲目代折成一个自增整数，好让时钟只比数字。
    fn track_generation(&mut self, snapshot: &MiniSnapshot) {
        let token = snapshot.generation.clone();
        if self.generation_token.as_deref() != Some(token.as_str()) {
            self.generation_token = Some(token);
            self.generation = self.generation.wrapping_add(1);
        }
    }

    /// 只在 coverKey 变化时拉图；曲目为空就顺手清掉缓存。
    fn fetch_cover(
        &mut self,
        base: &str,
        key: &str,
        snapshot: &MiniSnapshot,
    ) -> Result<Option<Vec<u8>>> {
        let wanted = snapshot.track.as_ref().and_then(|track| track.cover_key.clone());
        let Some(wanted) = wanted else {
            self.cover_key = None;
            return Ok(None);
        };
        if self.cover_key.as_deref() == Some(wanted.as_str()) {
            return Ok(None);
        }
        if wanted
            .chars()
            .any(|character| !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')))
        {
            self.cover_key = None;
            return Ok(None);
        }
        let response = self
            .client
            .get(format!("{base}/v1/desktop-mini/cover?key={wanted}"))
            .header("Authorization", format!("Desktop {key}"))
            .send()
            .context("拉取小窗封面失败")?;
        if !response.status().is_success() {
            self.cover_key = None;
            return Ok(None);
        }
        let bytes = response.bytes().context("读取小窗封面")?;
        if bytes.len() > MAX_COVER_BYTES {
            self.cover_key = None;
            return Ok(None);
        }
        self.cover_key = Some(wanted);
        Ok(Some(bytes.to_vec()))
    }

    /// 小窗上的播控。走窄口，凭据不离开本机（与歌词播控同一形态）。
    pub(crate) fn control(&self, payload: &serde_json::Value) -> Result<()> {
        let discovery = bridge::read_discovery(&self.profile)?;
        if discovery.desktop_mini_protocol != Some(PROTOCOL)
            || discovery.edition.as_deref() != Some(self.profile.edition.as_str())
            || discovery.server_instance_id.as_deref() != payload["session"].as_str()
        {
            bail!("播放来源已变化，请等待重新同步");
        }
        let key = bridge::read_key(&self.profile.data_dir, "desktop-mini-key", "小窗")?;
        let response = bridge::client()?
            .post(format!(
                "http://127.0.0.1:{}/v1/desktop-mini/control",
                discovery.port
            ))
            .header("Authorization", format!("Desktop {key}"))
            .json(payload)
            .send()?;
        if !response.status().is_success() {
            bail!("小窗播控返回 {}", response.status());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_advances_only_while_playing() {
        let mut clock = PresentationClock::default();
        clock.sync(1000, Some(30_000), true, 1);
        let first = clock.now_ms();
        std::thread::sleep(Duration::from_millis(30));
        assert!(clock.now_ms() >= first);
        clock.sync(2000, Some(30_000), false, 1);
        let paused = clock.now_ms();
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(clock.now_ms(), paused);
    }

    #[test]
    fn clock_clamps_to_duration() {
        let mut clock = PresentationClock::default();
        clock.sync(29_900, Some(30_000), true, 1);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(clock.now_ms(), 30_000);
    }

    #[test]
    fn small_drift_does_not_reanchor() {
        let mut clock = PresentationClock::default();
        clock.sync(10_000, Some(60_000), true, 1);
        // 上报值只差 300ms：判定为抖动，不重锚（重锚会让进度条回跳）。
        assert!(!clock.sync(10_300, Some(60_000), true, 1));
        // 差 3 秒：真跳了（seek 或换源），必须重锚。
        assert!(clock.sync(13_000, Some(60_000), true, 1));
    }

    #[test]
    fn switching_track_forces_reanchor() {
        let mut clock = PresentationClock::default();
        clock.sync(5_000, Some(60_000), true, 1);
        // 代号变化：即使上报位置和预测值一样也要重锚，因为很可能刚好同位置换曲。
        assert!(clock.sync(5_000, Some(60_000), true, 2));
    }

    #[test]
    fn poll_interval_relaxes_when_idle_or_hidden() {
        let mut feed = MiniFeed::new(Profile {
            data_dir: std::path::PathBuf::from("C:\\d"),
            edition: "full".into(),
        })
        .expect("feed");
        assert_eq!(feed.poll_interval(false), Duration::from_secs(5));
        assert_eq!(feed.poll_interval(true), Duration::from_secs(2));
        feed.clock.sync(0, None, true, 1);
        assert_eq!(feed.poll_interval(true), Duration::from_millis(500));
    }
}
