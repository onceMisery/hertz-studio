// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸运行底座。
//! P0：策略（policy，§20.1 P0-03）。
//! P1-02：本地库与任务（library/assets/jobs，§20.2）——staging→安装事务、
//! 崩溃恢复与单槽导入；会话/预算/媒体（session/budget/media）随对应包创建。

// P1-02 内核在本包内自测；接线到 app/管理协议属 P1-05（§20.2 依赖链 01→02→05），
// 接线后移除 dead_code 放行。
#[allow(dead_code)]
pub(crate) mod assets;
#[allow(dead_code)]
pub(crate) mod jobs;
#[allow(dead_code)]
pub(crate) mod media;
#[allow(dead_code)]
pub(crate) mod media_stream;
pub(crate) mod webresource;
#[allow(dead_code)]
pub(crate) mod istream;
#[allow(dead_code)]
pub(crate) mod library;
pub(crate) mod policy;
