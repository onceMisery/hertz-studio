// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 与传输无关的 JSON 门面。
//!
//! DBX 插件的 sidecar 把 UI 的 `invoke(method, params)` 翻译成这里的 [`Rpc::call`]。
//! method 名就是原来的 HTTP path 去掉前导斜杠（`v1/player/play`），信封里带
//! `op`（原 HTTP 动词）、`query`、`body`，所以端点是机械平移，`routes.rs` 里的
//! handler 逻辑可以照抄。唯一的例外是二进制：`raw_base64` / `raw_content_type`
//! 两个字段承载裸字节，见 [`RawBody`]。
//!
//! 这一层既不认识 axum 也不认识 dbx-plugin-sdk：进来是 JSON，出去是
//! `Result<Reply, ApiError>`，两端各自适配。之所以放在本 crate 内部而不是
//! `plugin/backend`，是因为 `AppState` 有一批 `pub(crate)` 字段（`radio`、
//! `online_meta`、`downloads`、`quality`、`keep`、`protected`），外部 crate 碰不到。
//!
//! # 路由表为什么用 slice pattern
//!
//! `match (op, segments.as_slice())` 配 `["v1", "tracks", id]` 这样的模式，路径
//! 参数直接绑定成变量，不需要额外的匹配器，也不会有"模式写重了导致后面的分支
//! 永远走不到"这类只有运行期才暴露的问题——编译器会按顺序取第一个匹配，和
//! axum 的路由优先级一样直观。
//!
//! # 错误为什么不走 JSON-RPC error
//!
//! 宿主解码 sidecar 响应时只保留 `error.message`，`code` 和 `data` 会被丢掉
//! （dbx `crates/dbx-plugin-runtime/src/plugins/runtime.rs` 的
//! `decode_response_value`）。而前端契约要求错误体带稳定的机器码、request_id、
//! 音源 id 和 HTTP 状态。所以域错误一律以**成功结果**的形式返回，由 sidecar
//! 包成 `{status, body}`，`body` 就是原来那个 `{"error":{...}}`。协议级错误
//! （方法不存在、信封非法）才用真正的 JSON-RPC error。

pub mod library;
pub mod maintenance;
pub mod online;
pub mod playback;
pub mod playlists;
pub mod recommend;
pub mod remote;

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use vmusic_core::PROTOCOL_VERSION;

use crate::error::{bad_request, not_found, ApiError};
use crate::state::AppState;

/// 原 HTTP 动词。同一路径可能同时挂 GET 和另一个动词（例如 `/v1/player/dsp`
/// 是 GET|POST、`/v1/player/queue` 是 GET|PUT），所以必须随信封一起传进来，
/// 不能只靠 path 区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Get,
    Post,
    Put,
    Delete,
}

impl Op {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_uppercase().as_str() {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            "PUT" => Some(Self::Put),
            "DELETE" => Some(Self::Delete),
            _ => None,
        }
    }
}

/// 一次调用的全部入参。`path` 已经去掉前导斜杠，路径参数（`{id}`）还是原样的
/// 具体值，由路由表按段匹配后提取。
pub struct Call<'a> {
    pub op: Op,
    pub path: &'a str,
    pub query: Value,
    pub body: Value,
    /// 二进制请求体，见 [`RawBody`]。
    pub raw: Option<RawBody>,
}

/// 二进制请求体。
///
/// HTTP 版的封面替换把图片字节直接当 body、`Content-Type` 决定落盘扩展名；
/// JSON 信封装不下裸字节，所以改成 base64 + 单独的媒体类型字段。目前只有
/// `POST v1/tracks/{id}/cover` 一个端点用它。
pub struct RawBody {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// 信封与字节之间唯一的翻译点：封面读取用 `encode`（出），封面替换用
/// `decode`（入）。用标准字母表，与前端 `dbxPlugin.encodeBase64` 一致。
pub fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn decode_base64(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(text)
}

/// 一次调用的应答，与 HTTP 响应同构。
///
/// 允许自定义状态码与体，是因为有几个端点的应答不是标准形状：`stage/beatmap`
/// 的 202/404 体是 `{status, reason}`，返回 204 的端点体为空。这些都不能塞进
/// `ApiError`——那是错误通道，形状固定为 `{"error":{...}}`。
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    pub fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    /// 204：前端 `request()` 对 204 返回 null，所以体是 Null 而不是缺省。
    pub fn no_content() -> Self {
        Self {
            status: 204,
            body: Value::Null,
        }
    }

    pub fn with_status(status: u16, body: Value) -> Self {
        Self { status, body }
    }

    /// 序列化任意 `Serialize` 值作为 200 应答。HTTP 版的 handler 直接
    /// `Json(dto)`，RPC 这边得过一道 `to_value`，收在这里省得每个域各写一遍。
    pub fn json<T: serde::Serialize>(value: &T) -> Result<Self, ApiError> {
        Ok(Self::ok(
            serde_json::to_value(value).map_err(|e| crate::error::internal(e.to_string()))?,
        ))
    }
}

pub type RpcResult = Result<Reply, ApiError>;

/// 反序列化信封里的请求体。缺体按 Null 处理，交给 serde 报缺字段——
/// 错误消息与 HTTP 版 `Json(body)` 抽取器失败时同源。
pub fn body_as<T: DeserializeOwned>(body: &Value) -> Result<T, ApiError> {
    serde_json::from_value(body.clone()).map_err(|e| bad_request(format!("请求体不合法: {e}")))
}

/// 把信封里的 `query` 还原成 URL 查询串，再按 axum 的同一条路反序列化。
///
/// axum 的 `Query<T>` 就是 `serde_urlencoded::from_str`。走同一个编解码器，两个
/// 宿主的取参语义才是**逐字**一致的：`#[serde(default)]` 何时生效、缺字段是 400
/// 还是走默认、`usize` 遇到负数怎么办——这些边界一个都不用在这里复刻。手写「按
/// 字符串读出来再 parse」的话，每一处都是一条只在插件形态下出现的分叉。
///
/// 只支持扁平标量参数，这不是额外限制：HTTP 侧的 `Query<T>` 同样反序列化不了
/// 嵌套结构。
pub fn query_as<T: DeserializeOwned>(query: &Value) -> Result<T, ApiError> {
    let invalid = |e: String| bad_request(format!("查询参数不合法: {e}"));
    let encoded = match query {
        Value::Null => String::new(),
        Value::Object(_) => {
            serde_urlencoded::to_string(query).map_err(|e| invalid(e.to_string()))?
        }
        _ => return Err(invalid("query 必须是对象".into())),
    };
    serde_urlencoded::from_str(&encoded).map_err(|e| invalid(e.to_string()))
}

/// 按名字取一个字符串查询参数。
///
/// 只给 HTTP 侧用 `Query<HashMap<String, String>>` 抽取的那两个端点用
/// （`tracks/facets` 的 kind、`remote/roots/{id}/browse` 的 path）——那边本来就是
/// 按名字查表，没有结构体可反序列化。其余一律走 [`query_as`]。
pub fn query_str<'a>(query: &'a Value, key: &str) -> Option<&'a str> {
    match query.get(key)? {
        Value::String(text) => Some(text),
        _ => None,
    }
}

pub struct Rpc {
    state: Arc<AppState>,
}

impl Rpc {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    pub fn state(&self) -> Arc<AppState> {
        self.state.clone()
    }

    pub async fn call(&self, call: Call<'_>) -> RpcResult {
        let segments: Vec<&str> = call.path.split('/').filter(|s| !s.is_empty()).collect();
        let state = &self.state;
        let query = &call.query;
        let body = &call.body;
        let raw = call.raw.as_ref();

        match (call.op, segments.as_slice()) {
            // --- 元信息 / 状态 ---
            (Op::Get, ["v1", "health"]) => Ok(Reply::ok(self.health())),
            (Op::Get, ["v1", "state"]) => Ok(Reply::ok(playback::snapshot(state).await)),

            // --- 播放控制 ---
            (Op::Post, ["v1", "player", "load"]) => playback::load(state, body).await,
            (Op::Post, ["v1", "player", "play"]) => playback::play(state).await,
            (Op::Post, ["v1", "player", "pause"]) => playback::pause(state).await,
            (Op::Post, ["v1", "player", "stop"]) => playback::stop(state).await,
            (Op::Post, ["v1", "player", "next"]) => playback::next(state).await,
            (Op::Post, ["v1", "player", "previous"]) => playback::previous(state).await,
            (Op::Post, ["v1", "player", "seek"]) => playback::seek(state, body).await,
            (Op::Post, ["v1", "player", "volume"]) => playback::volume(state, body).await,
            (Op::Post, ["v1", "player", "mode"]) => playback::mode(state, body).await,
            (Op::Post, ["v1", "player", "replay"]) => playback::replay(state, body).await,
            (Op::Get, ["v1", "player", "queue"]) => playback::get_queue(state).await,
            (Op::Put, ["v1", "player", "queue"]) => playback::set_queue(state, body).await,
            (Op::Get, ["v1", "player", "dsp"]) => playback::get_dsp(state).await,
            (Op::Post, ["v1", "player", "dsp"]) => playback::set_dsp(state, body).await,

            // --- 音频设备 ---
            (Op::Get, ["v1", "devices"]) => playback::devices(state).await,
            (Op::Post, ["v1", "devices", "select"]) => playback::select_device(state, body).await,

            // --- 舞台节拍图 ---
            (Op::Get, ["v1", "stage", "beatmap"]) => playback::beatmap(state, query).await,

            // --- OBS 歌词输出 ---
            (Op::Get, ["v1", "overlay", "lyric"]) => playback::overlay_lyric(state).await,

            // --- 曲库：曲目 ---
            // 字面段必须排在 `id` 通配之前：`["v1","tracks",id]` 同样能匹配
            // `/v1/tracks/ids`，顺序反了就是「查无此曲 ids」而不是曲目 id 列表。
            // axum 是按静态段优先自动排序的，slice pattern 只按书写顺序，这一处
            // 得自己守住。
            (Op::Get, ["v1", "tracks"]) => library::list_tracks(state, query).await,
            (Op::Get, ["v1", "tracks", "ids"]) => library::list_track_ids(state, query).await,
            (Op::Get, ["v1", "tracks", "facets"]) => library::track_facets(state, query).await,
            (Op::Post, ["v1", "tracks", "batch-edit"]) => {
                library::batch_edit_tracks(state, body).await
            }
            (Op::Post, ["v1", "tracks", "batch-delete"]) => {
                library::batch_delete_tracks(state, body).await
            }
            // 本地歌曲在线补全：逻辑在 complete.rs，HTTP 与 RPC 同一份。
            // 候选只读、落地单曲，两个 op 与 HTTP 两条路由一一对应。
            (Op::Post, ["v1", "tracks", "complete", "suggest"]) => {
                let request: crate::complete::SuggestRequest = body_as(body)?;
                crate::complete::suggest_tracks(state, &request)
                    .await
                    .map(Reply::ok)
            }
            (Op::Post, ["v1", "tracks", "complete", "apply"]) => {
                let request: crate::complete::ApplyRequest = body_as(body)?;
                crate::complete::apply_choice(state, &request)
                    .await
                    .map(Reply::ok)
            }
            (Op::Get, ["v1", "tracks", "missing"]) => library::list_missing_tracks(state).await,
            (Op::Get, ["v1", "tracks", id]) => library::get_track(state, id).await,
            (Op::Get, ["v1", "tracks", id, "cover"]) => library::get_cover(state, id).await,
            (Op::Post, ["v1", "tracks", id, "cover"]) => {
                library::replace_cover(state, id, raw).await
            }
            (Op::Get, ["v1", "tracks", id, "edit"]) => library::get_track_edit(state, id).await,
            (Op::Delete, ["v1", "tracks", id, "edit"]) => {
                library::clear_track_edit(state, id).await
            }
            (Op::Get, ["v1", "tracks", id, "lyrics"]) => library::get_lyrics(state, id).await,
            (Op::Put, ["v1", "tracks", id, "lyrics"]) => {
                library::import_lyrics(state, id, body).await
            }
            (Op::Delete, ["v1", "tracks", id, "lyrics"]) => library::clear_lyrics(state, id).await,
            (Op::Put, ["v1", "tracks", id, "lyrics", "offset"]) => {
                library::set_lyrics_offset(state, id, body).await
            }

            // --- 曲库：扫描根目录与进度 ---
            (Op::Get, ["v1", "library", "roots"]) => library::library_roots(state).await,
            (Op::Post, ["v1", "library", "roots"]) => library::add_library_root(state, body).await,
            (Op::Put, ["v1", "library", "roots"]) => {
                library::update_library_root(state, body).await
            }
            // 入参在 query 上（`?path=…`），与 HTTP 版的 Query 抽取器同口径。
            (Op::Delete, ["v1", "library", "roots"]) => {
                library::remove_library_root(state, query).await
            }
            (Op::Post, ["v1", "library", "scan"]) => library::start_scan(state, body).await,
            (Op::Post, ["v1", "library", "scan", "cancel"]) => library::cancel_scan(state).await,
            (Op::Get, ["v1", "library", "status"]) => library::scan_status(state).await,

            // --- 设置 ---
            (Op::Get, ["v1", "settings"]) => library::get_settings(state).await,
            (Op::Put, ["v1", "settings"]) => library::put_settings(state, body).await,

            // --- 收藏 ---
            (Op::Get, ["v1", "favorites"]) => library::list_favorites(state, query).await,
            (Op::Post, ["v1", "favorites"]) => library::add_favorite(state, body).await,
            (Op::Post, ["v1", "favorites", "membership"]) => {
                library::favorite_membership(state, body).await
            }
            (Op::Post, ["v1", "favorites", "toggle"]) => {
                library::toggle_favorite(state, body).await
            }
            (Op::Delete, ["v1", "favorites", id]) => library::remove_favorite(state, id).await,

            // --- 播放历史 ---
            (Op::Get, ["v1", "history"]) => library::history_list(state, query).await,
            (Op::Delete, ["v1", "history"]) => library::history_clear(state).await,
            (Op::Delete, ["v1", "history", id]) => library::history_remove(state, id).await,

            // --- 歌单 ---
            // 同样地，字面段 `import-m3u` 要排在 `id` 通配之前。
            (Op::Get, ["v1", "playlists"]) => playlists::list_playlists(state).await,
            (Op::Post, ["v1", "playlists"]) => playlists::create_playlist(state, body).await,
            (Op::Post, ["v1", "playlists", "import-m3u"]) => {
                playlists::import_m3u(state, body).await
            }
            (Op::Get, ["v1", "playlists", _]) => playlists::noop().await,
            (Op::Put, ["v1", "playlists", id]) => playlists::rename_playlist(state, id, body).await,
            (Op::Delete, ["v1", "playlists", id]) => playlists::delete_playlist(state, id).await,
            (Op::Get, ["v1", "playlists", id, "m3u"]) => playlists::export_m3u(state, id).await,
            (Op::Get, ["v1", "playlists", id, "tracks"]) => {
                playlists::get_playlist_tracks(state, id).await
            }
            (Op::Post, ["v1", "playlists", id, "tracks"]) => {
                playlists::add_to_playlist(state, id, body).await
            }
            (Op::Put, ["v1", "playlists", id, "tracks", "order"]) => {
                playlists::reorder_playlist_tracks(state, id, body).await
            }
            (Op::Delete, ["v1", "playlists", id, "tracks", track]) => {
                playlists::remove_from_playlist(state, id, track).await
            }

            // --- 备份 ---
            (Op::Get, ["v1", "backup"]) => maintenance::export_backup(state).await,
            (Op::Post, ["v1", "backup", "restore"]) => {
                maintenance::restore_backup(state, body).await
            }

            // --- 开发者选项：播放诊断日志 ---
            (Op::Get, ["v1", "diagnostics"]) => maintenance::get_diagnostics().await,
            (Op::Post, ["v1", "diagnostics"]) => maintenance::set_diagnostics(state, body).await,
            (Op::Get, ["v1", "diagnostics", "log"]) => maintenance::download_log().await,
            (Op::Delete, ["v1", "diagnostics", "log"]) => maintenance::clear_log().await,

            // --- 每日推荐 ---
            (Op::Get, ["v1", "recommend", "daily"]) => {
                recommend::daily_recommend(state, query).await
            }
            (Op::Get, ["v1", "recommend", "daily", "online"]) => {
                recommend::daily_online_recommend(state, query).await
            }

            // --- 在线曲库（代理）---
            // 这一域全是字面段、没有路径参数，所以不存在 tracks / playlists 那种
            // 「字面段必须排在 {id} 通配之前」的顺序陷阱。
            (Op::Get, ["v1", "online", "sources"]) => online::sources(state).await,
            (Op::Get, ["v1", "online", "search"]) => online::search(state, query).await,
            (Op::Get, ["v1", "online", "search", "all"]) => online::search_all(state, query).await,
            (Op::Get, ["v1", "online", "stream"]) => online::stream(state, query).await,
            (Op::Get, ["v1", "online", "detail"]) => online::detail(state, query).await,
            (Op::Get, ["v1", "online", "lyric"]) => online::lyric(state, query).await,
            (Op::Get, ["v1", "online", "cover"]) => online::cover_proxy(state, query).await,
            (Op::Post, ["v1", "ui", "notice"]) => {
                let req: crate::routes::UiNoticeRequest = body_as(body)?;
                crate::routes::broadcast_ui_notice(state, &req.action).await?;
                Ok(Reply::ok(serde_json::json!({ "ok": true })))
            }
            (Op::Post, ["v1", "online", "play"]) => online::play(state, body).await,
            (Op::Get, ["v1", "online", "radio"]) => online::radio_status(state).await,
            (Op::Post, ["v1", "online", "radio"]) => online::radio(state, body).await,
            (Op::Get, ["v1", "online", "cache"]) => online::cache_stats(state).await,
            (Op::Post, ["v1", "online", "cache", "limit"]) => {
                online::cache_limit(state, body).await
            }
            (Op::Post, ["v1", "online", "cache", "clear"]) => {
                online::cache_clear(state, body).await
            }
            (Op::Post, ["v1", "online", "cache", "keep"]) => online::cache_keep(state, body).await,
            (Op::Get, ["v1", "online", "quality"]) => online::quality_get(state).await,
            (Op::Post, ["v1", "online", "quality"]) => online::quality_set(state, body).await,
            (Op::Post, ["v1", "online", "cookie"]) => online::cookie(state, body).await,
            (Op::Get, ["v1", "online", "playlists"]) => online::playlists(state, query).await,
            (Op::Get, ["v1", "online", "playlist"]) => online::playlist(state, query).await,
            (Op::Post, ["v1", "online", "playlist"]) => online::playlist_create(state, body).await,
            // 这两个 DELETE/POST 带 JSON body，而两个宿主的 transport.del() 都不
            // 发 body——前端也从未调用它们，保留只为与 HTTP 路由表一一对应。
            (Op::Delete, ["v1", "online", "playlist"]) => {
                online::playlist_delete(state, body).await
            }
            (Op::Post, ["v1", "online", "playlist", "tracks", "add"]) => {
                online::playlist_add(state, body).await
            }
            (Op::Post, ["v1", "online", "playlist", "tracks", "remove"]) => {
                online::playlist_remove(state, body).await
            }
            (Op::Post, ["v1", "online", "like"]) => online::like(state, body).await,
            (Op::Get, ["v1", "online", "recommend", "songs"]) => {
                online::rec_songs(state, query).await
            }
            (Op::Get, ["v1", "online", "recommend", "playlists"]) => {
                online::rec_playlists(state, query).await
            }
            (Op::Post, ["v1", "online", "qr", "start"]) => online::qr_start(state, body).await,
            (Op::Get, ["v1", "online", "qr", "poll"]) => online::qr_poll(state, query).await,
            (Op::Post, ["v1", "online", "qr", "cancel"]) => online::qr_cancel(state, body).await,
            (Op::Get, ["v1", "online", "account"]) => online::account(state, query).await,

            // --- 远程来源（WebDAV）---
            (Op::Get, ["v1", "remote", "roots"]) => remote::list_roots(state).await,
            (Op::Post, ["v1", "remote", "roots"]) => remote::add_root(state, body).await,
            (Op::Delete, ["v1", "remote", "roots", id]) => remote::delete_root(state, id).await,
            (Op::Get, ["v1", "remote", "roots", id, "browse"]) => {
                remote::browse_root(state, id, query).await
            }
            (Op::Post, ["v1", "remote", "roots", id, "import"]) => {
                remote::import_files(state, id, body).await
            }

            _ => Err(not_found(format!(
                "no such method: {} {:?}",
                call.path, call.op
            ))),
        }
    }

    fn health(&self) -> Value {
        json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol_version": PROTOCOL_VERSION,
            // 快照里没有后端名，从 config 读，口径与 HTTP 版一致。
            "backend": self.state.config.audio.backend,
            // 让前端能区分自己跑在哪个宿主上：独立版是 http，插件是 dbx。
            "host": "dbx",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_parsing_is_case_insensitive_and_rejects_unknown_verbs() {
        assert_eq!(Op::parse("get"), Some(Op::Get));
        assert_eq!(Op::parse("POST"), Some(Op::Post));
        assert_eq!(Op::parse("Put"), Some(Op::Put));
        assert_eq!(Op::parse("DELETE"), Some(Op::Delete));
        assert_eq!(Op::parse("PATCH"), None);
        assert_eq!(Op::parse(""), None);
    }

    #[test]
    fn query_str_reads_only_string_values() {
        let query = json!({ "kind": "artist", "n": 5 });
        assert_eq!(query_str(&query, "kind"), Some("artist"));
        // 非字符串与缺键都是 None，让调用方走自己的默认值。
        assert_eq!(query_str(&query, "n"), None);
        assert_eq!(query_str(&query, "missing"), None);
    }

    #[test]
    fn reply_status_codes_carry_through() {
        assert_eq!(Reply::ok(json!({})).status, 200);
        // 204 的体必须是 Null：前端 request() 对 204 返回 null。
        assert_eq!(Reply::no_content().status, 204);
        assert!(Reply::no_content().body.is_null());
        assert_eq!(
            Reply::with_status(202, json!({"status":"analyzing"})).status,
            202
        );
    }

    #[derive(serde::Deserialize, Debug, PartialEq)]
    struct ProbeQuery {
        source: String,
        #[serde(default)]
        offset: usize,
        #[serde(default = "probe_default_limit")]
        limit: usize,
    }

    fn probe_default_limit() -> usize {
        30
    }

    #[derive(serde::Deserialize, Debug, PartialEq)]
    struct AllOptional {
        #[serde(default)]
        q: Option<String>,
    }

    /// `query_as` 的全部意义就在于与 axum 的 `Query<T>` 逐字同义，所以这些边界
    /// 要钉住：它们是手写「按字符串读再 parse」最容易分叉的地方。
    #[test]
    fn query_as_matches_axum_query_semantics() {
        // UI 侧 URLSearchParams 出来的值天然是字符串，必须能落进 usize。
        let q =
            query_as::<ProbeQuery>(&json!({ "source": "netease", "limit": "20", "offset": "5" }))
                .unwrap();
        assert_eq!(
            q,
            ProbeQuery {
                source: "netease".into(),
                offset: 5,
                limit: 20
            }
        );
        // JSON 数字也接受：sidecar 之间互调时不必先转成字符串。
        assert_eq!(
            query_as::<ProbeQuery>(&json!({ "source": "x", "limit": 7 }))
                .unwrap()
                .limit,
            7
        );
        // #[serde(default)] 与自定义默认值都要生效。
        assert_eq!(
            query_as::<ProbeQuery>(&json!({ "source": "qq" })).unwrap(),
            ProbeQuery {
                source: "qq".into(),
                offset: 0,
                limit: 30
            }
        );
        // 缺必填字段与「负数落不进 usize」都是 400，与 axum 抽取失败同口径——
        // 不是静默走默认值。
        assert_eq!(query_as::<ProbeQuery>(&json!({})).unwrap_err().status, 400);
        assert_eq!(
            query_as::<ProbeQuery>(&json!({ "source": "x", "limit": "-1" }))
                .unwrap_err()
                .status,
            400
        );
    }

    #[test]
    fn absent_or_empty_query_yields_defaults() {
        assert_eq!(
            query_as::<AllOptional>(&Value::Null).unwrap(),
            AllOptional { q: None }
        );
        assert_eq!(
            query_as::<AllOptional>(&json!({})).unwrap(),
            AllOptional { q: None }
        );
        // 非对象的 query 是信封非法，不该被当成「没有参数」。
        assert_eq!(
            query_as::<AllOptional>(&json!("nope")).unwrap_err().status,
            400
        );
    }
}
