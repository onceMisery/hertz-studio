// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 首跳票据：把「长期 token 出现在 URL 里」收敛成短时效、次数有限的票。
//!
//! 为什么需要它：浏览器有三条发不出请求头的通道 —— `<img src>` 取封面、
//! WebSocket 握手、以及用户要复制到别处的链接。这些只能把凭据写进查询串，而
//! 查询串会进浏览器历史、进在线中间层的访问日志、进 OBS 这类宿主的配置文件。
//! 长期 token 放在那里，等于把整台服务的钥匙散出去：一旦泄露，撤销只能靠换
//! token（而那会同时踢掉所有客户端）。
//!
//! 票的性质：**短时效 + 次数有限 + 自己签不出来**。签发必须出示长期 token
//! （见 `POST /v1/auth/ticket`），泄露一张票最多让攻击者在 TTL 内用掉剩余次数，
//! 拿不到新票、也换不到长期 token。
//!
//! 有意不使用「票据绑定具体路径」：签发时调用方还不知道用户接下来会点哪几首，
//! 允许的路径集合会变成一份要跟着前端改的清单，漂移风险比收益大。约束靠
//! 「短时效 + 次数 + 只挂在 GET 通道上」这三条（见 `routes::require_token`）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use uuid::Uuid;

/// 在册票据上限。正常用量是「一次开页面 + 几次握手 + 一批封面」，几十张顶天；
/// 512 只兜异常增长。满了先扫过期项，仍满则丢最早到期的。
pub(crate) const TICKET_CAP: usize = 512;

/// 单张票的寿命上限。调用方可以要更短，但要不更长 —— 这是一张「临时通行证」，
/// 不该长到可以当第二把钥匙用。OBS 浮层需要的是**另一件东西**：一把长期、
/// 只读、只认浮层接口的独立凭据（还没做，见 spec 的 S3 备注）。
pub(crate) const TICKET_MAX_TTL: Duration = Duration::from_secs(3600);

/// 单张票可被兑换的次数上限。一次页面刷出 200 行封面 ≈ 200 次 GET，所以这里
/// 给得很宽；真正兜底的是 TTL。
pub(crate) const TICKET_MAX_USES: u32 = 4096;

/// 默认寿命（调用方不指定时）。
pub(crate) const TICKET_TTL: Duration = Duration::from_secs(120);

/// 默认次数（调用方不指定时）：一次性，适合首跳与握手。
pub(crate) const TICKET_USES: u32 = 1;

/// 签发结果。`ttl`/`uses` 是**实际生效值**（已按上限收拢），回给客户端做对照。
pub(crate) struct Issued {
    pub id: String,
    pub ttl: Duration,
    pub uses: u32,
}

struct Entry {
    expires_at: Instant,
    uses_left: u32,
}

/// 票据表（进程内，重启即清）。
///
/// 重启清空是有意的：票只服务于「刚刚那次导航/握手」，没有跨重启复用的场景，
/// 而持久化会引入「票文件被读到就等于拿到凭据」的新面。
#[derive(Default)]
pub(crate) struct TicketStore {
    inner: Mutex<HashMap<String, Entry>>,
}

impl TicketStore {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        // 票据表被毒化没有实际后果（最坏是丢几张票，重新签就是了），
        // 但绝不能因此让请求路径 panic —— 见 diag.rs 的同款处理。
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 签一张票。票号是 122 位随机（一个 v4 UUID），与 token 同一套随机源。
    pub(crate) fn issue(&self, ttl: Duration, uses: u32) -> Issued {
        let id = Uuid::new_v4().simple().to_string();
        let ttl = ttl.clamp(Duration::from_secs(1), TICKET_MAX_TTL);
        let uses = uses.clamp(1, TICKET_MAX_USES);
        let mut map = self.lock();
        if map.len() >= TICKET_CAP {
            evict(&mut map);
        }
        map.insert(
            id.clone(),
            Entry {
                expires_at: Instant::now() + ttl,
                uses_left: uses,
            },
        );
        Issued { id, ttl, uses }
    }

    /// 兑一张票：未过期且还有剩余次数才成立，成立时扣掉一次；用完即摘除。
    /// 过期的票顺手清掉，不给它留到下次。
    pub(crate) fn redeem(&self, id: &str) -> bool {
        let mut map = self.lock();
        let now = Instant::now();
        match map.get_mut(id) {
            Some(entry) if entry.expires_at > now && entry.uses_left > 0 => {
                entry.uses_left -= 1;
                if entry.uses_left == 0 {
                    map.remove(id);
                }
                true
            }
            Some(_) => {
                map.remove(id);
                false
            }
            None => false,
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// 表满时的腾位：先清过期项；仍满则丢最早到期的那张（最不可能还在用）。
fn evict(map: &mut HashMap<String, Entry>) {
    let now = Instant::now();
    map.retain(|_, entry| entry.expires_at > now);
    if map.len() < TICKET_CAP {
        return;
    }
    if let Some(oldest) = map
        .iter()
        .min_by_key(|(_, entry)| entry.expires_at)
        .map(|(id, _)| id.clone())
    {
        map.remove(&oldest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn a_ticket_is_spent_after_its_uses_run_out() {
        let store = TicketStore::new();
        let issued = store.issue(Duration::from_secs(30), 2);

        assert!(store.redeem(&issued.id), "第一次应该成立");
        assert!(store.redeem(&issued.id), "第二次应该成立");
        assert!(!store.redeem(&issued.id), "第三次必须失败（次数用尽）");
        assert_eq!(store.len(), 0, "用尽的票立刻摘除，不留残骸");
    }

    #[test]
    fn an_expired_ticket_never_redeems() {
        let store = TicketStore::new();
        // TTL 有 1 秒的下限（见 issue 的 clamp）：更短的票没有任何用处，
        // 所以这里就用下限值，睡过它来验过期。
        let issued = store.issue(Duration::from_millis(20), 5);
        assert_eq!(
            issued.ttl,
            Duration::from_secs(1),
            "低于下限的 TTL 被抬到下限"
        );
        assert!(store.redeem(&issued.id), "下限内仍应可用");

        sleep(Duration::from_millis(1100));
        assert!(!store.redeem(&issued.id), "过期票必须失败");
        assert_eq!(store.len(), 0, "过期票在兑换时顺手清掉");
    }

    #[test]
    fn unknown_tickets_are_rejected() {
        let store = TicketStore::new();
        assert!(!store.redeem("nope"));
        assert!(!store.redeem(""));
    }

    /// 调用方要超长 TTL / 超多次数时必须被收拢，而不是照单全收 ——
    /// 否则 `ttl_ms: 99999999999` 就能把票变成第二把长期钥匙。
    #[test]
    fn ttl_and_uses_are_clamped_to_the_caps() {
        let store = TicketStore::new();
        let issued = store.issue(Duration::from_secs(999_999), 99_999);
        assert_eq!(issued.ttl, TICKET_MAX_TTL);
        assert_eq!(issued.uses, TICKET_MAX_USES);

        let zero = store.issue(Duration::ZERO, 0);
        assert_eq!(zero.uses, 1, "0 次没有意义，至少给一次");
        assert!(zero.ttl >= Duration::from_secs(1), "TTL 不能被削成 0");
    }

    #[test]
    fn the_table_stays_bounded_and_drops_the_soonest_to_expire() {
        let store = TicketStore::new();
        let mut ids = Vec::new();
        for _ in 0..TICKET_CAP + 8 {
            ids.push(store.issue(Duration::from_secs(60), 1).id);
        }
        assert!(store.len() <= TICKET_CAP, "在册数量必须有上限");

        // 最早签的那几张会被先丢；最近签的仍在。
        let newest = ids.last().cloned().unwrap();
        assert!(store.redeem(&newest), "最近签的票应仍在册");
    }
}
