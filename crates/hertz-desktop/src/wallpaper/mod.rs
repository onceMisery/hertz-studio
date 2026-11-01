// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸运行底座。
//! P0：策略（policy，§20.1 P0-03）。
//! P1-02：本地库与任务（library/assets/jobs，§20.2）——staging→安装事务、
//! 崩溃恢复与单槽导入。
//! P1-03：媒体路径与 decode_probe——容器/PNG 像素验证、独立 WebView2 解码
//! 准入、Range 流内核、保留域拦截与页面轻后端。
//! P1-04：预算账本（budget，§12.1/§12.3）与会话状态机（session，§13.3）。
//! P1-06：系统音频分析管线与输入 owner（audio，§11.3；WASAPI loopback
//! 采集线程随下一片接线）。

#[allow(dead_code)] // replace 由 P1-05 TargetPlanner 接入；当前生产默认空集合。
pub(crate) mod access;

// P1-02/P1-04/P1-06 内核在本包内自测；接线到 app/管理协议属 P1-05（§20.2 依赖链
// 01→02→03/04→05），接线后移除 dead_code 放行。
#[allow(dead_code)]
pub(crate) mod assets;
#[allow(dead_code)]
pub(crate) mod audio;
#[allow(dead_code)]
pub(crate) mod audio_capture;
#[allow(dead_code)]
pub(crate) mod budget;
#[allow(dead_code)] // ImportJobs 的产品管理入口随 P1-05 接入。
pub(crate) mod decode_probe;
#[allow(dead_code)] // 派生描述符供后续 TargetPlanner 消费。
pub(crate) mod image_prepare;
#[allow(dead_code)]
pub(crate) mod istream;
#[allow(dead_code)]
pub(crate) mod jobs;
#[allow(dead_code)]
pub(crate) mod library;
#[allow(dead_code)]
pub(crate) mod media;
#[allow(dead_code)]
pub(crate) mod media_stream;
pub(crate) mod policy;
#[allow(dead_code)]
pub(crate) mod session;
pub(crate) mod webresource;
