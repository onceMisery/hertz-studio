// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 在线「用户歌单」CRUD 的跨源公共样板（设计文档 P2-6 / M4）。
//!
//! 三个写歌单的音源（网易云 / QQ / 酷狗）在新建/删除/加曲/移除里各自重写了
//! 同一套入参校验与成功回包构造，且错误文案必须逐字一致（前端按文案展示、
//! 测试按文案断言）。把这几段收敛到这里，避免三份拷贝各自漂移；平台特有的
//! 表单字段、签名与端点差异仍留在各源内部，不放进来。

use std::collections::BTreeMap;

use super::{bad_request, ApiResult, OnlinePlaylist, TrackEntry};

/// 歌单名非空校验（trim 后），返回 trim 结果。三源新建歌单共用。
pub(super) fn require_playlist_name(name: &str) -> ApiResult<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(bad_request("缺少歌单名称"));
    }
    Ok(name)
}

/// 写歌单的曲目列表非空校验。`verb` 取「加入」/「移除」，拼出与各源原样一致的
/// 错误文案（`没有要加入的曲目` / `没有要移除的曲目`）。
pub(super) fn require_tracks(tracks: &[TrackEntry], verb: &str) -> ApiResult<()> {
    if tracks.is_empty() {
        return Err(bad_request(format!("没有要{verb}的曲目")));
    }
    Ok(())
}

/// 新建歌单的成功回包：平台只给 id 与 name，其余字段取结构默认值（封面/曲目数/
/// 创建者等留空），kind 固定 created。三源共用，默认值改动只会影响一处。
pub(super) fn created_playlist(source: &str, id: String, name: &str) -> OnlinePlaylist {
    OnlinePlaylist {
        source: source.to_string(),
        id,
        name: name.to_string(),
        kind: "created".into(),
        ..Default::default()
    }
}

/// 由键值对构造表单/查询参数表（BTreeMap，键有序，编码结果稳定）。网易云与
/// 酷狗的歌单接口都手写这段 `BTreeMap::new()` + 逐键 `insert` 的样板。
pub(super) fn form_map(fields: &[(&str, &str)]) -> BTreeMap<String, String> {
    fields
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}