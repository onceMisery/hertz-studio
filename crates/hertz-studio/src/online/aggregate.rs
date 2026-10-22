// SPDX-License-Identifier: MIT

//! All 聚合搜索：并发打所有已启用音源，单源超时/失败不拖垮整页。

use std::time::Duration;

use futures::{stream::FuturesOrdered, FutureExt, StreamExt};

use crate::online::{AggregateSearch, FailedSource, SearchPage, SearchQuery};

/// 单源搜索的异步结果：成功给一页，失败给 (code, message)。
pub type SourceSearchFut = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<SearchPage, (String, String)>> + Send>,
>;

/// 并发执行各源搜索（run 由调用方注入，生产是 online::search 的闭包包装），
/// 单源超时或失败只进入 failed，不影响其他源。结果顺序与 sources 一致。
pub async fn collect(
    sources: &[&str],
    query: &str,
    limit: usize,
    run: impl Fn(&str, SearchQuery) -> SourceSearchFut + Send + Sync,
    per_source_timeout: Duration,
) -> AggregateSearch {
    // Own child futures directly: dropping the aggregate drops running requests
    // and gate waiters too. Dropped JoinHandles would detach them until their
    // source deadlines, occupying the shared search budget after cancellation.
    let mut pending = FuturesOrdered::new();
    for source in sources {
        let source = source.to_string();
        let q = SearchQuery {
            q: Some(query.to_string()),
            cat: None,
            source: source.clone(),
            limit,
            offset: 0,
        };
        let fut = run(&source, q);
        pending.push_back(async move {
            let result =
                std::panic::AssertUnwindSafe(tokio::time::timeout(per_source_timeout, fut))
                    .catch_unwind()
                    .await;
            match result {
                Ok(Ok(Ok(page))) => Ok(page),
                Ok(Ok(Err((code, message)))) => Err(FailedSource {
                    source: source.clone(),
                    code,
                    message,
                }),
                Ok(Err(_)) => Err(FailedSource {
                    source: source.clone(),
                    code: "upstream_timeout".into(),
                    message: "该音源响应超时".into(),
                }),
                Err(_) => Err(FailedSource {
                    source,
                    code: "task_panicked".into(),
                    message: "聚合任务异常".into(),
                }),
            }
        });
    }

    let mut results = Vec::new();
    let mut failed = Vec::new();
    // Concurrent polling, with output in source order even when later sources
    // finish first. Unwinding one source keeps the same per-source error shape.
    while let Some(result) = pending.next().await {
        match result {
            Ok(page) => results.push(page),
            Err(f) => failed.push(f),
        }
    }
    AggregateSearch {
        query: query.to_string(),
        results,
        failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::OnlineTrack;

    fn page(source: &str) -> SearchPage {
        SearchPage {
            pagination: None,
            source: source.into(),
            keyword: "x".into(),
            total: 1,
            total_is_exact: false,
            tracks: vec![OnlineTrack {
                source: source.into(),
                id: "1".into(),
                title: "t".into(),
                artist: "a".into(),
                album: String::new(),
                duration_ms: 0,
                cover: None,
                playable: true,
                vip_only: false,
                track_ref: serde_json::json!({}),
            }],
            warning: None,
        }
    }

    #[tokio::test]
    async fn one_source_failure_does_not_block_others() {
        let run = |src: &str, _q: SearchQuery| -> SourceSearchFut {
            let src = src.to_string();
            Box::pin(async move {
                if src == "bad" {
                    Err(("upstream_rejected".into(), "拒绝".into()))
                } else {
                    Ok(page(&src))
                }
            })
        };
        let agg = collect(&["ok", "bad"], "x", 10, run, Duration::from_secs(2)).await;
        assert_eq!(agg.results.len(), 1);
        assert_eq!(agg.results[0].source, "ok");
        assert_eq!(agg.failed.len(), 1);
        assert_eq!(agg.failed[0].source, "bad");
        assert_eq!(agg.failed[0].code, "upstream_rejected");
    }

    #[tokio::test]
    async fn timeout_source_goes_to_failed() {
        let run = |_src: &str, _q: SearchQuery| -> SourceSearchFut {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok(page("slow"))
            })
        };
        let agg = collect(&["slow"], "x", 10, run, Duration::from_millis(20)).await;
        assert!(agg.results.is_empty());
        assert_eq!(agg.failed[0].code, "upstream_timeout");
    }

    #[tokio::test]
    async fn panicked_source_goes_to_failed() {
        // 开发构建的 unwind 只影响当前来源，仍保留真实音源 id。
        // panic=abort 的发布构建不承诺恢复 panic。
        let run = |src: &str, _q: SearchQuery| -> SourceSearchFut {
            let src = src.to_string();
            Box::pin(async move {
                if src == "boom" {
                    panic!("boom");
                }
                Ok(page(&src))
            })
        };
        let agg = collect(&["boom", "ok"], "x", 10, run, Duration::from_secs(2)).await;
        assert_eq!(agg.results.len(), 1);
        assert_eq!(agg.results[0].source, "ok");
        assert_eq!(agg.failed.len(), 1);
        assert_eq!(agg.failed[0].source, "boom");
        assert_eq!(agg.failed[0].code, "task_panicked");
    }

    #[tokio::test]
    async fn cancellation_drops_sources_and_releases_running_and_waiting_gate_slots() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        struct Dropped(Arc<AtomicUsize>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let gate = Arc::new(super::super::search_gate::SearchGate::new(
            1,
            Duration::from_secs(30),
        ));
        // One running source and every waiting seat. A second pass proves that
        // cancellation also returned the waiting seats, not just the permit.
        let sources = ["blocked"; super::super::search_gate::MAX_WAITERS + 1];
        for _ in 0..2 {
            let entered = Arc::new(AtomicUsize::new(0));
            let dropped = Arc::new(AtomicUsize::new(0));
            let mut aggregate = Box::pin(collect(
                &sources,
                "x",
                10,
                {
                    let gate = gate.clone();
                    let entered = entered.clone();
                    let dropped = dropped.clone();
                    move |_, _| {
                        let guard = Dropped(dropped.clone());
                        let gate = gate.clone();
                        let entered = entered.clone();
                        Box::pin(async move {
                            let _guard = guard;
                            gate.run(async move {
                                entered.fetch_add(1, Ordering::SeqCst);
                                std::future::pending::<Result<SearchPage, crate::error::ApiError>>()
                                    .await
                            })
                            .await
                            .map_err(|err| (err.code.to_string(), err.message))
                        })
                    }
                },
                Duration::from_secs(30),
            ));
            assert!(futures::poll!(aggregate.as_mut()).is_pending());
            assert_eq!(entered.load(Ordering::SeqCst), 1);
            assert_eq!(dropped.load(Ordering::SeqCst), 0);
            drop(aggregate);
            assert_eq!(dropped.load(Ordering::SeqCst), sources.len());
        }
        let mut next = Box::pin(gate.run(async { Ok(42) }));
        assert!(matches!(
            futures::poll!(next.as_mut()),
            std::task::Poll::Ready(Ok(42))
        ));
    }

    #[tokio::test]
    async fn sources_overlap_and_results_keep_source_order() {
        let later_finished = std::sync::Arc::new(tokio::sync::Notify::new());
        let run = move |source: &str, _: SearchQuery| -> SourceSearchFut {
            let later_finished = later_finished.clone();
            let source = source.to_string();
            Box::pin(async move {
                if source == "first" {
                    later_finished.notified().await;
                } else {
                    later_finished.notify_one();
                }
                Ok(page(&source))
            })
        };
        let agg = collect(&["first", "second"], "x", 10, run, Duration::from_secs(2)).await;
        assert!(agg.failed.is_empty());
        assert_eq!(
            agg.results
                .iter()
                .map(|p| p.source.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
    }
}
