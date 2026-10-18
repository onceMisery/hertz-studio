// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 搜索入场限制与单源总期限（技术路线 §4.1，R1-S 服务端半场）。
//!
//! - **共享入场额度**：HTTP 单源、RPC 单源、旧聚合、内部接力搜索全部经过
//!   同一把闸——放在应用路径上而不是传输层，未来调用方绕不过去。额度满时
//!   有界等待一段时间，超时明确返回 `search_busy`（429），绝不累积无限的
//!   semaphore 等待者。聚合本身不占额度，每个源通过同一单源搜索入口。
//! - **单源总期限**：从入场到读完结果 6 秒，与旧聚合的单源预算一致——
//!   这个保证过去只包在 `aggregate::collect` 外层，单源路径本来没有。
//!   超时映射回既有 `upstream_timeout`（504），前端有行内重试。
//!
//! 并发数与等待期是 R0 压测前的初始候选，压测后在 ADR 里固定。

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;

use crate::error::ApiError;

/// 全 DataDir 并发搜索执行数（初始候选，待 R0 压测固定）。
pub(crate) const PERMITS: usize = 4;
/// 额度满时的有界等待期（初始候选）：给突发请求一次搭车机会，不排队。
pub(crate) const WAIT: Duration = Duration::from_secs(2);
/// 等待人数硬上限：等待期限制的是「等多久」，这里限制的是「多少人同时在
/// 等」——超过即立刻 busy，不积累无限等待者（§4.1）。
pub(crate) const MAX_WAITERS: usize = 16;
/// 单源搜索总期限：入场 → 读完结果。
pub(crate) const SOURCE_DEADLINE: Duration = Duration::from_secs(6);

pub(crate) struct SearchGate {
    permits: Arc<tokio::sync::Semaphore>,
    waiters: Arc<tokio::sync::Semaphore>,
    wait: Duration,
}

impl Default for SearchGate {
    fn default() -> Self {
        Self::new(PERMITS, WAIT)
    }
}

impl SearchGate {
    #[cfg(test)]
    pub(super) fn available(&self) -> (usize, usize) {
        (
            self.permits.available_permits(),
            self.waiters.available_permits(),
        )
    }

    pub(crate) fn new(permits: usize, wait: Duration) -> Self {
        Self {
            permits: Arc::new(tokio::sync::Semaphore::new(permits)),
            waiters: Arc::new(tokio::sync::Semaphore::new(MAX_WAITERS)),
            wait,
        }
    }

    /// 单源路径：有界等待入场 → 6 秒总期限执行。额度满返回 429
    /// `search_busy`；超时返回 504 `upstream_timeout`。两种情况都不占用
    /// 额度离开。
    pub(crate) async fn run<T>(
        &self,
        fut: impl Future<Output = Result<T, ApiError>>,
    ) -> Result<T, ApiError> {
        self.run_with(SOURCE_DEADLINE, fut).await
    }

    /// 指定总期限的执行（含等待入场），供测试验证短预算。
    pub(crate) async fn run_with<T>(
        &self,
        deadline: Duration,
        fut: impl Future<Output = Result<T, ApiError>>,
    ) -> Result<T, ApiError> {
        let started = tokio::time::Instant::now();
        // 等待席位也是硬上限：席位满说明排队人数已到顶，立即 busy。
        let waiter = self.waiters.try_acquire().map_err(|_| {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "search_busy",
                "搜索通道繁忙，请稍后重试",
            )
        })?;
        let permit = tokio::time::timeout(self.wait.min(deadline), self.permits.acquire())
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "search_busy",
                    "搜索通道繁忙，请稍后重试",
                )
            })?
            .map_err(|_| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "search_gate_closed",
                    "搜索入场闸已关闭",
                )
            })?;
        drop(waiter);
        let result = tokio::time::timeout(deadline.saturating_sub(started.elapsed()), fut).await;
        drop(permit);
        match result {
            Ok(inner) => inner,
            Err(_) => Err(ApiError::upstream_timeout(format!(
                "搜索超过 {} 秒预算",
                deadline.as_secs()
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok<T>(value: T) -> Result<T, ApiError> {
        Ok(value)
    }

    #[tokio::test]
    async fn saturated_gate_returns_busy_without_unbounded_waiters() {
        let gate = Arc::new(SearchGate::new(1, Duration::from_millis(10)));
        // 占住唯一额度 150ms。
        let holder_gate = gate.clone();
        let holder = tokio::spawn(async move {
            holder_gate
                .run(async {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    ok(1u8)
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let err = gate
            .run(async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                ok(2u8)
            })
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 429);
        assert_eq!(err.code, "search_busy");
        assert!(holder.await.unwrap().is_ok(), "持有人不受后来者影响");
    }

    #[tokio::test]
    async fn bounded_wait_rides_the_next_release() {
        let gate = Arc::new(SearchGate::new(1, Duration::from_secs(2)));
        let holder_gate = gate.clone();
        let holder = tokio::spawn(async move {
            holder_gate
                .run(async {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    ok(1u8)
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        // 等待期足够长：持有人释放后搭上车。
        let value = gate
            .run(async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                ok(2u8)
            })
            .await
            .unwrap();
        assert_eq!(value, 2);
        holder.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn source_deadline_truncates_and_releases_the_permit() {
        let gate = SearchGate::new(1, Duration::from_secs(2));
        let err = gate
            .run_with(Duration::from_millis(20), async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                ok(1u8)
            })
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 504);
        assert_eq!(err.code, "upstream_timeout");
        // 超时后额度必须已释放：下一次瞬时调用直接成功。
        let value = gate.run(async { ok(2u8) }).await.unwrap();
        assert_eq!(value, 2);
    }

    #[tokio::test]
    async fn waiter_seats_are_hard_capped() {
        // 执行位被长任务占住、16 个等待席全部就位后，第 17 个调用不等、
        // 立即 busy——等待人数有人数硬上限，而不是只有时长上限。
        let gate = Arc::new(SearchGate::new(1, Duration::from_millis(300)));
        let mut holders = Vec::new();
        for _ in 0..MAX_WAITERS + 1 {
            let g = gate.clone();
            holders.push(tokio::spawn(async move {
                g.run(async {
                    // 执行位持有者睡得比等待期久：等待者超时退出也占过席位。
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    ok(1u8)
                })
                .await
            }));
        }
        // 等席位就位（执行位 + 16 席），第 17 个消费者只能撞席位上限。
        tokio::time::sleep(Duration::from_millis(150)).await;
        let direct = gate.run(async { ok(2u8) }).await;
        assert_eq!(direct.unwrap_err().code, "search_busy");
        // 收尾：只有执行位持有者成功，16 个等待者全部按期限退出。
        let mut ok = 0;
        let mut timed_out = 0;
        for holder in holders {
            if holder.await.unwrap().is_ok() {
                ok += 1;
            } else {
                timed_out += 1;
            }
        }
        assert_eq!(ok, 1);
        assert_eq!(timed_out, MAX_WAITERS);
    }

    #[tokio::test]
    async fn short_total_budget_allows_a_fast_source() {
        let gate = SearchGate::new(1, Duration::from_secs(2));
        let value = gate
            .run_with(Duration::from_millis(50), async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                ok(7u8)
            })
            .await
            .unwrap();
        assert_eq!(value, 7);
    }

    #[tokio::test]
    async fn admission_wait_consumes_the_source_deadline() {
        let gate = Arc::new(SearchGate::new(1, Duration::from_secs(2)));
        let permit = gate.permits.acquire().await.unwrap();
        let ready = Arc::new(tokio::sync::Notify::new());
        let worker_gate = gate.clone();
        let worker_ready = ready.clone();
        let worker = tokio::spawn(async move {
            worker_ready.notify_one();
            worker_gate
                .run_with(Duration::from_millis(400), async {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    ok(7u8)
                })
                .await
        });
        ready.notified().await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        drop(permit);
        let error = worker.await.unwrap().unwrap_err();
        assert_eq!(error.code, "upstream_timeout");
        assert_eq!(gate.run(async { ok(2u8) }).await.unwrap(), 2);
    }
}
