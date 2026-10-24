// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 页面观众计数与离场暂停。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::{AppState, DEPART_GRACE};

/// 「还开着几个页面」的唯一出处：一条 `/ws` 连接进 `handle_socket` 时 +1，任何
/// 出口（早退、发送失败、panic 展开）由 Drop 收回。不用 `events.receiver_count()`
/// 是因为集合补页、AI 任务、电台取数这些内部等待者订阅的是同一条总线，那个数
/// 答不出「有没有浏览器开着」。
pub(crate) struct ViewerGuard {
    state: Arc<AppState>,
}

impl ViewerGuard {
    pub(crate) fn enter(state: Arc<AppState>) -> Self {
        state.viewers.fetch_add(1, Ordering::AcqRel);
        Self { state }
    }
}

impl Drop for ViewerGuard {
    fn drop(&mut self) {
        self.state.viewers.fetch_sub(1, Ordering::AcqRel);
        // 断开本身就武装一次，不靠前端的信标：实测关掉整个浏览器时
        // `fetch(keepalive)` 请求根本发不出去（Chromium 抢先撕掉网络栈），
        // 只认 `/v1/player/depart` 的话「关浏览器还在放」照旧成立。信标覆盖的是
        // 主动调用与单标签关闭，这条兜住崩溃、进程被杀与整浏览器退出。
        self.state.schedule_depart_pause();
    }
}

impl AppState {
    /// 页面离场的收尾：宽限期到点后，只有「没有页面开着」且「确实还在出声」两个
    /// 条件同时成立才暂停。武装点有两处——前端的 `pagehide` 信标（`/v1/player/depart`）
    /// 与最后一条 `/ws` 断开（[`ViewerGuard::drop`]），后者是关整个浏览器时唯一可能
    /// 生效的那条，因为信标在那种退出里发不出去。
    ///
    /// 宽限期存在的理由是 `pagehide` 与 WS 断开在按 F5 时同样发生：实测本机重载
    /// → 重连 257–675 ms，立即暂停等于每刷一次停一次。重复武装（两个标签先后关、
    /// 信标与断开各一次）无害——判定只看当下的观看者数，多个任务只是把同一件事
    /// 确认多次。停的是 pause 不是 stop：游标与进度留着，重开页面点播放能接回原处
    /// （`pending_restore_seek` 那条恢复路）。
    pub(crate) fn schedule_depart_pause(self: &Arc<Self>) {
        let Some(state) = self.weak_self.get().and_then(std::sync::Weak::upgrade) else {
            tracing::warn!("离场暂停没有 AppState 弱引用，跳过");
            return;
        };
        tokio::spawn(async move {
            tokio::time::sleep(DEPART_GRACE).await;
            state.pause_if_alone().await;
        });
    }

    /// 宽限期到点后的判定：没有页面开着、且确实还在出声，才暂停。返回有没有真的
    /// 停。判定只依赖当下的观看者数，与那 3 秒无关，所以单独拆出来能被直接测到。
    ///
    /// `playing == false` 不代表没有播放意图：在线/远程曲目取流期间音频快照尚未
    /// 起播，若此处直接放行，加载完成后就会在零观看者下开始播放，而且不会再有
    /// 新的离场事件来暂停。所以确认独自一人后先顶代际、取消预取，让尚未提交的
    /// 加载在播放提交锁内复核时作废；「顶代际 → 读快照 → 暂停」整段与其它播放
    /// 提交共用同一把锁，避免复核与提交擦肩而过。
    pub(crate) async fn pause_if_alone(&self) -> bool {
        let _commit = self.play_commit.lock().await;
        if self.room.is_active() || self.viewers.load(Ordering::Acquire) > 0 {
            return false;
        }
        self.cancel_prepared_playback().await;
        self.play_generation.fetch_add(1, Ordering::Relaxed);
        if !self.audio.snapshot().playing {
            // 没有声音可停，但缓冲覆盖态属于刚被作废的播放意图，一并收口。
            self.set_buffering(false, None).await;
            return false;
        }
        match self.pause_audio_locked().await {
            Ok(outcome) => {
                tracing::info!(?outcome, "最后一个页面已离场，播放暂停");
                true
            }
            Err(e) => {
                tracing::warn!(error = %e, "离场暂停失败");
                false
            }
        }
    }
}
