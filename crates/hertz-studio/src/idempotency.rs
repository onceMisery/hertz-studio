// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 短写幂等：同键同输入的变更命令在窗口内最多执行一次。
//!
//! 技术路线 R2-P（§5.6、§8.3）：`clientOperationId` 是短写幂等键的客户端部分，
//! 服务端以 `(principal, operation, clientOperationId)` 去重。先注册（InFlight）
//! 再调用原 owner，同键同输入合并/回放完成事实，异输入冲突；窗口 10 分钟、
//! 最多 512 条，执行中和未过期的记录不因表满淘汰——满了在执行前拒绝，宁可
//! 让客户端换键重试，也不悄悄丢掉保护。
//!
//! 执行由一个 detached 的有界操作 owner 持有：等待应答的请求断开（HTTP 客户端
//! 取消、RPC 宿主退出）不会 drop 原播放 future，完成事实照常经记录自带的
//! watch 发送端入账，同键重查拿到的是回放而不是第二次执行。记录指针由注册
//! 路径交给 owner，终态写入不经过表锁，也就不存在「写进同键新记录」的竞态。
//!
//! `serverInstanceId` 在进程内是常量、重启后内存表自然清空，键里暂不携带；
//! grants 落地（R2-G）时把 `principal` 换成 local-owner/grant 身份即可，存储
//! 与语义不变。不带 `clientOperationId` 的调用完全绕开本模块，行为与从前
//! 逐字一致。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{watch, Mutex};

use crate::error::{bad_request, internal, ApiError};
use crate::state::{AppState, ControlOutcome};

/// 幂等窗口（§8.3 短写幂等行）：10 分钟，单调时钟计时。
const WINDOW: Duration = Duration::from_secs(10 * 60);
/// 表容量：512 条未过期记录。执行中与未过期都不淘汰，满了拒绝新写。
const CAPACITY: usize = 512;
/// `clientOperationId` 的字节上限。这是防滥用界限，不是协议字段长度。
const KEY_MAX_BYTES: usize = 128;
/// 执行 owner 的独立上限（§8.3）：到点终止卡住的 exec future，记录按
/// 失败收口——执行中的记录因此永远不会过期（上限 < 窗口），TTL 清理
/// 也就不可能删掉仍在执行的记录。
const EXEC_CAP: Duration = Duration::from_secs(30);

/// 官方 UI/本安装调用的主体身份。受限门面（grants，R2-G）的调用以 grantId
/// 作为 principal 传入 [`short_write`]；两者共享同一张去重表但互不串键。
pub(crate) const LOCAL_OWNER: &str = "local";

/// 去重键。`principal` 与 `operation` 由服务端可信上下文提供，
/// 绝不从请求参数接受。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ShortWriteKey {
    principal: String,
    op: &'static str,
    client_op: String,
}

/// 一条去重记录的执行状态。
#[derive(Debug, Clone)]
enum RecordState {
    /// 已注册、owner 尚未确认完成。同键同输入的后来者在这里合并等待。
    InFlight,
    /// owner 确认的完成事实，原样回放。
    Done(ControlOutcome),
    /// owner 报错。失败同样占满整个窗口：同键重查回放失败而不是第二次执行，
    /// 重试语义由客户端换新键表达。
    Failed(ApiError),
}

/// 表里的一条记录。执行完成时通过自带的 watch 发送端广播终态——map 里的
/// 条目与 owner 手里的指针指向同一个 `Arc`，写终态不需要再碰表锁。
struct Record {
    input: serde_json::Value,
    expires_at: Instant,
    state: watch::Sender<RecordState>,
}

impl Record {
    fn new(input: serde_json::Value) -> (Self, watch::Receiver<RecordState>) {
        let (tx, rx) = watch::channel(RecordState::InFlight);
        (
            Self {
                input,
                expires_at: Instant::now() + WINDOW,
                state: tx,
            },
            rx,
        )
    }

    fn expired(&self, now: Instant) -> bool {
        now >= self.expires_at
    }

    fn in_flight(&self) -> bool {
        matches!(&*self.state.borrow(), RecordState::InFlight)
    }

    /// 测试专用：一条已过窗口的记录，用来验证过期清理让位、表满不淘汰。
    #[cfg(test)]
    fn new_expired(input: serde_json::Value) -> (Self, watch::Receiver<RecordState>) {
        let (mut record, rx) = Self::new(input);
        record.expires_at = Instant::now();
        (record, rx)
    }

    /// owner 的结论在这里落账：Done/Failed 都是终态，之后到窗口过期为止
    /// 一律回放。
    fn finalize(&self, outcome: Result<ControlOutcome, vmusic_core::CoreError>) {
        match outcome {
            Ok(outcome) => self.state.send_replace(RecordState::Done(outcome)),
            Err(err) => self.state.send_replace(RecordState::Failed(err.into())),
        };
    }
}

/// 短写去重表。挂在 `AppState` 上，随 DataDir 生命周期存亡。
#[derive(Default)]
pub(crate) struct ShortWriteStore {
    records: Mutex<HashMap<ShortWriteKey, Arc<Record>>>,
}

/// 短写路径的错误：容量与冲突是本模块自己的稳定机器码，owner 的错误原样透传。
#[derive(Debug)]
pub(crate) enum ShortWriteError {
    /// 表满（512 条未过期），执行前拒绝。不淘汰任何记录来腾位。
    Capacity,
    /// 同键异输入：客户端必须换新键，不能复用旧键装新参数。
    Conflict,
    /// owner 执行失败；回放时是首次失败的克隆（保留 code/message/source）。
    Failed(ApiError),
}

impl From<vmusic_core::CoreError> for ShortWriteError {
    fn from(err: vmusic_core::CoreError) -> Self {
        Self::Failed(err.into())
    }
}

impl From<ApiError> for ShortWriteError {
    fn from(err: ApiError) -> Self {
        Self::Failed(err)
    }
}

/// 规整客户端带来的幂等键：非空、不超过 128 字节。`None` 表示本次调用
/// 不参与幂等。
fn normalize_client_op(client_op: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = client_op else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(bad_request("clientOperationId 不能为空"));
    }
    if trimmed.len() > KEY_MAX_BYTES {
        return Err(bad_request("clientOperationId 超过 128 字节上限"));
    }
    Ok(Some(trimmed.to_string()))
}

/// 六种播控共用的短写执行入口。`principal` 是去重键的主体段：官方 UI 传
/// [`LOCAL_OWNER`]，受限门面传 grantId，两边不会互相合并/冲突。
///
/// `client_op` 为 `None` 时完全旁路（现行行为）；否则先查表/注册，再把执行
/// 交给 detached owner——去重记录先于执行注册并与执行一同保活，等待者断开
/// 不影响事实入账。`input` 必须是本次命令参数的规范化 JSON（无参命令传
/// `Value::Null`），它与键共同决定「同键」是合并还是冲突。
pub(crate) async fn short_write<F, Fut>(
    state: Arc<AppState>,
    principal: &str,
    op: &'static str,
    client_op: Option<&str>,
    input: serde_json::Value,
    exec: F,
) -> Result<ControlOutcome, ShortWriteError>
where
    F: FnOnce(Arc<AppState>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<ControlOutcome, vmusic_core::CoreError>>
        + Send
        + 'static,
{
    let Some(client_op) = normalize_client_op(client_op)? else {
        return exec(state.clone()).await.map_err(ShortWriteError::from);
    };
    let key = ShortWriteKey {
        principal: principal.to_string(),
        op,
        client_op,
    };

    let (mut rx, owner_record) = {
        let mut records = state.short_writes.records.lock().await;
        let now = Instant::now();
        // 过期且已终态的才可清；执行中记录即使过了窗口也不淘汰（§8.3），
        // 否则同键后来者会注册新记录、造成第二次执行。
        records.retain(|_, record| !record.expired(now) || record.in_flight());
        match records.get(&key) {
            // 同键同输入：终态回放，执行中合并等待。
            Some(record) => {
                if record.input != input {
                    return Err(ShortWriteError::Conflict);
                }
                match &*record.state.borrow() {
                    RecordState::Done(outcome) => {
                        crate::diaglog!("shortwrite.replay", op = op, mode = "done");
                        return Ok(outcome.clone());
                    }
                    RecordState::Failed(err) => {
                        crate::diaglog!("shortwrite.replay", op = op, mode = "failed");
                        return Err(ShortWriteError::Failed(err.clone()));
                    }
                    RecordState::InFlight => {
                        crate::diaglog!("shortwrite.merge", op = op);
                        (record.state.subscribe(), None)
                    }
                }
            }
            // 新键：先注册再执行。表满只拒绝、不淘汰。
            None => {
                if records.len() >= CAPACITY {
                    crate::diaglog!("shortwrite.capacity", op = op);
                    return Err(ShortWriteError::Capacity);
                }
                let (record, rx) = Record::new(input);
                let record = Arc::new(record);
                records.insert(key, record.clone());
                (rx, Some(record))
            }
        }
    };

    // 有界操作 owner：等待者（HTTP/RPC handler）断开不影响这次执行与入账。
    // 终态经记录自带的发送端写入，不回头碰表，也就不会写进同键的新记录。
    if let Some(record) = owner_record {
        let owner_state = state.clone();
        tokio::spawn(async move {
            // 执行上限：到点终止卡住的 owner future，记录按失败收口——
            // 同键重查拿的是「执行超时」这一事实，而不是无限等待。
            let outcome = match tokio::time::timeout(EXEC_CAP, exec(owner_state.clone())).await {
                Ok(outcome) => outcome,
                Err(_) => Err(vmusic_core::CoreError::Internal(format!(
                    "短写执行超过 {} 秒上限",
                    EXEC_CAP.as_secs()
                ))),
            };
            record.finalize(outcome);
        });
    }

    wait_terminal(&mut rx).await
}

/// 等待记录到达终态：Done 回放事实，Failed 透传错误，执行器崩溃（发送端
/// 被丢）按 internal 失败处理。
async fn wait_terminal(
    rx: &mut watch::Receiver<RecordState>,
) -> Result<ControlOutcome, ShortWriteError> {
    loop {
        match rx.changed().await {
            Ok(()) => match &*rx.borrow() {
                RecordState::Done(outcome) => return Ok(outcome.clone()),
                RecordState::Failed(err) => return Err(ShortWriteError::Failed(err.clone())),
                RecordState::InFlight => continue,
            },
            Err(_) => {
                return Err(ShortWriteError::Failed(internal(
                    "短写执行器异常终止，结果不可确认",
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// owner 执行闭包的统一返回形状。
    type OwnedPlay =
        Pin<Box<dyn Future<Output = Result<ControlOutcome, vmusic_core::CoreError>> + Send>>;

    /// 幂等测试统一用带 schema 的文件库：volume/next 的 owner 路径会碰
    /// settings/tracks 表，内存池会以 no such table 失败。
    async fn short_state() -> (Arc<AppState>, std::thread::JoinHandle<()>) {
        let dir = std::env::temp_dir().join(format!("vmusic-shortwrite-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (state, handle) = crate::state::tests::playback_state_with_db(db).await;
        (Arc::new(state), handle)
    }

    /// 包一层执行计数器：断言「owner 只跑了一次」的直接证据。
    fn counted<F>(counter: &Arc<AtomicUsize>, f: F) -> impl FnOnce(Arc<AppState>) -> OwnedPlay
    where
        F: Fn(Arc<AppState>) -> OwnedPlay + Clone + Send + 'static,
    {
        let counter = counter.clone();
        move |s: Arc<AppState>| {
            let f = f.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                f(s).await
            })
        }
    }

    #[tokio::test]
    async fn duplicate_with_same_key_replays_and_executes_once() {
        let (state, handle) = short_state().await;
        state
            .set_queue(vec!["first".into(), "second".into()], Some(0))
            .await
            .unwrap();
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        vmusic_store::upsert_track(
            &state.db,
            &vmusic_core::Track {
                id: "second".into(),
                path: "second.wav".into(),
                source: vmusic_core::TrackSource::Local,
                title: "second".into(),
                artist: None,
                album: None,
                duration_ms: None,
                bitrate: None,
                sample_rate: None,
                channels: None,
                has_cover: false,
                file_mtime: None,
                file_size: None,
                added_at: 0,
            },
        )
        .await
        .unwrap();
        let counter = Arc::new(AtomicUsize::new(0));
        let next: fn(Arc<AppState>) -> OwnedPlay =
            |s: Arc<AppState>| Box::pin(async move { s.step_by_user(1).await });
        let first = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.next",
            Some("op-1"),
            Value::Null,
            counted(&counter, next),
        )
        .await
        .unwrap();
        let second = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.next",
            Some("op-1"),
            Value::Null,
            counted(&counter, next),
        )
        .await
        .unwrap();
        // 第二次是回放：事实一致、owner 只跑了一次、游标只前进一格。
        assert_eq!(first, second);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(state.current_index().await, Some(1));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn same_key_with_different_input_conflicts() {
        let (state, handle) = short_state().await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.seek",
            Some("op-2"),
            serde_json::json!(100u64),
            |s| Box::pin(async move { s.seek_control(100).await }),
        )
        .await
        .unwrap();
        let second = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.seek",
            Some("op-2"),
            serde_json::json!(200u64),
            |s| Box::pin(async move { s.seek_control(200).await }),
        )
        .await;
        assert!(matches!(second, Err(ShortWriteError::Conflict)));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn failed_owner_stays_replayable_within_window() {
        let (state, handle) = short_state().await;
        let counter = Arc::new(AtomicUsize::new(0));
        // 音量越界：owner 在校验处失败，不产生副作用。
        let first = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.volume_set",
            Some("op-fail"),
            serde_json::json!(1.5),
            counted(&counter, |s| {
                Box::pin(async move { s.set_volume_control(1.5).await })
            }),
        )
        .await;
        assert!(first.is_err());
        let second = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.volume_set",
            Some("op-fail"),
            serde_json::json!(1.5),
            counted(&counter, |s| {
                Box::pin(async move { s.set_volume_control(1.5).await })
            }),
        )
        .await;
        // 同键同输入回放失败：owner 不会被第二次调用。
        assert!(matches!(second, Err(ShortWriteError::Failed(_))));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn full_table_rejects_before_executing_and_expired_entries_prune() {
        let (state, handle) = short_state().await;
        let fill_key = |i: usize| ShortWriteKey {
            principal: LOCAL_OWNER.to_string(),
            op: "playback.pause",
            client_op: format!("fill-{i}"),
        };
        {
            let mut records = state.short_writes.records.lock().await;
            for i in 0..CAPACITY {
                let (record, _rx) = Record::new(Value::Null);
                records.insert(fill_key(i), Arc::new(record));
            }
            // 一条已过期且已终态的旧记录：过期者让位，新写仍被拒——
            // 未过期记录不因表满淘汰；执行中记录即使过期也不淘汰（另一测试）。
            let (stale, _rx) = Record::new_expired(Value::Null);
            stale.finalize(Ok(ControlOutcome::Applied { generation: 0 }));
            records.insert(
                ShortWriteKey {
                    principal: LOCAL_OWNER.to_string(),
                    op: "playback.pause",
                    client_op: "stale".into(),
                },
                Arc::new(stale),
            );
        }
        let counter = Arc::new(AtomicUsize::new(0));
        let rejected = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.pause",
            Some("fresh"),
            Value::Null,
            counted(&counter, |s| {
                Box::pin(async move { s.pause_control().await })
            }),
        )
        .await;
        assert!(matches!(rejected, Err(ShortWriteError::Capacity)));
        assert_eq!(counter.load(Ordering::SeqCst), 0, "满表必须在执行前拒绝");

        // 换成 512 条全部过期且终态的记录：清理腾位，owner 正常执行。
        {
            let mut records = state.short_writes.records.lock().await;
            for i in 0..CAPACITY {
                let (stale, _rx) = Record::new_expired(Value::Null);
                stale.finalize(Ok(ControlOutcome::Applied { generation: 0 }));
                records.insert(fill_key(i), Arc::new(stale));
            }
        }
        let accepted = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.pause",
            Some("fresh"),
            Value::Null,
            counted(&counter, |s| {
                Box::pin(async move { s.pause_control().await })
            }),
        )
        .await;
        assert!(accepted.is_ok());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    /// 在闸门上等待的 owner：把「注册完成」「合并等待」「断开」这些时序
    /// 从竞态变成确定事件。
    fn gated_exec(
        counter: Arc<AtomicUsize>,
        gate: Arc<tokio::sync::Notify>,
    ) -> impl FnOnce(Arc<AppState>) -> OwnedPlay {
        move |s: Arc<AppState>| {
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                gate.notified().await;
                s.pause_control().await
            })
        }
    }

    async fn wait_until_registered(state: &Arc<AppState>) {
        loop {
            let records = state.short_writes.records.lock().await;
            if !records.is_empty() {
                return;
            }
            drop(records);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_same_key_merges_into_one_execution() {
        let (state, handle) = short_state().await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let gate = Arc::new(tokio::sync::Notify::new());
        let counter = Arc::new(AtomicUsize::new(0));
        let a = tokio::spawn(short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.pause",
            Some("op-merge"),
            Value::Null,
            gated_exec(counter.clone(), gate.clone()),
        ));
        wait_until_registered(&state).await;
        let b = tokio::spawn(short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.pause",
            Some("op-merge"),
            Value::Null,
            gated_exec(counter.clone(), gate.clone()),
        ));
        // 给第二条走到合并等待点的时间，然后放行 owner。
        tokio::time::sleep(Duration::from_millis(50)).await;
        gate.notify_waiters();
        let (a, b) = (a.await.unwrap().unwrap(), b.await.unwrap().unwrap());
        assert_eq!(a, b);
        assert_eq!(counter.load(Ordering::SeqCst), 1, "同键并发只执行一次");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_waiter_does_not_orphan_the_owner_execution() {
        let (state, handle) = short_state().await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let gate = Arc::new(tokio::sync::Notify::new());
        let counter = Arc::new(AtomicUsize::new(0));
        // 等待者模拟客户端断开：整个 runner future 被丢掉。
        let waiter = tokio::spawn(short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.pause",
            Some("op-drop"),
            Value::Null,
            gated_exec(counter.clone(), gate.clone()),
        ));
        wait_until_registered(&state).await;
        waiter.abort();
        gate.notify_waiters();
        // owner 是 detached 任务：照常执行并入账。
        tokio::time::sleep(Duration::from_millis(50)).await;
        let replay = short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.pause",
            Some("op-drop"),
            Value::Null,
            gated_exec(counter.clone(), gate.clone()),
        )
        .await
        .unwrap();
        assert!(matches!(replay, ControlOutcome::Applied { .. }));
        assert_eq!(counter.load(Ordering::SeqCst), 1, "断开的等待者不重放执行");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn key_composition_and_validation() {
        let (state, handle) = short_state().await;
        // 同一 clientOperationId 挂在不同 operation 下互不干扰。
        short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.pause",
            Some("op-x"),
            Value::Null,
            |s| Box::pin(async move { s.pause_control().await }),
        )
        .await
        .unwrap();
        short_write(
            state.clone(),
            LOCAL_OWNER,
            "playback.volume_set",
            Some("op-x"),
            serde_json::json!(0.5),
            |s| Box::pin(async move { s.set_volume_control(0.5).await }),
        )
        .await
        .unwrap();
        // 空键与超长键在入口被拒。
        for bad in ["", "   "] {
            let err = normalize_client_op(Some(bad)).unwrap_err();
            assert_eq!(err.status.as_u16(), 400);
        }
        let long = "x".repeat(KEY_MAX_BYTES + 1);
        assert!(normalize_client_op(Some(&long)).is_err());
        assert_eq!(
            normalize_client_op(Some(&"x".repeat(KEY_MAX_BYTES)))
                .unwrap()
                .unwrap()
                .len(),
            KEY_MAX_BYTES
        );
        // 不带键的调用旁路：每次都真实执行。
        let counter = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            short_write(
                state.clone(),
                LOCAL_OWNER,
                "playback.pause",
                None,
                Value::Null,
                counted(&counter, |s| {
                    Box::pin(async move { s.pause_control().await })
                }),
            )
            .await
            .unwrap();
        }
        assert_eq!(counter.load(Ordering::SeqCst), 2);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[test]
    fn short_write_errors_map_to_stable_codes() {
        let capacity: ApiError = ShortWriteError::Capacity.into();
        assert_eq!(capacity.status.as_u16(), 429);
        assert_eq!(capacity.code, "short_write_capacity");
        let conflict: ApiError = ShortWriteError::Conflict.into();
        assert_eq!(conflict.status.as_u16(), 409);
        assert_eq!(conflict.code, "idempotency_conflict");
    }
}
