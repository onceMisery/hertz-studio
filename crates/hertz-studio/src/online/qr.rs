// SPDX-License-Identifier: MIT

//! 二维码登录会话：只管票的生命周期与状态，不懂任何平台协议。
//! 平台模块在 confirmed 时自己把凭据写进 cred 保险库。
//!
//! Registry 在 Task 14 已由路由层消费（AppState 持有、/qr/* 端点调用）。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use uuid::Uuid;

pub const TTL_MS: u128 = 180_000;

/// 票的终态：一旦进入不可回退。confirmed 是手机端的物理确认，之后再用
/// waiting/expired 覆盖只会让前端重复弹登录；终态也不应再驱动上游轮询
/// （QQ 的 check_sig 是一次性凭证，confirmed 后重放可能直接报错）。
///
/// rejected 是上游明确拒绝这次扫码（如网易云 8821「请切换其他登录方式」）：
/// 同样不可回退，再问上游只会拿到同一句。
///
/// mfa_required 是上游要求二次验证（如汽水音乐 2046），而本项目没有浏览器
/// 内核去跑那道官方 JS 安全验证：它是「此路不通」而不是「稍后再试」，继续
/// 轮询只会永远停在原地，所以同样按终态处理，由前端引导用户改用 cookie。
pub fn is_terminal(state: &str) -> bool {
    matches!(state, "confirmed" | "expired" | "rejected" | "mfa_required")
}

#[derive(Debug, Clone)]
pub struct Session {
    pub source: String,
    pub state: String, // waiting|scanned|confirmed|expired
    pub created_ms: u128,
    /// 平台模块存的任意握手数据（unikey/qrsig/qrCode 等）。
    pub platform_ticket: String,
}

#[derive(Default)]
pub struct Registry {
    inner: Mutex<HashMap<String, Session>>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl Registry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 惰性清理过期票并新建一张。
    pub async fn start(&self, source: &str, platform_ticket: String) -> String {
        let mut map = self.inner.lock().await;
        let cutoff = now_ms().saturating_sub(TTL_MS);
        // 只按 TTL 淘汰：confirmed 票要保留到 TTL 自然过期，平台模块可能在
        // 轮询 confirmed 之后才来取票里的握手数据，立即清掉会让收尾拿不到。
        map.retain(|_, s| s.created_ms >= cutoff);
        let ticket = Uuid::new_v4().simple().to_string();
        map.insert(
            ticket.clone(),
            Session {
                source: source.to_string(),
                state: "waiting".into(),
                created_ms: now_ms(),
                platform_ticket,
            },
        );
        ticket
    }

    pub async fn take(&self, ticket: &str) -> Option<Session> {
        let map = self.inner.lock().await;
        let s = map.get(ticket)?.clone();
        if now_ms().saturating_sub(s.created_ms) > TTL_MS {
            return None;
        }
        Some(s)
    }

    /// 单调更新票态：终态（confirmed/expired）进入后拒绝任何降级，返回值仍
    /// 表示「票是否存在」，与既有调用方语义一致。
    pub async fn update(&self, ticket: &str, state: &str) -> bool {
        let mut map = self.inner.lock().await;
        match map.get_mut(ticket) {
            Some(s) => {
                if !is_terminal(&s.state) {
                    s.state = state.to_string();
                }
                true
            }
            None => false,
        }
    }

    pub async fn cancel(&self, ticket: &str) {
        self.inner.lock().await.remove(ticket);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ticket_lifecycle() {
        let r = Registry::new();
        let t = r.start("netease", "unikey-1".to_string()).await;
        assert!(r.take(&t).await.is_some());
        assert!(r.update(&t, "scanned").await);
        assert_eq!(r.take(&t).await.unwrap().state, "scanned");
        r.cancel(&t).await;
        assert!(r.take(&t).await.is_none());
    }

    #[tokio::test]
    async fn unknown_ticket_is_none() {
        let r = Registry::new();
        assert!(r.take("nope").await.is_none());
        assert!(!r.update("nope", "confirmed").await);
    }

    #[tokio::test]
    async fn confirmed_never_downgrades() {
        let r = Registry::new();
        let t = r.start("netease", "unikey-2".to_string()).await;
        assert!(r.update(&t, "scanned").await);
        assert!(r.update(&t, "confirmed").await);
        // confirmed 之后上游迟到/重放的任何状态都不能把票态打回去。
        assert!(r.update(&t, "waiting").await);
        assert_eq!(r.take(&t).await.unwrap().state, "confirmed");
        assert!(r.update(&t, "expired").await);
        assert_eq!(r.take(&t).await.unwrap().state, "confirmed");
        assert!(r.update(&t, "scanned").await);
        assert_eq!(r.take(&t).await.unwrap().state, "confirmed");
    }

    #[tokio::test]
    async fn rejected_is_terminal_too() {
        let r = Registry::new();
        let t = r.start("netease", "unikey-3".to_string()).await;
        assert!(r.update(&t, "rejected").await);
        assert_eq!(r.take(&t).await.unwrap().state, "rejected");
        // 拒绝是终局：后续任何上游状态都不能把它打回去。
        assert!(r.update(&t, "waiting").await);
        assert_eq!(r.take(&t).await.unwrap().state, "rejected");
        assert!(is_terminal("rejected"));
    }

    #[tokio::test]
    async fn mfa_required_is_terminal_too() {
        // 汽水音乐 2046：二次验证跑不了（没有浏览器内核）。继续轮询只会
        // 永远停在原地，所以它必须是终态，让前端直接引导走 cookie。
        let r = Registry::new();
        let t = r.start("qishui", "token-1".to_string()).await;
        assert!(r.update(&t, "mfa_required").await);
        assert_eq!(r.take(&t).await.unwrap().state, "mfa_required");
        // 终局：后续任何上游状态都不能把它打回去。
        assert!(r.update(&t, "waiting").await);
        assert_eq!(r.take(&t).await.unwrap().state, "mfa_required");
        assert!(is_terminal("mfa_required"));
    }

    #[tokio::test]
    async fn non_terminal_states_can_expire() {
        let r = Registry::new();
        let t = r.start("qq", "pt".to_string()).await;
        assert!(r.update(&t, "scanned").await);
        assert!(r.update(&t, "expired").await);
        assert_eq!(r.take(&t).await.unwrap().state, "expired");
        assert!(is_terminal("confirmed"));
        assert!(is_terminal("expired"));
        assert!(!is_terminal("waiting"));
        assert!(!is_terminal("scanned"));
    }
}
