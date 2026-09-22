// SPDX-License-Identifier: MIT

//! All 聚合搜索：并发打所有已启用音源，单源超时/失败不拖垮整页。

use std::time::Duration;

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
    let mut handles = Vec::new();
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
        handles.push(tokio::spawn(async move {
            match tokio::time::timeout(per_source_timeout, fut).await {
                Ok(Ok(page)) => Ok(page),
                Ok(Err((code, message))) => Err(FailedSource {
                    source: source.clone(),
                    code,
                    message,
                }),
                Err(_) => Err(FailedSource {
                    source: source.clone(),
                    code: "upstream_timeout".into(),
                    message: "该音源响应超时".into(),
                }),
            }
        }));
    }

    let mut results = Vec::new();
    let mut failed = Vec::new();
    // handles 的生成顺序与 sources 一致，zip 配对后 JoinError 分支也能拿到
    // 真实音源 id——panic 时任务内的 source 已经随任务一起没了，只能从外面补。
    for (source, h) in sources.iter().zip(handles) {
        match h.await.unwrap_or_else(|_| {
            Err(FailedSource {
                source: (*source).to_string(),
                code: "task_panicked".into(),
                message: "聚合任务异常".into(),
            })
        }) {
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
            source: source.into(),
            keyword: "x".into(),
            total: 1,
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
        // spawned 任务 panic 时 JoinHandle 回 JoinError：不能让整个聚合页炸掉，
        // 兜底成 failed 并带上真实音源 id（任务内的 source 随 panic 一起没了）。
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
}
