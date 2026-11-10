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
//! 采集与分析由共享 owner 按实际运行消费者启停）。

#[allow(dead_code)] // replace 由 P1-05 TargetPlanner 接入；当前生产默认空集合。
pub(crate) mod access;
pub(crate) mod ai;

// P1-02/P1-04/P1-06 内核在本包内自测；接线到 app/管理协议属 P1-05（§20.2 依赖链
// 01→02→03/04→05），接线后移除 dead_code 放行。
#[allow(dead_code)]
pub(crate) mod api;
#[allow(dead_code)]
pub(crate) mod assets;
#[allow(dead_code)]
pub(crate) mod audio;
#[allow(dead_code)]
pub(crate) mod audio_capture;
pub(crate) mod audio_devices;
pub(crate) mod audio_service;
#[allow(dead_code)]
pub(crate) mod budget;
pub(crate) mod builtin_plan;
pub(crate) mod composition_plan;
#[allow(dead_code)]
pub(crate) mod config;
#[allow(dead_code)] // AssetStore 的持久内容计量与单写者发布。
pub(crate) mod content_quota;
#[allow(dead_code)] // ImportJobs 的产品管理入口随 P1-05 接入。
pub(crate) mod decode_probe;
#[allow(dead_code)] // AssetStore 派生缓存的发布/回收与原生目录租约。
pub(crate) mod derived_cache;
#[allow(dead_code)] // Display topology and group clocks are wired by the native target coordinator.
pub(crate) mod display;
pub(crate) mod export_jobs;
#[allow(dead_code)]
pub(crate) mod file_tokens;
pub(crate) mod follow;
#[allow(dead_code)] // Font facts remain behind native qualification and the composition gate.
pub(crate) mod font_prepare;
pub(crate) mod frame_window;
pub(crate) mod gl_plan;
#[allow(dead_code)] // Native group playback coordinates mirrored target lifecycles.
pub(crate) mod group_playback;
pub(crate) mod handoff;
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
pub(crate) mod output_tokens;
pub(crate) mod page_events;
pub(crate) mod playlist;
pub(crate) mod policy;
#[allow(dead_code)]
pub(crate) mod probe_environment;
pub(crate) mod public_properties;
#[allow(dead_code)] // 本机环境资格，不授予文件或会话访问权限。
pub(crate) mod qualification;
pub(crate) mod raw_import;
pub(crate) mod references;
#[allow(dead_code)] // app 接入真实媒体会话时消费的后台选择入口。
pub(crate) mod selection_plan;
#[allow(dead_code)]
pub(crate) mod service;
#[allow(dead_code)] // 内置 app 已接四事实；媒体交接/恢复与多资源编排继续接线。
pub(crate) mod session;
pub(crate) mod settings_drafts;
pub(crate) mod svg_prepare;
#[allow(dead_code)] // 原生目标规划内核；正式选择入口随 P1-05 接入。
pub(crate) mod target_planner;
#[allow(dead_code)] // Pure raster facts await the original composition projection owner.
pub(crate) mod text_raster;
pub(crate) mod video_poster;
pub(crate) mod webresource;
pub(crate) mod work_drafts;
pub(crate) mod worker;
