// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 搜索入场限制与单源总期限（技术路线 §4.1，R1-S 服务端半场）。
//!
//! - **共享入场额度**：HTTP 单源、RPC 单源、旧聚合、内部接力搜索全部经过
//!   同一把闸——放在应用路径上而不是传输层，未来调用方绕不过去。额度满时
//!   有界等待一段时间，超时明确返回 `search_busy`（429），绝不累积无限的
//!   semaphore 等待者。聚合只占**一份**额度，内部每源调用走未限流的
//!   [`super::search_once`]，不重复占额度。
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
/// 单源搜索总期限：入场 → 读完结果。
pub(crate) const SOURCE_DEADLINE: Duration = Duration::from_secs(6);
/// 聚合的安全总期限：内部每源各自 6 秒并发执行，这里只防失控驻留。
pub(crate) const AGGREGATE_DEADLINE: Duration = Duration::from_secs(15);

pub(crate) struct SearchGate {
    permits: Arc<tokio::sync::Semaphore>,
    wait: Duration,
}

impl Default for SearchGate {
    fn default() -> Self {
        Self::new(PERMITS, WAIT)
    }
}

impl SearchGate {
    pub(crate) fn new(permits: usize, wait: Duration) -> Self {
        Self {
            permits: Arc::new(tokio::sync::Semaphore::new(permits)),
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

    /// 指定期限的执行。聚合路径用它放宽总期限（内部每源已有各自预算）。
    pub(crate) async fn run_with<T>(
        &self,
        deadline: Duration,
        fut: impl Future<Output = Result<T, ApiError>>,
    ) -> Result<T, ApiError> {
        let permit = tokio::time::timeout(self.wait, self.permits.acquire())
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
        let result = tokio::time::timeout(deadline, fut).await;
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
    async fn run_with_extends_the_deadline_for_the_aggregate() {
        let gate = SearchGate::new(1, Duration::from_secs(2));
        // run 默认 6 秒期限之外，run_with 可以放宽（内部每源自带预算）。
        let value = gate
            .run_with(Duration::from_millis(50), async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                ok(7u8)
            })
            .await
            .unwrap();
        assert_eq!(value, 7);
    }
}
