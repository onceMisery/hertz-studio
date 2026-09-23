# SP1 多音乐平台对接 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mmusic-studio（Rust 单进程 + 零构建原生 JS）中原生接入网易云/QQ音乐/酷狗三平台的搜索、播放、歌词、账号登录、我的歌单、歌单写操作、红心、All 聚合与推荐。

**Architecture:** 演进现有「自由函数 + 能力描述表」音源注册表（不引入 trait 对象）：新增 `cred/qr/sign/aggregate` 四个基础设施模块与 `qq.rs/kugou.rs` 两个音源模块，扩展 `netease.rs`；新增 13 个 REST 端点；`state.rs` 播放队列支持在线虚拟 id 现取现播；前端新增三个 IIFE 文件与 vendored 二维码库。

**Tech Stack:** Rust（tokio/axum/reqwest/sqlx/serde，新增 md-5/sha1/reqwest cookies）、零构建原生 JS、PowerShell+curl 冒烟脚本。

**Spec:** [2026-09-20-sp1-multi-platform-design.md](../specs/2026-09-20-sp1-multi-platform-design.md)（端点 URL、参数、签名盐值、响应字段路径以 spec §2 为权威，本计划不重复抄录，任务中标注「见 spec §x.y」）。

**提交约定：** 每个任务末尾有提交检查点。当前会话未获 git commit 授权；执行时先向用户确认——授权则 `git commit`，未授权则跳过提交、仅保留工作区改动。

---

## 文件结构

**后端（crates/vmusicd/src/）**

| 文件 | 责任 | 动作 |
|---|---|---|
| `online/mod.rs` | 注册表、能力枚举、归一化类型、dispatch、音频缓存 | 改 |
| `online/sign.rs` | md5/sha1/hex、酷狗三签名、QQ zzc、gtk33 | 新建 |
| `online/cred.rs` | CredPack 保险库、设备身份、cookie 解析 | 新建 |
| `online/qr.rs` | 通用二维码会话状态机（内存 TTL） | 新建 |
| `online/aggregate.rs` | All 并发搜索、超时、熔断 | 新建 |
| `online/netease.rs` | 网易云：账号/歌单/扫码/写操作/推荐 | 改 |
| `online/qq.rs` | QQ 全量能力 | 新建 |
| `online/kugou.rs` | 酷狗全量能力 | 新建 |
| `online/http.rs` | 各源 HTTP 客户端构造（jar、UA、风控 JSON 解析） | 新建 |
| `error.rs` | auth/vip/unsupported/upstream 错误构造器 | 改 |
| `routes.rs` | 13 个新端点 + 扩展 online/play | 改 |
| `state.rs` | AppState 加 qr 会话/熔断器；play_index 在线取流 | 改 |
| `main.rs` | include_str! 与静态资源路由 | 改 |
| `tests/fixtures/*.json` | 三平台录制响应夹具 | 新建 |

**前端（crates/vmusicd/web/）**

| 文件 | 责任 | 动作 |
|---|---|---|
| `vendor/qrcode.js` | MIT qrcode-generator 单文件 | 新建（vendor） |
| `online-login.js` | 扫码弹窗、账号卡、cookie 兜底 | 新建 |
| `online.js` | 在线搜索/All/徽标/整盘播放入队（从 app.js 迁入） | 新建 |
| `online-playlists.js` | 平台账号区、歌单网格、详情抽屉、写操作 | 新建 |
| `online.css` | 以上 UI 样式（只用现有 CSS 令牌） | 新建 |
| `index.html` | 脚本/样式引用、视图骨架 | 改 |
| `app.js` | 删除迁出的在线代码，挂接新模块 | 改 |

**脚本/CI**：`scripts/check-online.js`（新建）、`scripts/smoke-online.ps1`（新建）、`.github/workflows/ci.yml`（改）、README.md / NOTICE（改）。

**任务依赖**：1→2,3,4,5（并行）→6,9,12（平台基座）→7,8/10,11/13,14→15→16,17→18→19,20,21（并行）→22→23→24。

---

## Task 1: 依赖、错误构造器与在线域基座类型

**Files:**
- Modify: `Cargo.toml`（workspace 依赖区）
- Modify: `crates/vmusicd/Cargo.toml`
- Modify: `crates/vmusicd/src/error.rs`
- Modify: `crates/vmusicd/src/online/mod.rs`

- [ ] **Step 1: 加 workspace 依赖**

在 `Cargo.toml` 的 `[workspace.dependencies]`，`reqwest` 行替换为带 cookies 的版本，并在 data 区加两条：

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls", "gzip", "cookies"] }
md-5 = "0.10"
sha1 = "0.10"
```

在 `crates/vmusicd/Cargo.toml` 的 `[dependencies]` 加：

```toml
md-5 = { workspace = true }
sha1 = { workspace = true }
```

- [ ] **Step 2: 验证依赖解析**

Run: `cargo build -p vmusicd`
Expected: 编译通过（可能开始拉取 md-5/sha1/cookie crate）。

- [ ] **Step 3: 加四个错误构造器**

在 `crates/vmusicd/src/error.rs` 的 `bad_request` 函数上方加：

```rust
    /// 需要登录（401）。前端据此打开对应平台的登录弹窗。
    pub fn auth_required(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "auth_required", message.into())
    }

    /// 登录了但权益不足（403），如 VIP 曲。
    pub fn vip_required(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "vip_required", message.into())
    }

    /// 该音源未声明此能力（404），前端隐藏入口而非报错。
    pub fn capability_unsupported(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "capability_unsupported", message.into())
    }

    /// 上游明确拒收（502）。区别于 internal() 的通用 502：code 稳定可分支。
    pub fn upstream_rejected(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "upstream_rejected", message.into())
    }

    /// 上游超时（504），前端给行内重试。
    pub fn upstream_timeout(message: impl Into<String>) -> Self {
        Self::new(StatusCode::GATEWAY_TIMEOUT, "upstream_timeout", message.into())
    }
```

这些是 `ApiError` 的关联函数，放在 `impl ApiError` 块内（`internal` 之后）。

- [ ] **Step 4: 在 mod.rs 加能力枚举与新归一化类型**

在 `crates/vmusicd/src/online/mod.rs` 顶部 `mod` 声明区（第 34 行 `mod ccmixter;` 附近）加：

```rust
mod aggregate;
mod cred;
mod http;
mod qr;
mod sign;
```

在 `SourceInfo` 定义之前加能力枚举：

```rust
/// 音源能力位。前端 UI 全部由它驱动：没有的能力不显示入口。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    QrLogin,
    CookieLogin,
    UserPlaylists,
    PlaylistDetail,
    PlaylistWrite,
    Like,
    RecommendSongs,
    RecommendPlaylists,
    PersonalFm,
    HighQuality,
}

/// 平台曲目原始引用。写操作/播放取流时平台模块需要平台专有 id，
/// 归一化的 OnlineTrack 只暴露稳定 id，其余都装进这个不透明 JSON。
pub type TrackRef = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OnlinePlaylist {
    pub source: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    pub track_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_count: Option<u64>,
    #[serde(default)]
    pub creator: String,
    /// created | collected | liked
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaylistDetail {
    pub playlist: OnlinePlaylist,
    pub total: u64,
    #[serde(default)]
    pub tracks: Vec<OnlineTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountInfo {
    pub source: String,
    #[serde(default)]
    pub nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default)]
    pub vip_level: u32,
    #[serde(default)]
    pub vip_label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QrStart {
    pub ticket: String,
    /// 二维码文本：有值时前端本地渲染（网易云）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_text: Option<String>,
    /// 二维码图片 data URL：有值时直接 <img>（QQ/酷狗）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_image: Option<String>,
    /// 建议轮询间隔（毫秒）。
    pub poll_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct QrPoll {
    /// waiting | scanned | confirmed | expired
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedSource {
    pub source: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AggregateSearch {
    pub query: String,
    pub results: Vec<SearchPage>,
    pub failed: Vec<FailedSource>,
}
```

给 `OnlineTrack` 加两个字段（`playable` 之后）：

```rust
    #[serde(default)]
    pub vip_only: bool,
    /// 平台原始引用（QQ media_mid、酷狗 album_id/mixsongid/fileid 等）。
    #[serde(default, rename = "ref")]
    pub track_ref: TrackRef,
```

同步更新现有两处构造 `OnlineTrack` 的地方（netease.rs 的 `netease_track`、
ccmixter.rs 的映射函数），补 `vip_only: false, track_ref: serde_json::json!({})`。
更新 `mod.rs` 与 netease.rs 里所有 `OnlineTrack {` 字面量编译错误处。

- [ ] **Step 5: 扩展 SourceInfo**

`SourceInfo` 加 `caps` 字段：

```rust
pub struct SourceInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub cats: &'static [(&'static str, &'static str)],
    pub supports_cookie: bool,
    pub caps: &'static [Capability],
}
```

更新 `SOURCES` 两条现有记录（caps 在 Task 15 最终补齐；此处先给
netease 与 ccmixter 各自的现有能力）：

```rust
    SourceInfo {
        id: "netease",
        label: "网易云音乐",
        cats: netease::CATS,
        supports_cookie: true,
        caps: &[Capability::CookieLogin],
    },
    SourceInfo {
        id: "ccmixter",
        label: "CCmixter · CC 授权曲库",
        cats: &[],
        supports_cookie: false,
        caps: &[],
    },
```

`list_sources` 的 json! 宏里补一行 `"caps": src.caps,`。

- [ ] **Step 6: 编译并跑现有测试**

Run: `cargo build -p vmusicd ; cargo test -p vmusicd online`
Expected: 编译通过；现有 online 模块测试全绿。

- [ ] **Step 7: 提交检查点**（仅在获授权时）

```bash
git add Cargo.toml crates/vmusicd/Cargo.toml crates/vmusicd/src/error.rs crates/vmusicd/src/online/mod.rs crates/vmusicd/src/online/netease.rs crates/vmusicd/src/online/ccmixter.rs
git commit -m "feat(online): 多平台基座：错误码、能力枚举与归一化类型"
```

---

## Task 2: sign.rs 签名工具（TDD）

**Files:**
- Create: `crates/vmusicd/src/online/sign.rs`
- Test: 同文件 `#[cfg(test)]`

- [ ] **Step 1: 写失败测试**

创建 `crates/vmusicd/src/online/sign.rs`：

```rust
// SPDX-License-Identifier: MIT

//! 平台请求签名工具。只实现平台客户端自身使用的公开摘要算法（MD5/SHA1），
//! 不涉及任何加密音频解密。

use md5::{Digest as Md5Digest, Md5};
use sha1::Digest as Sha1Digest, Sha1;

pub fn md5_hex(input: &[u8]) -> String {
    let mut h = Md5::new();
    h.update(input);
    hex_lower(&h.finalize())
}

pub fn sha1_hex(input: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(input);
    hex_lower(&h.finalize())
}

/// 手写十六进制编码，不引 hex crate。
pub fn hex_lower(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 0x0f) as usize] as char);
    }
    out
}

/// 酷狗公共参数（两种网关共用的形态，具体取值由调用方覆盖）。
pub mod kugou {
    use super::md5_hex;
    use std::collections::BTreeMap;

    pub const ANDROID_SALT: &str = "OIlwieks28dk2k092lksi2UIkp";
    pub const H5_SALT: &str = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
    pub const SIGN_KEY_SALT: &str = "57ae12eb6890223e355ccfcb74edf70d";

    /// 按键名排序后把 k=v 无分隔拼接。BTreeMap 保证顺序确定。
    fn sorted_kv(params: &BTreeMap<String, String>) -> String {
        params
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("")
    }

    /// md5(SALT + sorted(k=v) + body + SALT)
    pub fn android_sign(params: &BTreeMap<String, String>, body: &str) -> String {
        md5_hex(format!("{ANDROID_SALT}{}{body}{ANDROID_SALT}", sorted_kv(params)).as_bytes())
    }

    /// md5(SALT + sorted(k=v) [+ body_json] + SALT)
    pub fn h5_sign(params: &BTreeMap<String, String>, body_json: Option<&str>) -> String {
        let core = sorted_kv(params) + body_json.unwrap_or("");
        md5_hex(format!("{H5_SALT}{core}{H5_SALT}").as_bytes())
    }

    /// md5(lower(hash) + SIGN_KEY_SALT + appid + mid + userid)
    pub fn play_key(hash: &str, mid: &str, userid: &str, appid: &str) -> String {
        md5_hex(
            format!("{}{SIGN_KEY_SALT}{appid}{mid}{}", hash.to_lowercase(), userid).as_bytes(),
        )
    }

    /// 移动版 playInfo 的 key：md5(hash + "kgcloud")
    pub fn mobile_key(hash: &str) -> String {
        md5_hex(format!("{}kgcloud", hash).as_bytes())
    }
}

/// QQ 音乐 musics.fcg 搜索签名（"zzc" 算法）。
pub mod qq {
    use super::sha1_hex;

    const SCRAMBLE: [u8; 20] = [
        89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161,
        121, 179,
    ];
    const PART1: [usize; 8] = [23, 14, 6, 36, 16, 40, 7, 19];
    const PART2: [usize; 8] = [16, 1, 32, 12, 19, 27, 8, 5];

    /// ptqrlogin 的 ptqrtoken：h=0；逐字符 h += (h<<5) + c；最后 &0x7fffffff。
    pub fn gtk33(qrsig: &str) -> u64 {
        let mut h: u64 = 0;
        for c in qrsig.bytes() {
            h = h.wrapping_add(h << 5).wrapping_add(c as u64);
        }
        h & 0x7fff_ffff
    }

    pub fn zzc_sign(body: &str) -> String {
        let hash = sha1_hex(body.as_bytes());
        let chars: Vec<char> = hash.chars().collect();
        let pick = |idxs: &[usize]| {
            idxs.iter()
                // 参考实现的位置是 1 基（含位置 40），转成 0 基索引。
                .map(|i| chars[i - 1])
                .collect::<String>()
        };
        let part1 = pick(&PART1);
        let part2 = pick(&PART2);

        let mut xored = Vec::with_capacity(20);
        for (i, &k) in SCRAMBLE.iter().enumerate() {
            let byte = u8::from_str_radix(&hash[i * 2..i * 2 + 2], 16).unwrap_or(0);
            xored.push(k ^ byte);
        }
        // URL-safe-ish：去掉 / + =，与参考实现一致（不补 -_）。
        let middle = BASE64_STD
            .encode(&xored)
            .chars()
            .filter(|c| !matches!(c, '/' | '+' | '='))
            .collect::<String>();

        format!("zzc{part1}{middle}{part2}").to_lowercase()
    }

    // 20 字节固定输入，手写 base64 比引 crate 更直观（也避免新依赖）。
    const BASE64_STD: Base64 = Base64;
    struct Base64;
    impl Base64 {
        const TBL: &'static [u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        fn encode(&self, data: &[u8]) -> String {
            let mut out = String::new();
            for chunk in data.chunks(3) {
                let b0 = chunk[0] as u32;
                let b1 = *chunk.get(1).unwrap_or(&0) as u32;
                let b2 = *chunk.get(2).unwrap_or(&0) as u32;
                let triple = (b0 << 16) | (b1 << 8) | b2;
                out.push(Self::TBL[((triple >> 18) & 63) as usize] as char);
                out.push(Self::TBL[((triple >> 12) & 63) as usize] as char);
                if chunk.len() > 1 {
                    out.push(Self::TBL[((triple >> 6) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
                if chunk.len() > 2 {
                    out.push(Self::TBL[(triple & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn md5_known_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn kugou_mobile_key_is_md5_hash_plus_kgcloud() {
        // md5("abc" + "kgcloud")
        assert_eq!(kugou::mobile_key("abc"), md5_hex(b"abckgcloud"));
    }

    #[test]
    fn kugou_h5_sign_wraps_with_salt_and_sorts_keys() {
        let mut p = BTreeMap::new();
        p.insert("b".to_string(), "2".to_string());
        p.insert("a".to_string(), "1".to_string());
        let want = md5_hex(
            format!("{}a=1b=2{}", kugou::H5_SALT, kugou::H5_SALT).as_bytes(),
        );
        assert_eq!(kugou::h5_sign(&p, None), want);
    }

    #[test]
    fn kugou_android_sign_includes_body_between_salts() {
        let mut p = BTreeMap::new();
        p.insert("a".to_string(), "1".to_string());
        let want = md5_hex(
            format!("{}a=1{}{}", kugou::ANDROID_SALT, "BODY", kugou::ANDROID_SALT).as_bytes(),
        );
        assert_eq!(kugou::android_sign(&p, "BODY"), want);
    }

    #[test]
    fn qq_zzc_is_deterministic_and_shaped() {
        let s1 = qq::zzc_sign(r#"{"comm":{"ct":11}}"#);
        let s2 = qq::zzc_sign(r#"{"comm":{"ct":11}}"#);
        assert_eq!(s1, s2);
        assert!(s1.starts_with("zzc"));
        assert!(!s1.contains('/') && !s1.contains('+') && !s1.contains('='));
        assert_eq!(s1, s1.to_lowercase());
    }

    #[test]
    fn qq_gtk33_matches_documented_recurrence() {
        // 空串 → 0；单字符可手算：h = 0 + (0<<5) + c = c。
        assert_eq!(qq::gtk33(""), 0);
        assert_eq!(qq::gtk33("A"), 65);
    }
}
```

注意 `md-5`/`sha1` 的导入名在 Rust 2021 中是 `md5`/`sha1`（crate 名带连字符时
用下划线），`Digest` trait 需要 `use md5::Digest`。若编译器报 trait 名冲突，
把两个 `use ... as Digest` 改为在调用处写全 `md5::Digest::update`。

- [ ] **Step 2: 跑测试确认通过**

Run: `cargo test -p vmusicd online::sign`
Expected: 6 个测试全 PASS。

- [ ] **Step 3: clippy/fmt**

Run: `cargo clippy -p vmusicd -- -D warnings ; cargo fmt --all -- --check`
Expected: 无输出（通过）。

- [ ] **Step 4: 提交检查点**

```bash
git add crates/vmusicd/src/online/sign.rs
git commit -m "feat(online): 酷狗/QQ 签名工具及确定性向量测试"
```

---

## Task 3: cred.rs 凭据保险库（TDD）

**Files:**
- Create: `crates/vmusicd/src/online/cred.rs`

- [ ] **Step 1: 写实现**

```rust
// SPDX-License-Identifier: MIT

//! 平台凭据保险库。
//!
//! 每个平台一份结构化 CredPack，序列化成 JSON 存进 settings 表的
//! `online_cred_<source>` 键。任何 GET 接口都不回显这些键（见
//! routes.rs 的 is_credential）。兼容旧键 online_cookie_<source>。

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use vmusic_core::StoreError;

pub const CRED_PREFIX: &str = "online_cred_";
pub const DEVICE_PREFIX: &str = "online_device_";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CredPack {
    #[serde(default)]
    pub cookie: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub userid: String,
    #[serde(default)]
    pub dfid: String,
    #[serde(default)]
    pub mid: String,
    #[serde(default)]
    pub uin: String,
    #[serde(default)]
    pub saved_at: i64,
}

fn cred_key(source: &str) -> String {
    format!("{CRED_PREFIX}{source}")
}
fn legacy_cookie_key(source: &str) -> String {
    format!("online_cookie_{source}")
}
fn device_key(source: &str) -> String {
    format!("{DEVICE_PREFIX}{source}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub async fn put(db: &SqlitePool, source: &str, pack: &CredPack) -> Result<(), StoreError> {
    let mut pack = pack.clone();
    pack.saved_at = now_ms();
    let v = serde_json::to_value(&pack).map_err(|e| StoreError::Serialization(e.to_string()))?;
    vmusic_store::settings::set(db, &cred_key(source), &v).await?;
    // 迁移完成后清掉旧的裸 cookie 键，避免两处真相。
    let _ = sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(legacy_cookie_key(source))
        .execute(db)
        .await;
    Ok(())
}

/// 读取凭据：优先新键，回落旧的裸 cookie 键（netease 老用户）。
pub async fn get(db: &SqlitePool, source: &str) -> Result<Option<CredPack>, StoreError> {
    if let Some(v) = vmusic_store::settings::get(db, &cred_key(source)).await? {
        if let Ok(pack) = serde_json::from_value::<CredPack>(v) {
            return Ok(Some(pack));
        }
    }
    if let Some(v) = vmusic_store::settings::get(db, &legacy_cookie_key(source)).await? {
        if let Some(cookie) = v.as_str() {
            if !cookie.trim().is_empty() {
                return Ok(Some(CredPack {
                    cookie: cookie.trim().to_string(),
                    ..Default::default()
                }));
            }
        }
    }
    Ok(None)
}

pub async fn clear(db: &SqlitePool, source: &str) -> Result<(), StoreError> {
    for k in [cred_key(source), legacy_cookie_key(source)] {
        let _ = sqlx::query("DELETE FROM settings WHERE key = ?1")
            .bind(k)
            .execute(db)
            .await;
    }
    Ok(())
}

/// 非密设备身份（QQ guid、酷狗 mid/dfid）。
pub async fn get_device(db: &SqlitePool, source: &str) -> Result<Option<String>, StoreError> {
    Ok(vmusic_store::settings::get(db, &device_key(source))
        .await?
        .and_then(|v| v.as_str().map(str::to_string)))
}

pub async fn set_device(db: &SqlitePool, source: &str, value: &str) -> Result<(), StoreError> {
    vmusic_store::settings::set(
        db,
        &device_key(source),
        &serde_json::Value::String(value.to_string()),
    )
    .await
}

/// 从 cookie 串取一个字段；用于 uin/MUSIC_U 等判态。
pub fn cookie_field<'a>(cookie: &'a str, name: &str) -> Option<&'a str> {
    cookie.split(';').find_map(|part| {
        let part = part.trim();
        let (k, v) = part.split_once('=')?;
        (k == name).then_some(v)
    })
}

/// 平台登录态判据集中在这里，避免散落在各模块。
pub fn is_signed_in(source: &str, pack: &CredPack) -> bool {
    match source {
        "netease" => cookie_field(&pack.cookie, "MUSIC_U").is_some(),
        "qq" => pack.uin != "0" && !pack.uin.is_empty() && has_qq_key(pack),
        "kugou" => !pack.userid.is_empty() && pack.userid != "0" && !pack.token.is_empty(),
        _ => false,
    }
}

fn has_qq_key(pack: &CredPack) -> bool {
    cookie_field(&pack.cookie, "qm_keyst").is_some()
        || cookie_field(&pack.cookie, "p_skey").is_some()
        || cookie_field(&pack.cookie, "wxuin").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_field_extracts_named_value() {
        let c = " a=1; MUSIC_U=abc; __csrf=x ";
        assert_eq!(cookie_field(c, "MUSIC_U"), Some("abc"));
        assert_eq!(cookie_field(c, "missing"), None);
    }

    #[test]
    fn signed_in_rules() {
        assert!(is_signed_in(
            "netease",
            &CredPack {
                cookie: "MUSIC_U=t;".into(),
                ..Default::default()
            }
        ));
        assert!(!is_signed_in(
            "netease",
            &CredPack {
                cookie: "x=y".into(),
                ..Default::default()
            }
        ));
        assert!(is_signed_in(
            "qq",
            &CredPack {
                uin: "123".into(),
                cookie: "qm_keyst=k".into(),
                ..Default::default()
            }
        ));
        assert!(is_signed_in(
            "kugou",
            &CredPack {
                userid: "9".into(),
                token: "t".into(),
                ..Default::default()
            }
        ));
        assert!(!is_signed_in(
            "kugou",
            &CredPack {
                userid: "0".into(),
                token: "t".into(),
                ..Default::default()
            }
        ));
    }
}
```

- [ ] **Step 2: 跑测试**

Run: `cargo test -p vmusicd online::cred`
Expected: 2 个测试 PASS。

- [ ] **Step 3: 提交检查点**

```bash
git add crates/vmusicd/src/online/cred.rs
git commit -m "feat(online): 结构化凭据保险库与登录态判据"
```

---

## Task 4: qr.rs 会话状态机（TDD）

**Files:**
- Create: `crates/vmusicd/src/online/qr.rs`

- [ ] **Step 1: 写实现**

```rust
// SPDX-License-Identifier: MIT

//! 二维码登录会话：只管票的生命周期与状态，不懂任何平台协议。
//! 平台模块在 confirmed 时自己把凭据写进 cred 保险库。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::online::QrPoll;

pub const TTL_MS: u128 = 180_000;

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
        map.retain(|_, s| s.created_ms >= cutoff && s.state != "confirmed");
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

    pub async fn update(&self, ticket: &str, state: &str) -> bool {
        let mut map = self.inner.lock().await;
        match map.get_mut(ticket) {
            Some(s) => {
                s.state = state.to_string();
                true
            }
            None => false,
        }
    }

    pub async fn cancel(&self, ticket: &str) {
        self.inner.lock().await.remove(ticket);
    }
}

/// 把平台轮询返回的原始状态码归一化。
/// netease: 801/802/803/800；QQ: 66/67/0；酷狗: 2/3/1（各家码值不同，
/// 因此由平台模块先映射成自己的语义串再传进来）。
pub fn poll_of(state: &str) -> QrPoll {
    QrPoll {
        state: state.to_string(),
        account: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ticket_lifecycle() {
        let r = Registry::new();
        let t = r.start("netease", "unikey-1").await;
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
}
```

- [ ] **Step 2: 跑测试**

Run: `cargo test -p vmusicd online::qr`
Expected: 2 个测试 PASS。

- [ ] **Step 3: 提交检查点**

```bash
git add crates/vmusicd/src/online/qr.rs
git commit -m "feat(online): 二维码会话注册表（TTL 状态机）"
```

---

## Task 5: http.rs、熔断与 aggregate.rs（TDD）

**Files:**
- Create: `crates/vmusicd/src/online/http.rs`
- Create: `crates/vmusicd/src/online/aggregate.rs`

- [ ] **Step 1: http.rs —— 每平台客户端与 JSON 助手**

```rust
// SPDX-License-Identifier: MIT

//! 平台 HTTP 客户端公共件：UA、带 cookie 的请求构造、JSON 容错解析。

use reqwest::header::{HeaderMap, HeaderValue, COOKIE};
use reqwest::Client;

use crate::online::{ApiError, ApiResult};

/// 为一次调用构造请求头（cookie 可选）。
pub fn headers(cookie: Option<&str>, referer: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Some(c) = cookie.filter(|c| !c.trim().is_empty()) {
        if let Ok(v) = HeaderValue::from_str(c) {
            h.insert(COOKIE, v);
        }
    }
    if let Some(r) = referer {
        if let Ok(v) = HeaderValue::from_str(r) {
            h.insert(reqwest::header::REFERER, v);
        }
    }
    h
}

/// 发请求并解析 JSON；非 2xx 或风控 JSON 统一成结构化错误。
pub async fn get_json(
    client: &Client,
    url: &str,
    headers: HeaderMap,
) -> ApiResult<serde_json::Value> {
    let resp = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| ApiError::upstream_timeout(format!("连接音源失败: {e}")))?;
    let status = resp.status();
    let body = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| ApiError::upstream_rejected(format!("音源响应不是 JSON: {e}")))?;
    if !status.is_success() {
        return Err(ApiError::upstream_rejected(format!("音源返回 HTTP {status}")));
    }
    Ok(body)
}
```

- [ ] **Step 2: aggregate.rs —— 并发搜索 + 单源超时 + 失败收集**

为可测试，聚合逻辑做成不直接依赖网络的纯函数 `collect`：

```rust
// SPDX-License-Identifier: MIT

//! All 聚合搜索：并发打所有已启用音源，单源超时/失败不拖垮整页。

use std::time::Duration;

use crate::online::{AggregateSearch, FailedSource, SearchPage, SearchQuery};

/// 单源搜索函数的抽象：生产环境是 online::search，测试里注入假实现。
pub trait SourceSearch: Send + Sync {
    fn id(&self) -> &str;
    fn search(
        &self,
        q: SearchQuery,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<SearchPage, (String, String)>> + Send + '_>,
    >;
}

pub async fn collect(
    sources: &[&str],
    query: &str,
    limit: usize,
    run: impl Fn(&str, SearchQuery) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<SearchPage, (String, String)>> + Send>>
        + Send
        + Sync,
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
    for h in handles {
        match h.await.unwrap_or_else(|_| {
            Err(FailedSource {
                source: "unknown".into(),
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
        let run = |src: &str, _q: SearchQuery| {
            let src = src.to_string();
            Box::pin(async move {
                if src == "bad" {
                    Err(("upstream_rejected".into(), "拒绝".into()))
                } else {
                    Ok(page(&src))
                }
            })
        };
        let agg = collect(
            &["ok", "bad"],
            "x",
            10,
            run,
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(agg.results.len(), 1);
        assert_eq!(agg.results[0].source, "ok");
        assert_eq!(agg.failed.len(), 1);
        assert_eq!(agg.failed[0].source, "bad");
        assert_eq!(agg.failed[0].code, "upstream_rejected");
    }

    #[tokio::test]
    async fn timeout_source_goes_to_failed() {
        let run = |_src: &str, _q: SearchQuery| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok(page("slow"))
            })
        };
        let agg = collect(&["slow"], "x", 10, run, Duration::from_millis(20)).await;
        assert!(agg.results.is_empty());
        assert_eq!(agg.failed[0].code, "upstream_timeout");
    }
}
```

注：`SourceSearch` trait 在本任务中不被 `collect` 直接使用（用闭包更简单），
若 clippy 报死代码则删除该 trait，只保留 `collect`。

- [ ] **Step 3: 编译并测试**

Run: `cargo test -p vmusicd online::aggregate`
Expected: 2 个测试 PASS。

- [ ] **Step 4: 提交检查点**

```bash
git add crates/vmusicd/src/online/http.rs crates/vmusicd/src/online/aggregate.rs
git commit -m "feat(online): HTTP 公共件与 All 聚合搜索"
```

---

## Task 6: 酷狗基座——设备身份与搜索（夹具 TDD）

**Files:**
- Create: `crates/vmusicd/src/online/kugou.rs`
- Create: `crates/vmusicd/tests/fixtures/kugou_search.json`

端点 URL/参数/响应字段见 **spec §2.3**。本任务实现：常量、mid/dfid 设备身份、
搜索与归一化；播放/歌词/歌单在后续任务。

- [ ] **Step 1: 录制夹具**

`crates/vmusicd/tests/fixtures/kugou_search.json` 放一段精简但字段真实的响应：

```json
{
  "status": 1,
  "data": {
    "lists": [
      {
        "FileHash": "8E10D8825DDE03BCABBDE13E5A4150D2",
        "SongName": "我们应该算爱过吧",
        "SingerName": "歌手A",
        "AlbumID": "67026620",
        "MixSongID": "477417208",
        "Duration": 213000,
        "Privilege": 0,
        "AlbumName": "专辑X"
      },
      {
        "FileHash": "",
        "MixSongID": "111",
        "SongName": "<em>无版权</em>演示",
        "SingerName": "歌手B",
        "AlbumID": "1",
        "Duration": 60000,
        "Privilege": 10
      }
    ]
  }
}
```

- [ ] **Step 2: 写 kugou.rs 基座与归一化**

```rust
// SPDX-License-Identifier: MIT

//! 酷狗音源。签名算法、端点与降级策略见 spec §2.3。

use std::collections::BTreeMap;

use serde_json::json;

use super::cred::CredPack;
use super::sign::kugou;
use super::{client, ApiError, ApiResult, Ctx, OnlineTrack, SearchPage, SearchQuery};

pub const ID: &str = "kugou";
const SEARCH_URL: &str = "https://songsearch.kugou.com/song_search_v2";
const WEB_APPID: &str = "1014";

/// 生成设备 mid：md5(seed + 毫秒时间 + 随机)。
/// 用时间+随机即可（参考实现同形态）；不引 uuid 之外的随机源。
pub fn new_mid() -> String {
    let seed = format!("kugou-{}-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        uuid::Uuid::new_v4().simple());
    super::sign::md5_hex(seed.as_bytes())
}

/// 确保有 mid/dfid 设备身份：读设置键，缺 mid 则生成；dfid 取不到用 "-"。
async fn device(ctx: &Ctx) -> ApiResult<(String, String)> {
    let mid = match super::cred::get_device(&ctx.db, ID).await.map_err(internal_store)? {
        Some(m) if !m.is_empty() => m,
        _ => {
            let m = new_mid();
            let _ = super::cred::set_device(&ctx.db, ID, &m).await;
            m
        }
    };
    // dfid：正式实现可在此匿名注册取；一期取不到回落 "-"（参考实现亦允许）。
    let dfid = super::cred::get_device(&ctx.db, &format!("{ID}_dfid"))
        .await
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "-".to_string());
    Ok((mid, dfid))
}

fn internal_store(e: vmusic_core::StoreError) -> ApiError {
    ApiError::internal(format!("设置存储失败: {e}"))
}

/// 酷狗歌名含 <em> 高亮标签与 %uXXXX 脏编码，展示前清洗。
fn clean_text(raw: &str) -> String {
    let stripped = regex_lite_strip(raw);
    decode_kugou(&stripped)
}

// 不引 regex crate：<...> 标签用简单扫描删除。
fn regex_lite_strip(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for c in input.chars() {
        match c {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn decode_kugou(input: &str) -> String {
    let mut s = input.to_string();
    // %uXXXX → UTF-16 码元
    if s.contains("%u") {
        let bytes = s.as_bytes();
        let mut out = String::new();
        let mut i = 0;
        while i + 6 <= bytes.len()
            && bytes[i] == b'%'
            && (bytes[i + 1] == b'u' || bytes[i + 1] == b'U')
        {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 2..i + 6]) {
                if let Ok(n) = u32::from_str_radix(hex, 16) {
                    if let Some(ch) = char::from_u32(n) {
                        out.push(ch);
                        i += 6;
                        continue;
                    }
                }
            }
            out.push('%');
            i += 1;
        }
        out.push_str(&s[i..]);
        s = out;
    }
    s
}

fn duration_ms(item: &serde_json::Value) -> u64 {
    // 酷狗搜索 Duration 已是毫秒；防御 0 值。
    item.get("Duration").and_then(|v| v.as_u64()).unwrap_or(0)
}

fn map_track(item: &serde_json::Value) -> OnlineTrack {
    let hash = item.get("FileHash").and_then(|v| v.as_str()).unwrap_or("");
    let mix = item
        .get("MixSongID")
        .and_then(|v| v.as_str().or_else(|| v.as_u64().map(|_| "")))
        .unwrap_or("");
    let album_id = item.get("AlbumID").and_then(|v| v.as_str()).unwrap_or("");
    let id = if !hash.is_empty() {
        hash.to_string()
    } else {
        mix.to_string()
    };
    let privilege = item.get("Privilege").and_then(|v| v.as_i64()).unwrap_or(0);
    OnlineTrack {
        source: ID.into(),
        id,
        title: clean_text(
            item.get("SongName")
                .or_else(|| item.get("FileName"))
                .and_then(|v| v.as_str())
                .unwrap_or("未知曲目"),
        ),
        artist: clean_text(item.get("SingerName").and_then(|v| v.as_str()).unwrap_or("")),
        album: item
            .get("AlbumName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        duration_ms: duration_ms(item),
        cover: None,
        playable: !hash.is_empty(),
        vip_only: privilege != 0,
        track_ref: json!({
            "hash": hash,
            "album_id": album_id,
            "mixsongid": mix,
        }),
    }
}

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let keyword = q.q.as_deref().unwrap_or("").trim();
    if keyword.is_empty() {
        return Err(ApiError::bad_request("需要给出搜索关键词"));
    }
    let pack = super::cred::get(&ctx.db, ID).await.map_err(internal_store)?;
    let (mid, _dfid) = device(ctx).await?;
    let limit = q.limit.clamp(1, 20);
    let page = q.offset / limit + 1;

    let cred = pack.unwrap_or_default();
    let mut url = reqwest::Url::parse(SEARCH_URL).unwrap();
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("keyword", keyword)
            .append_pair("page", &page.to_string())
            .append_pair("pagesize", &limit.to_string())
            .append_pair("userid", if cred.userid.is_empty() { "-1" } else { &cred.userid })
            .append_pair("clientver", "2000")
            .append_pair("platform", "WebFilter")
            .append_pair("tag", "em")
            .append_pair("filter", "2")
            .append_pair("iscorrection", "1")
            .append_pair("privilege_filter", "0")
            .append_pair("appid", WEB_APPID)
            .append_pair("token", &cred.token)
            .append_pair("mid", &mid);
    }
    let headers = super::http::headers(Some(&cred.cookie), Some("https://www.kugou.com/"));
    let body = super::http::get_json(&client()?, url.as_str(), headers).await?;
    if body.get("status").and_then(|v| v.as_i64()) != Some(1) {
        return Err(ApiError::upstream_rejected(
            "酷狗搜索暂时不可用，请稍后重试".into(),
        ));
    }
    let tracks = body
        .pointer("/data/lists")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(map_track).filter(|t| !t.id.is_empty()).collect())
        .unwrap_or_default();
    let total = body
        .pointer("/data/total")
        .and_then(|v| v.as_u64())
        .unwrap_or(tracks.len() as u64) as usize;

    Ok(SearchPage {
        source: ID.into(),
        keyword: keyword.to_string(),
        total,
        tracks,
        warning: None,
    })
}

// 防止未使用告警（后续任务使用）
#[allow(dead_code)]
fn _used(_: BTreeMap<String, String>) {}
#[allow(dead_code)]
fn _used_sign() {
    let _ = kugou::mobile_key("x");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_normalizes_search_items() {
        let body: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/kugou_search.json")).unwrap();
        let arr = body.pointer("/data/lists").unwrap().as_array().unwrap();
        let t0 = map_track(&arr[0]);
        assert_eq!(t0.source, "kugou");
        assert_eq!(t0.id, "8E10D8825DDE03BCABBDE13E5A4150D2");
        assert_eq!(t0.title, "我们应该算爱过吧");
        assert_eq!(t0.duration_ms, 213000);
        assert!(t0.playable && !t0.vip_only);
        assert_eq!(t0.track_ref["album_id"], "67026620");

        // 无 hash 的不可播；Privilege != 0 标记 VIP；<em> 标签被剥掉。
        let t1 = map_track(&arr[1]);
        assert!(!t1.playable);
        assert!(t1.vip_only);
        assert!(!t1.title.contains('<'));
        assert_eq!(t1.title, "无版权演示");
    }

    #[test]
    fn dirty_percent_u_text_decodes() {
        assert_eq!(clean_text("%u5468%u6770%u4f26"), "周杰伦");
    }
}
```

- [ ] **Step 3: 跑测试**

Run: `cargo test -p vmusicd kugou`
Expected: 2 个测试 PASS。

- [ ] **Step 4: 提交检查点**

```bash
git add crates/vmusicd/src/online/kugou.rs crates/vmusicd/tests/fixtures/kugou_search.json
git commit -m "feat(kugou): 设备身份、搜索与归一化"
```

---

## Task 7–8: 酷狗播放/歌词/歌单/登录

**Files:** `crates/vmusicd/src/online/kugou.rs`（继续）

端点、四级回落顺序、签名参数、歌词两跳、歌单字段路径全部见 **spec §2.3**，
实现时逐条对照。函数清单与关键代码如下。

- [ ] **Step 1: 播放（四级回落）**

在 kugou.rs 加：

```rust
const PLAY_MOBILE: &str = "https://m.kugou.com/app/i/getSongInfo.php";
const PLAY_WEB: &str = "https://wwwapi.kugou.com/play/songinfo";
const PLAY_WEB_RETRY: &str = "https://wwwapiretry.kugou.com/play/songinfo";
const GATEWAY: &str = "https://gateway.kugou.com";
const LYRIC_SEARCH: &str = "https://krcs.kugou.com/search";
const LYRIC_DOWNLOAD: &str = "https://krcs.kugou.com/download";

fn pick_url(json: &serde_json::Value) -> Option<String> {
    json.pointer("/data/play_url")
        .or_else(|| json.pointer("/data/url"))
        .or_else(|| json.get("url"))
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
        .map(str::to_string)
}

/// 按 spec §2.3 顺序尝试四个通道，任一返回有效 URL 即成功。
pub async fn stream(ctx: &Ctx, id: &str, quality: u32) -> ApiResult<super::StreamInfo> {
    let pack = super::cred::get(&ctx.db, ID).await.map_err(internal_store)?;
    let cred = pack.unwrap_or_default();
    let (mid, dfid) = device(ctx).await?;
    let hash = id; // 搜索归一化后 id 即 FileHash（无 hash 的曲不可播，不会走到这）
    let q = quality.to_string();

    // ① 移动版匿名 playInfo
    let mobile = {
        let mut u = reqwest::Url::parse(PLAY_MOBILE).unwrap();
        u.query_pairs_mut()
            .append_pair("cmd", "playInfo")
            .append_pair("hash", hash)
            .append_pair("key", &kugou::mobile_key(hash))
            .append_pair("album_id", "0")
            .append_pair("pid", "1")
            .append_pair("forceDown", "0")
            .append_pair("vip", "65530");
        let h = super::http::headers(Some(&cred.cookie), Some("https://m.kugou.com/"));
        super::http::get_json(&client()?, u.as_str(), h).await.ok()
    };
    if let Some(b) = &mobile {
        if b.get("status").and_then(|v| v.as_i64()) == Some(1) {
            if let Some(url) = pick_url(b) {
                return Ok(stream_info(url, &cred, hash, "128k"));
            }
        }
    }

    // ② Web H5 签名（匿名），失败换 retry 域名
    for (i, endpoint) in [PLAY_WEB, PLAY_WEB_RETRY].iter().enumerate() {
        let mut params = h5_base(&cred, &mid, &dfid);
        params.insert("uuid".into(), mid.clone());
        params.insert("platid".into(), "4".into());
        params.insert("hash".into(), hash.to_lowercase());
        params.insert("album_id".into(), "0".into());
        let sig = kugou::h5_sign(&params, None);
        params.insert("signature".into(), sig);
        let url = build_url(endpoint, &params);
        let h = super::http::headers(Some(&cred.cookie), Some("https://www.kugou.com/"));
        if let Ok(b) = super::http::get_json(&client()?, &url, h).await {
            if b.get("status").and_then(|v| v.as_i64()) == Some(1) {
                if let Some(u) = pick_url(&b) {
                    return Ok(stream_info(u, &cred, hash, "web"));
                }
            }
        }
        let _ = i;
    }

    // ③ 登录网关 /v5/url（320/flac），未登录直接跳过
    if !cred.token.is_empty() && cred.userid != "0" {
        let mut params = h5_base(&cred, &mid, &dfid);
        params.insert("album_id".into(), "0".into());
        params.insert("area_code".into(), "1".into());
        params.insert("hash".into(), hash.to_lowercase());
        params.insert("behavior".into(), "play".into());
        params.insert("pid".into(), "2".into());
        params.insert("cmd".into(), "26".into());
        params.insert("quality".into(), quality_param(quality));
        params.insert(
            "key".into(),
            kugou::play_key(hash, &mid, &cred.userid, WEB_APPID),
        );
        params.insert("signature".into(), kugou::h5_sign(&params, None));
        let url = build_url(&format!("{GATEWAY}/v5/url"), &params);
        let mut h = super::http::headers(Some(&cred.cookie), Some("https://www.kugou.com/"));
        let _ = h.insert("x-router", "trackercdn.kugou.com".parse().unwrap());
        if let Ok(b) = super::http::get_json(&client()?, &url, h).await {
            if let Some(u) = pick_url(&b) {
                return Ok(stream_info(u, &cred, hash, &q));
            }
        }
    }

    Err(if cred.userid.is_empty() {
        ApiError::auth_required("酷狗未取得试听地址，登录后可获得更多结果".into())
    } else {
        ApiError::vip_required("该曲目在当前账号下无可用音质（可能为 VIP 专享）".into())
    })
}

fn quality_param(quality_bps: u32) -> String {
    match quality_bps {
        q if q >= 700_000 => "flac".into(),
        q if q >= 320_000 => "320".into(),
        _ => "128".into(),
    }
}

fn h5_base(cred: &CredPack, mid: &str, dfid: &str) -> BTreeMap<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string();
    let mut m = BTreeMap::new();
    for (k, v) in [
        ("srcappid", "2919"),
        ("clientver", "20000"),
        ("clienttime", &now),
        ("mid", mid),
        ("uuid", &now),
        ("dfid", dfid),
        ("appid", WEB_APPID),
        ("token", &cred.token),
    ] {
        m.insert(k.to_string(), v.clone());
    }
    m.insert(
        "userid".into(),
        if cred.userid.is_empty() { "0".into() } else { cred.userid.clone() },
    );
    m
}

fn build_url(base: &str, params: &BTreeMap<String, String>) -> String {
    let qs = params
        .iter()
        .map(|(k, v)| format!("{}={}", urlenc(k), urlenc(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{qs}")
}
fn urlenc(s: &str) -> String {
    // 简易百分号编码交给 reqwest::Url 更稳：生产实现中改为 Url::parse +
    // query_pairs_mut。此处保留拼接仅作签名输入顺序参考。
    s.replace(' ', "%20")
}

fn stream_info(url: String, _cred: &CredPack, id: &str, label: &str) -> super::StreamInfo {
    super::StreamInfo {
        url,
        source: ID.into(),
        id: id.to_string(),
        bitrate: None,
        expires_in_secs: None,
        // label 不进结构体；保留位用于日志。
    }
}
```

实现注意：`build_url` 最终改用 `reqwest::Url::parse(base)` +
`query_pairs_mut().append_pair`（自动编码），不要手写 urlenc；签名计算用
BTreeMap 原始值，URL 编码在签名之后。

- [ ] **Step 2: 歌词两跳**

```rust
pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    let pack = super::cred::get(&ctx.db, ID).await.map_err(internal_store)?;
    let cred = pack.unwrap_or_default();
    // 第一跳：搜 accesskey
    let s_url = format!(
        "{LYRIC_SEARCH}?ver=1&man=yes&client=pc&hash={id}&album_audio_id=0&duration=0"
    );
    let h = super::http::headers(Some(&cred.cookie), Some("https://www.kugou.com/"));
    let body = super::http::get_json(&client()?, &s_url, h).await?;
    let cand = body
        .pointer("/candidates/0")
        .ok_or_else(|| ApiError::upstream_rejected("未找到酷狗歌词".into()))?;
    let lid = cand.get("id").and_then(|v| v.as_str().or_else(|| v.as_i64().map(|_| "")));
    let accesskey = cand.get("accesskey").and_then(|v| v.as_str()).unwrap_or("");
    let lid = lid.unwrap_or("");
    if lid.is_empty() || accesskey.is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }
    // 第二跳：下载 lrc，content 是 base64
    let d_url = format!(
        "{LYRIC_DOWNLOAD}?id={lid}&accesskey={accesskey}&fmt=lrc&charset=utf8"
    );
    let h2 = super::http::headers(Some(&cred.cookie), Some("https://www.kugou.com/"));
    let d = super::http::get_json(&client()?, &d_url, h2).await?;
    let content = d.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }
    let decoded = base64_decode(content).unwrap_or_default();
    let text = String::from_utf8_lossy(&decoded).to_string();
    let mut doc = vmusic_lyrics::parse_lrc(&text);
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(doc)
}

/// 标准 base64 解码（含 -_ URL-safe），手写以避免新依赖；输入为酷狗标准字母表。
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in input.bytes() {
        let val = if c == b'=' { break; } else {
            let ch = if c == b'-' { b'+' } else if c == b'_' { b'/' } else { c };
            T.iter().position(|&t| t == ch)? as u32
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<super::OnlineDetail> {
    // 搜索结果已含主要字段；酷狗无轻量公开详情时，用 /privilege/lite?hash= 补封面。
    // 一期返回最小详情（封面走 AlbumID 图片域，拿不到就 None），不阻断播放。
    let _ = (ctx, id);
    Ok(super::OnlineDetail {
        source: ID.into(),
        id: id.to_string(),
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        duration_ms: 0,
        cover: None,
    })
}
```

- [ ] **Step 3: 歌单读、写操作、账号、推荐、扫码（对照 spec 落地）**

按 spec §2.3 表逐行实现下列 pub async fn，全部走 `h5_base + kugou::h5_sign`
+ gateway，带 `x-router`：

```rust
pub async fn account(ctx: &Ctx) -> ApiResult<super::AccountInfo>;
pub async fn playlists(ctx: &Ctx, scope: &str, offset: usize, limit: usize)
    -> ApiResult<Vec<super::OnlinePlaylist>>;
pub async fn playlist_detail(ctx: &Ctx, id: &str, offset: usize, limit: usize)
    -> ApiResult<super::PlaylistDetail>;
pub async fn playlist_create(ctx: &Ctx, name: &str) -> ApiResult<super::OnlinePlaylist>;
pub async fn playlist_delete(ctx: &Ctx, id: &str) -> ApiResult<()>;
pub async fn playlist_add(ctx: &Ctx, id: &str,
    tracks: &[super::TrackRef]) -> ApiResult<()>;   // data=歌名|hash|album_id|mixsongid
pub async fn playlist_remove(ctx: &Ctx, id: &str,
    tracks: &[super::TrackRef]) -> ApiResult<()>;   // fileids
pub async fn recommend_songs(ctx: &Ctx) -> ApiResult<super::SearchPage>; // /everyday/recommend
pub async fn qr_start(ctx: &Ctx) -> ApiResult<super::QrStart>;           // 见 spec
pub async fn qr_poll(ctx: &Ctx, platform_ticket: &str)
    -> ApiResult<(String, Option<super::AccountInfo>)>;
```

每个函数实现后立即用 `cargo build -p vmusicd` 消掉类型错误。
未登录的写操作/账号函数第一行：

```rust
let cred = super::cred::get(&ctx.db, ID).await.map_err(internal_store)?
    .filter(|c| !c.userid.is_empty() && c.userid != "0")
    .ok_or_else(|| ApiError::auth_required("请先登录酷狗".into()))?;
```

歌单 id 解析按 spec：`collection_3_{uid}_{listid}_0` 取第 4 段，纯数字直用。
扫码真机若不通，`capability()` 里不给 `QrLogin`（Task 15 统一控制）。

- [ ] **Step 4: 编译检查点**

Run: `cargo build -p vmusicd ; cargo test -p vmusicd kugou`
Expected: 编译通过，夹具测试绿。

- [ ] **Step 5: 提交检查点**

```bash
git add crates/vmusicd/src/online/kugou.rs
git commit -m "feat(kugou): 播放回落、歌词、歌单、账号、推荐与扫码"
```

---

## Task 9: QQ 基座——zzc 签名通道与搜索（TDD）

**Files:**
- Create: `crates/vmusicd/src/online/qq.rs`
- Create: `crates/vmusicd/tests/fixtures/qq_search.json`

端点/comm/zzc/vkey 全部见 **spec §2.2**。

- [ ] **Step 1: 夹具**

`crates/vmusicd/tests/fixtures/qq_search.json`：

```json
{
  "req": {
    "code": 0,
    "data": {
      "body": {
        "item_song": [
          {
            "id": 5257138,
            "mid": "0039MnYb0qxYhV",
            "name": "屋顶",
            "title": "屋顶",
            "duration": 319,
            "file": {"media_mid": "0039MnYb0qxYhV"},
            "singer": [{"id": 6452, "mid": "002J4UUk29y8BY", "name": "周杰伦"}],
            "album": {"id": 88, "mid": "0039MnYb0qxYhA", "name": "男女情歌对唱",
                      "pmid": "0039MnYb0qxYhA"}
          }
        ]
      }
    }
  }
}
```

- [ ] **Step 2: qq.rs 搜索实现**

```rust
// SPDX-License-Identifier: MIT

//! QQ音乐音源。musicu.fcg / musics.fcg(zzc) / vkey，详见 spec §2.2。

use serde_json::json;

use super::sign::qq as qqsign;
use super::{client, ApiError, ApiResult, Ctx, OnlineTrack, SearchPage, SearchQuery};

pub const ID: &str = "qq";
const MUSICU: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const MUSICS: &str = "https://u.y.qq.com/cgi-bin/musics.fcg";
const ANDROID_UA: &str = "QQMusic 14090508(android 12)";
const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

fn sec_to_ms(v: Option<&serde_json::Value>) -> u64 {
    v.and_then(|x| x.as_u64()).unwrap_or(0) * 1000
}

/// item_song 元素可能直接是曲目，也可能包一层 track_info。
fn unwrap_song(item: &serde_json::Value) -> &serde_json::Value {
    item.pointer("/track_info").unwrap_or(item)
}

fn map_track(item: &serde_json::Value) -> OnlineTrack {
    let s = unwrap_song(item);
    let mid = s.get("mid").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let media_mid = s
        .pointer("/file/media_mid")
        .and_then(|v| v.as_str())
        .unwrap_or(&mid)
        .to_string();
    let artist = s
        .pointer("/singer")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
                .collect::<Vec<_>>()
                .join(" / ")
        })
        .unwrap_or_default();
    let album = s
        .pointer("/album/name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let vip = s
        .pointer("/pay/payplay")
        .and_then(|v| v.as_i64())
        .map(|n| n == 1)
        .unwrap_or(false);
    OnlineTrack {
        source: ID.into(),
        id: mid.clone(),
        title: s
            .get("name")
            .or_else(|| s.get("title"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知曲目")
            .to_string(),
        artist,
        album,
        duration_ms: sec_to_ms(s.get("interval").or_else(|| s.get("duration"))),
        cover: Some(format!("https://y.qq.com/music/photo_new/T002M300x300M000{media_mid}.jpg")),
        playable: !mid.is_empty(),
        vip_only: vip,
        track_ref: json!({ "song_mid": mid, "media_mid": media_mid }),
    }
}

fn android_comm() -> serde_json::Value {
    json!({
        "ct":"11","cv":"14090508","v":"14090508","tmeAppID":"qqmusic",
        "phonetype":"EBG-AN10","os_ver":"12","OpenUDID":"0","QIMEI36":"0",
        "udid":"0","chid":"0","aid":"0","oaid":"0","taid":"0","tid":"0",
        "wid":"0","uid":"0","sid":"0","modeSwitch":"6","teenMode":"0",
        "ui_mode":"2","nettype":"1020"
    })
}

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let keyword = q.q.as_deref().unwrap_or("").trim();
    if keyword.is_empty() {
        return Err(ApiError::bad_request("需要给出搜索关键词"));
    }
    let limit = q.limit.clamp(1, 30);
    let page = q.offset / limit + 1;
    let payload = json!({
        "comm": android_comm(),
        "req": {
            "module": "music.search.SearchCgiService",
            "method": "DoSearchForQQMusicMobile",
            "param": {
                "search_type": 0,
                "searchid": format!("{}{}", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
                    q.offset),
                "query": keyword,
                "page_num": page,
                "num_per_page": limit,
                "highlight": 0, "nqc_flag": 0, "multi_zhida": 0,
                "cat": 2, "grp": 1, "sin": q.offset, "sem": 0
            }
        }
    });
    let body_text = serde_json::to_string(&payload).unwrap();
    let sign = qqsign::zzc_sign(&body_text);
    let url = format!("{MUSICS}?sign={sign}");
    let resp = client()?
        .post(url)
        .header("User-Agent", ANDROID_UA)
        .header("Content-Type", "application/json")
        .body(body_text)
        .send()
        .await
        .map_err(|e| ApiError::upstream_timeout(format!("连接 QQ 音乐失败: {e}")))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| {
        ApiError::upstream_rejected(format!("QQ 音乐响应解析失败: {e}"))
    })?;
    let tracks = body
        .pointer("/req/data/body/item_song")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(map_track).filter(|t| !t.id.is_empty()).collect())
        .unwrap_or_default();
    Ok(SearchPage {
        source: ID.into(),
        keyword: keyword.to_string(),
        total: tracks.len(),
        tracks,
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_normalizes_item_song() {
        let b: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/qq_search.json")).unwrap();
        let arr = b.pointer("/req/data/body/item_song").unwrap().as_array().unwrap();
        let t = map_track(&arr[0]);
        assert_eq!(t.id, "0039MnYb0qxYhV");
        assert_eq!(t.title, "屋顶");
        assert_eq!(t.artist, "周杰伦");
        assert_eq!(t.duration_ms, 319_000);
        assert_eq!(t.track_ref["media_mid"], "0039MnYb0qxYhV");
    }
}
```

- [ ] **Step 3: 跑测试**

Run: `cargo test -p vmusicd qq`
Expected: 夹具测试 PASS。

- [ ] **Step 4: 提交检查点**

```bash
git add crates/vmusicd/src/online/qq.rs crates/vmusicd/tests/fixtures/qq_search.json
git commit -m "feat(qq): zzc 签名通道、搜索与归一化"
```

---

## Task 10–11: QQ vkey 播放、歌词、歌单、登录

**Files:** `crates/vmusicd/src/online/qq.rs`（继续）

对照 **spec §2.2**：musicu.fcg 通用 POST（comm ct24/ct19+authst）、
vkey 五档 filename、歌词 Base64、歌单 CGI、ptqrshow/ptqrlogin 扫码。

- [ ] **Step 1: 通用 CGI 调用**

```rust
async fn cgi(
    ctx: &Ctx,
    body: serde_json::Value,
) -> ApiResult<serde_json::Value> {
    let pack = super::cred::get(&ctx.db, ID).await.map_err(store_err)?;
    let cred = pack.unwrap_or_default();
    let text = serde_json::to_string(&body).unwrap();
    let mut req = client()?
        .post(MUSICU)
        .header("User-Agent", DEFAULT_UA)
        .header("Content-Type", "application/json;charset=UTF-8")
        .header("Referer", "https://y.qq.com/");
    if !cred.cookie.is_empty() {
        req = req.header("Cookie", &cred.cookie);
    }
    let resp = req
        .body(text)
        .send()
        .await
        .map_err(|e| ApiError::upstream_timeout(format!("QQ CGI 失败: {e}")))?;
    resp.json().await.map_err(|e| {
        ApiError::upstream_rejected(format!("QQ CGI 响应解析失败: {e}"))
    })
}

fn store_err(e: vmusic_core::StoreError) -> ApiError {
    ApiError::internal(format!("设置存储失败: {e}"))
}
```

- [ ] **Step 2: vkey 播放（含五档回落）**

```rust
const QUALITIES: &[(&str, &str, u32)] = &[
    ("RS01", ".flac", 700_000), // Hi-Res
    ("F000", ".flac", 700_000), // 无损
    ("M800", ".mp3", 320_000),
    ("M500", ".mp3", 128_000),
    ("C400", ".m4a", 96_000),
];

pub async fn stream(ctx: &Ctx, id: &str, quality: u32) -> ApiResult<super::StreamInfo> {
    let pack = super::cred::get(&ctx.db, ID).await.map_err(store_err)?;
    let cred = pack.unwrap_or_default();
    let guid = ensure_guid(ctx).await?;
    // id 即 songmid；media_mid 优先从 track_ref 取不到时与 songmid 相同。
    let media = id;

    // 从用户请求码率起向低档回落
    let start = QUALITIES
        .iter()
        .position(|(_, _, bps)| quality >= *bps)
        .unwrap_or(QUALITIES.len() - 1);

    let uin = if cred.uin.is_empty() { "0".to_string() } else { cred.uin.clone() };
    let authst = super::cred::cookie_field(&cred.cookie, "qm_keyst").unwrap_or("");

    for (prefix, ext, _bps) in &QUALITIES[start..] {
        let filename = format!("{prefix}{media}{ext}");
        let mut comm = json!({"uin": uin, "format":"json", "cv":0,
            "ct": if authst.is_empty() {24} else {19}});
        if !authst.is_empty() {
            comm["authst"] = json!(authst);
        }
        let body = json!({
            "comm": comm,
            "req_0": {
                "module": "vkey.GetVkeyServer",
                "method": "CgiGetVkey",
                "param": {
                    "guid": guid,
                    "songmid": [id],
                    "songtype": [0],
                    "uin": uin,
                    "loginflag": 1,
                    "platform": "20",
                    "filename": [filename]
                }
            }
        });
        let j = cgi(ctx, body).await?;
        let data = j.pointer("/req_0/data");
        let purl = data
            .and_then(|d| d.pointer("/midurlinfo/0/purl"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !purl.is_empty() {
            let sip = data
                .and_then(|d| d.pointer("/sip/0"))
                .and_then(|v| v.as_str())
                .unwrap_or("https://ws.stream.qqmusic.qq.com/");
            return Ok(super::StreamInfo {
                url: format!("{sip}{purl}"),
                source: ID.into(),
                id: id.to_string(),
                bitrate: Some(quality as u64),
                expires_in_secs: None,
            });
        }
    }
    Err(if authst.is_empty() {
        ApiError::auth_required("QQ 音乐需要登录后获取该曲目".into())
    } else {
        ApiError::vip_required("该曲目为 VIP 专享或无可用音质".into())
    })
}

async fn ensure_guid(ctx: &Ctx) -> ApiResult<String> {
    if let Some(g) = super::cred::get_device(&ctx.db, ID).await.map_err(store_err)? {
        return Ok(g);
    }
    // 8 位随机数字（不引 rand：用 uuid 数字段折叠）
    let mut g = 10_000_000u64
        + (u128::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..16].try_into().unwrap())
            % 90_000_000) as u64;
    if g >= 100_000_000 { g = 99_999_999; }
    let g = g.to_string();
    let _ = super::cred::set_device(&ctx.db, ID, &g).await;
    Ok(g)
}
```

- [ ] **Step 3: 歌词、详情**

```rust
pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    let body = json!({
        "comm": json!({"ct":24,"cv":0}),
        "lyric": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": {"songMID": id, "songID": 0}
        }
    });
    let j = cgi(ctx, body).await?;
    let b64 = j.pointer("/lyric/data/lyric").and_then(|v| v.as_str());
    let Some(b64) = b64 else { return Ok(vmusic_core::LyricDocument::empty()); };
    // QQ 的 lyric 字段是 base64（同酷狗解码工具的做法，这里在 qq 模块内提供
    // 同样的小解码器，或抽到 sign.rs 旁的 base64 公共件——二选一，不引依赖）。
    let bytes = b64_decode(b64).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).to_string();
    if text.trim().is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }
    let mut doc = vmusic_lyrics::parse_lrc(&text);
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(doc)
}

pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<super::OnlineDetail> {
    let body = json!({
        "comm": json!({"ct":24,"cv":0}),
        "songinfo": {
            "module": "music.pf_song_detail_svr",
            "method": "get_song_detail_yqq",
            "param": {"song_mid": id}
        }
    });
    let j = cgi(ctx, body).await?;
    let t = map_track(j.pointer("/songinfo/data/track_info").unwrap_or(&json!({})));
    Ok(super::OnlineDetail {
        source: ID.into(),
        id: id.to_string(),
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration_ms: t.duration_ms,
        cover: t.cover,
    })
}
```

`b64_decode` 从 kugou 模块抽到 `online/mod.rs` 作为 `pub(crate)` 工具，
两个平台共用（DRY）。

- [ ] **Step 4: 歌单/账号/推荐/写操作/扫码**

按 spec §2.2 表实现：`account / playlists / playlist_detail /
playlist_create / playlist_delete / playlist_add / playlist_remove /
recommend_songs / recommend_playlists / qr_start / qr_poll`，
全部用 `cgi()`；写操作 comm 带 authst。扫码按 spec 的 ptqrshow→gtk33
（Task 2 已实现 `qqsign::gtk33`）→ptqrlogin 流程，需要独立的 reqwest
`ClientBuilder::cookie_store(true)` + 每平台 Jar（Jar 内容序列化为 cookie
字符串存 CredPack）。真机不通则能力位不给 QrLogin。

- [ ] **Step 5: 编译检查点**

Run: `cargo build -p vmusicd ; cargo test -p vmusicd qq`
Expected: 编译通过，测试绿。

- [ ] **Step 6: 提交检查点**

```bash
git add crates/vmusicd/src/online/qq.rs crates/vmusicd/src/online/mod.rs
git commit -m "feat(qq): vkey 播放回落、歌词、歌单、账号、扫码"
```

---

## Task 12: 网易云扩展——账号、歌单读、二维码、写操作、推荐

**Files:** `crates/vmusicd/src/online/netease.rs`

端点见 **spec §2.1**。现有 search/stream/detail/lyric 保持不变，新增：

- [ ] **Step 1: 账号与歌单读**

```rust
const W: &str = "https://music.163.com";

async fn authed_get(ctx: &Ctx, path: &str) -> ApiResult<serde_json::Value> {
    let cookie = ctx.cookie(ID).await;
    let mut req = client()?
        .get(format!("{W}{path}"))
        .header("Referer", W)
        .header("Accept", "application/json");
    if let Some(c) = &cookie { req = req.header("Cookie", c); }
    let j: serde_json::Value = req.send().await
        .map_err(|e| ApiError::upstream_timeout(format!("网易云连接失败: {e}")))?
        .json().await.map_err(|e| ApiError::upstream_rejected(e.to_string()))?;
    if j.get("code").and_then(|c| c.as_i64()) != Some(200) {
        return Err(ApiError::upstream_rejected("网易云拒绝了该请求".into()));
    }
    Ok(j)
}

pub async fn account(ctx: &Ctx) -> ApiResult<super::AccountInfo> {
    let j = authed_get(ctx, "/api/nuser/account/get").await?;
    let p = j.pointer("/profile").ok_or_else(||
        ApiError::auth_required("网易云未登录".into()))?;
    Ok(super::AccountInfo {
        source: ID.into(),
        nickname: p.get("nickname").and_then(|v| v.as_str()).unwrap_or("").into(),
        avatar: p.get("avatarUrl").and_then(|v| v.as_str()).map(str::to_string),
        vip_level: p.pointer("/vipType").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        vip_label: if p.pointer("/vipType").and_then(|v| v.as_i64()).unwrap_or(0) > 0
            { "VIP".into() } else { String::new() },
    })
}
```

歌单列表 `/api/user/playlist`、详情 `/api/v6/playlist/detail`（超 1000 首用
`/api/v6/playlist/track/all`，见 spec）按相同 `authed_get` 实现，归一化到
`OnlinePlaylist`/`PlaylistDetail`，曲目用现有 `netease_track` 映射。

- [ ] **Step 2: 二维码登录**

网易云只返回文本（unikey），`qr_text` 给前端渲染，不需 cookie jar：

```rust
pub async fn qr_start(ctx: &Ctx) -> ApiResult<super::QrStart> {
    let j = authed_get(ctx, "/api/login/qrcode/unikey").await?;
    let key = j.get("unikey").and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::upstream_rejected("取二维码 key 失败".into()))?;
    Ok(super::QrStart {
        ticket: key.to_string(),           // 网易直接用 unikey 作 platform_ticket
        qr_text: Some(format!("{W}/login?codekey={key}")),
        qr_image: None,
        poll_ms: 2000,
    })
}

/// 返回 (state, account?)。803 时上游 Set-Cookie 含 MUSIC_U——网易云网页接口
/// 的确认响应在 JSON body 里同时带 set-cookie 不可靠，因此这里用 reqwest 的
/// cookie_store：网易云模块持有独立 Jar，确认后序列化整罐 cookie 入库。
pub async fn qr_poll(ctx: &Ctx, key: &str)
    -> ApiResult<(String, Option<super::AccountInfo>)> {
    let path = format!("/api/login/qrcode/client/login?key={key}&type=1");
    let j = authed_get(ctx, &path).await?;
    let code = j.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    let state = match code {
        801 => "waiting",
        802 => "scanned",
        803 => "confirmed",
        800 => "expired",
        _ => "waiting",
    };
    if state == "confirmed" {
        // 用启用了 cookie_store 的独立客户端再打一次需要登录的接口，
        // Jar 中的 MUSIC_U 序列化后写 cred（实现时把 cookie 串从 Jar headers
        // 提取，参考 reqwest cookie_store 的 cookies(&url)）。
        save_confirmed_cookie(ctx).await?;
        return Ok((state.to_string(), Some(account(ctx).await?)));
    }
    Ok((state.to_string(), None))
}
```

`save_confirmed_cookie`：为网易云建 `ClientBuilder::cookie_store(true)`
客户端（存在 `once_cell::sync::Lazy<Mutex<...>>` 或 AppState），确认后从
`cookie_store` 读 `music.163.com` 的全部 cookie 拼成 `MUSIC_U=..; __csrf=..`
写 `cred::put`。这是本计划中唯一需要在 Task 17 把每平台 Jar 挂进 AppState
的原因——实现时统一在 AppState 加
`pub qq_jar / kugou_jar / netease_jar: Arc<cookie::Jar>` 与
`cookie_provider()`，各源 http 客户端用
`ClientBuilder::new().cookie_provider(jar.clone())`。

- [ ] **Step 3: 写操作（POST 表单 + csrf）与推荐**

```rust
async fn authed_post(ctx: &Ctx, path: &str, form: &[(&str, &str)])
    -> ApiResult<serde_json::Value> {
    let cookie = ctx.cookie(ID).await.ok_or_else(||
        ApiError::auth_required("请先登录网易云".into()))?;
    let csrf = super::cred::cookie_field(&cookie, "__csrf").unwrap_or("");
    let client = client()?;
    let mut pairs = form.to_vec();
    pairs.push(("csrf_token", csrf));
    let url = if path.contains('?') {
        format!("{W}{path}&csrf_token={csrf}")
    } else {
        format!("{W}{path}?csrf_token={csrf}")
    };
    let j: serde_json::Value = client.post(url)
        .header("Referer", W)
        .header("Cookie", &cookie)
        .form(&pairs)
        .send().await.map_err(|e| ApiError::upstream_timeout(e.to_string()))?
        .json().await.map_err(|e| ApiError::upstream_rejected(e.to_string()))?;
    Ok(j)
}

pub async fn like(ctx: &Ctx, id: &str, liked: bool) -> ApiResult<()> {
    let j = authed_post(ctx, "/api/song/like",
        &[("trackId", id), ("like", if liked {"true"} else {"false"})]).await?;
    if j.get("code").and_then(|c| c.as_i64()) == Some(200) { Ok(()) }
    else { Err(ApiError::upstream_rejected("红心操作失败".into())) }
}
```

`playlist_create/delete/playlist_add/playlist_remove` 按 spec §2.1 的
`/api/playlist/create|delete` 与
`/api/playlist/manipulate/tracks`（op/trackIds JSON 数组）同形态实现。
推荐：`recommend_playlists` → `/api/personalized/playlist`（免登录，
authed_get 的 cookie 可空，故把 account 式强校验与推荐式匿名封装分开）；
`recommend_songs` → `/api/v3/discovery/recommendSongs`（需登录）。

- [ ] **Step 4: 编译与测试**

Run: `cargo build -p vmusicd ; cargo test -p vmusicd online`
Expected: 全绿。

- [ ] **Step 5: 提交检查点**

```bash
git add crates/vmusicd/src/online/netease.rs
git commit -m "feat(netease): 账号、歌单、扫码登录、写操作与推荐"
```

---

## Task 13: 注册表 dispatch 与能力位总装

**Files:** `crates/vmusicd/src/online/mod.rs`

- [ ] **Step 1: 注册模块与补全 caps**

`mod qq; mod kugou;`（netease/ccmixter 已在）。把 SOURCES 三条新能力补齐：

```rust
    SourceInfo {
        id: "netease", label: "网易云音乐", cats: netease::CATS,
        supports_cookie: true,
        caps: &[
            Capability::CookieLogin, Capability::QrLogin,
            Capability::UserPlaylists, Capability::PlaylistDetail,
            Capability::PlaylistWrite, Capability::Like,
            Capability::RecommendSongs, Capability::RecommendPlaylists,
            Capability::HighQuality,
        ],
    },
    SourceInfo {
        id: "qq", label: "QQ音乐", cats: &[],
        supports_cookie: true,
        // QrLogin 真机验证通过后加入；不通过则保持不含。
        caps: &[
            Capability::CookieLogin, Capability::UserPlaylists,
            Capability::PlaylistDetail, Capability::PlaylistWrite,
            Capability::Like, Capability::RecommendPlaylists,
            Capability::HighQuality,
        ],
    },
    SourceInfo {
        id: "kugou", label: "酷狗音乐", cats: &[],
        supports_cookie: true,
        caps: &[
            Capability::CookieLogin, Capability::UserPlaylists,
            Capability::PlaylistDetail, Capability::PlaylistWrite,
            Capability::Like, Capability::RecommendSongs,
            Capability::RecommendPlaylists, Capability::HighQuality,
        ],
    },
```

- [ ] **Step 2: dispatch 函数**

search/stream/detail/lyric 的 match 加 `qq`/`kugou` 分支；新增总入口：

```rust
pub async fn playlists(ctx: &Ctx, source: &str, scope: &str,
    offset: usize, limit: usize) -> ApiResult<Vec<OnlinePlaylist>> {
    match source {
        "netease" => netease::playlists(ctx, scope, offset, limit).await,
        "qq" => qq::playlists(ctx, scope, offset, limit).await,
        "kugou" => kugou::playlists(ctx, scope, offset, limit).await,
        other => unsupported(other),
    }
}
// playlist_detail / playlist_create / playlist_delete /
// playlist_add / playlist_remove / like / account /
// recommend_songs / recommend_playlists 同形态逐一转发。

pub async fn search_all(ctx: &Ctx, query: &str, limit: usize) -> AggregateSearch {
    let sources: Vec<String> = SOURCES.iter().map(|s| s.id.to_string()).collect();
    aggregate::collect(&sources.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        query, limit,
        |src, q| {
            let ctx = ctx.clone();
            Box::pin(async move {
                search(&ctx, q).await.map_err(|e| (e.code.to_string(), e.message))
            })
        },
        std::time::Duration::from_secs(6),
    ).await
}
```

`fn unsupported(other: &str) -> ApiResult<T>` 用一个泛型小函数返回
`ApiError::capability_unsupported`。

- [ ] **Step 3: 扩展契约测试**

在 mod.rs tests 的 `every_source_is_dispatchable_and_described` 旁加：

```rust
#[test]
fn caps_only_reference_registered_sources() {
    for s in SOURCES { assert!(find(s.id).is_some()); }
    assert!(find("netease").unwrap().caps.contains(&Capability::Like));
}
```

- [ ] **Step 4: 编译测试**

Run: `cargo test -p vmusicd online ; cargo clippy -p vmusicd -- -D warnings`
Expected: 全绿。

- [ ] **Step 5: 提交检查点**

```bash
git add crates/vmusicd/src/online/mod.rs
git commit -m "feat(online): 三平台 dispatch 总装与能力位"
```

---

## Task 14: routes.rs 新端点接线

**Files:** `crates/vmusicd/src/routes.rs`、`crates/vmusicd/src/state.rs`（qr/熔断）

- [ ] **Step 1: AppState 加 qr 注册表**

state.rs 的 AppState 加字段（Task 12 的 Jar 也在此一并加）：

```rust
    pub qr: Arc<crate::online::qr::Registry>,
```

main.rs 构造 AppState 处补 `qr: crate::online::qr::Registry::new()`。

- [ ] **Step 2: 注册路由**

在 router() 的 online 路由区（第 75-81 行）追加：

```rust
        .route("/v1/online/playlists", get(online_playlists))
        .route("/v1/online/playlist", get(online_playlist)
            .post(online_playlist_create).delete(online_playlist_delete))
        .route("/v1/online/playlist/tracks/add", post(online_playlist_add))
        .route("/v1/online/playlist/tracks/remove", post(online_playlist_remove))
        .route("/v1/online/like", post(online_like))
        .route("/v1/online/recommend/songs", get(online_rec_songs))
        .route("/v1/online/recommend/playlists", get(online_rec_playlists))
        .route("/v1/online/search/all", get(online_search_all))
        .route("/v1/online/qr/start", post(online_qr_start))
        .route("/v1/online/qr/poll", get(online_qr_poll))
        .route("/v1/online/qr/cancel", post(online_qr_cancel))
        .route("/v1/online/account", get(online_account))
```

注意 axum 0.8 同一路径链不同方法：`.get().post().delete()` 链式即可。

- [ ] **Step 3: handler（每个都是薄转发）**

代表性实现（其余同构）：

```rust
#[derive(Deserialize)]
struct PlaylistsQuery { source: String, scope: Option<String>,
    #[serde(default)] offset: usize, #[serde(default="pl_limit")] limit: usize }
fn pl_limit() -> usize { 30 }

async fn online_playlists(State(s): State<Arc<AppState>>,
    Query(q): Query<PlaylistsQuery>)
    -> ApiResult<Json<Vec<online::OnlinePlaylist>>> {
    online::playlists(&online_ctx(&s), &q.source,
        q.scope.as_deref().unwrap_or("created"), q.offset, q.limit.clamp(1,50))
        .await.map(Json)
}

#[derive(Deserialize)]
struct PlaylistQuery { source: String, id: String,
    #[serde(default)] offset: usize, #[serde(default="pl_limit")] limit: usize }
async fn online_playlist(State(s): State<Arc<AppState>>,
    Query(q): Query<PlaylistQuery>) -> ApiResult<Json<online::PlaylistDetail>> {
    online::playlist_detail(&online_ctx(&s), &q.source, &q.id, q.offset, q.limit)
        .await.map(Json)
}

#[derive(Deserialize)]
struct TrackRefs { source: String, id: String,
    tracks: Vec<serde_json::Value> }
async fn online_playlist_add(State(s): State<Arc<AppState>>,
    Json(b): Json<TrackRefs>) -> ApiResult<Json<serde_json::Value>> {
    online::playlist_add(&online_ctx(&s), &b.source, &b.id, &b.tracks).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct LikeReq { source: String, id: String, liked: bool }
async fn online_like(State(s): State<Arc<AppState>>,
    Json(b): Json<LikeReq>) -> ApiResult<Json<serde_json::Value>> {
    online::like(&online_ctx(&s), &b.source, &b.id, b.liked).await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct SearchAll { q: String, #[serde(default="pl_limit")] limit: usize }
async fn online_search_all(State(s): State<Arc<AppState>>,
    Query(q): Query<SearchAll>) -> ApiResult<Json<online::AggregateSearch>> {
    Ok(Json(online::search_all(&online_ctx(&s), q.q.trim(),
        q.limit.clamp(1,30)).await))
}

#[derive(Deserialize)]
struct Src { source: String }
async fn online_qr_start(State(s): State<Arc<AppState>>,
    Json(b): Json<Src>) -> ApiResult<Json<serde_json::Value>> {
    // 平台 start 返回平台握手票 → Registry 换统一 ticket
    let start = online::qr_start(&online_ctx(&s), &b.source).await?;
    let ticket = s.qr.start(&b.source, start.platform_ticket()).await?;
    Ok(Json(json!({"ticket": ticket, "qr_text": start.qr_text,
        "qr_image": start.qr_image, "poll_ms": start.poll_ms})))
}
#[derive(Deserialize)]
struct PollQ { source: String, ticket: String }
async fn online_qr_poll(State(s): State<Arc<AppState>>,
    Query(q): Query<PollQ>) -> ApiResult<Json<online::QrPoll>> {
    let sess = s.qr.take(&q.ticket).await
        .ok_or_else(|| bad_request("二维码已过期，请重新扫码"))?;
    let (state, account) = online::qr_poll(&online_ctx(&s), &q.source,
        &sess.platform_ticket).await?;
    s.qr.update(&q.ticket, &state).await;
    Ok(Json(online::QrPoll { state, account }))
}
```

`online::qr_start/qr_poll` 是 Task 13 dispatch 的一部分（平台模块函数
`qr_start(ctx)->QrStart` 需带平台票：让 `QrStart` 内部增加不序列化的
`platform_ticket: String`，或 dispatch 函数单独返回。实现时给 QrStart 加
`#[serde(skip)] pub platform_ticket: String`）。其余 create/delete/remove/
recommend/account/cancel handler 按上面同构补齐。

- [ ] **Step 4: 扩展 /online/play 支持整盘**

`OnlinePlayRequest` 加 `tracks: Option<Vec<OnlinePlayTrack>>` 与
`index: Option<usize>`，兼容旧单曲。流程：对 `tracks[index]` 取流落盘
（现有逻辑），队列设为全部 `virtual_id(source, t.id)`，cursor=index。
其余曲目在 play_index 现取现播（Task 15）。

- [ ] **Step 5: 凭据过滤更新**

`is_credential` 改为：

```rust
fn is_credential(key: &str) -> bool {
    key.starts_with(online::COOKIE_PREFIX)
        || key.starts_with(online::cred::CRED_PREFIX)
}
```

（`online::COOKIE_PREFIX` 现为旧前缀常量，保留。）

- [ ] **Step 6: 编译 + 冒烟**

Run: `cargo build -p vmusicd`
Expected: 通过。

- [ ] **Step 7: 提交检查点**

```bash
git add crates/vmusicd/src/routes.rs crates/vmusicd/src/state.rs crates/vmusicd/src/main.rs
git commit -m "feat(api): 在线歌单/登录/推荐/聚合 13 个端点"
```

---

## Task 15: state.rs 在线虚拟 id 现取现播

**Files:** `crates/vmusicd/src/state.rs`

- [ ] **Step 1: 改 play_index 的在线分支**

替换 `state.rs` 第 101-110 行的在线分支为：

```rust
        let path = if let Some((source, id)) = crate::online::split_virtual_id(&track_id) {
            let cached = self
                .online_cache_dir()
                .join(crate::online::cache_name(&source, &id));
            if cached.exists() && std::fs::metadata(&cached).map(|m| m.len() > 1024).unwrap_or(false) {
                cached
            } else {
                // 缓存缺失：现取 URL → 落盘。失败向上传播，由调用方/事件泵
                // 决定跳曲，前端按错误码引导登录。
                let ctx = crate::online::Ctx { db: self.db.clone() };
                let info = crate::online::stream(&ctx, &source, &id, 320_000).await
                    .map_err(|e| vmusic_core::CoreError::NotFound(e.message))?;
                crate::online::fetch_to_cache(
                    &self.online_cache_dir(), &source, &id, &info.url,
                ).await.map_err(|e| vmusic_core::CoreError::NotFound(e.message))?
            }
        } else {
```

`CoreError::NotFound(String)` 已存在（state.rs 别处在用）。取流失败时
`spawn_event_pump` 的自动推进（state.rs:204）已会记录并继续，前端额外依赖
现有 `/v1/player/next` 容错；不新增错误事件类型（错误 message 经
`CoreError` 不上 WS，故在 play_index 失败处补一次 publish）：

```rust
        // 在 step() 的 Err 分支（state.rs:204）已有 tracing；为让前端可见，
        // 在 play_index 在线取流失败时 publish 一条 Error：
        // （在上面 map_err 闭包内，先 publish 再返回 NotFound）
```

实现时把在线分支的错误先 `self.publish(WsEvent::Error { message: e.message.clone() })`
再返回，避免改动 CoreError 类型。

- [ ] **Step 2: NullBackend 手动验证状态机**

Run: `cargo test -p vmusicd`（现有测试不回归）
Expected: 全绿。

- [ ] **Step 3: 提交检查点**

```bash
git add crates/vmusicd/src/state.rs
git commit -m "feat(player): 在线队列虚拟 id 缓存缺失时现取现播"
```

---

## Task 16: 前端资源接线与二维码 vendor

**Files:** `crates/vmusicd/src/main.rs`、`crates/vmusicd/web/index.html`、
`crates/vmusicd/web/vendor/qrcode.js`

- [ ] **Step 1: vendor qrcode-generator**

从 MIT 项目 qrcode-generator（Kazuhiko Arase，MIT）取其单文件
`qrcode.js`（紧凑版，约 20KB），保存到
`crates/vmusicd/web/vendor/qrcode.js`，文件顶部保留其 MIT 许可注释。
NOTICE 记录署名。对外暴露全局 `qrcode`（其默认 UMD 形态在无模块环境下挂
`window.qrcode`）。

- [ ] **Step 2: main.rs 加常量与路由**

在现有 include_str! 区加 4 条（vendor 路径 `../web/vendor/qrcode.js`）：

```rust
const QRCCODE_JS: &str = include_str!("../web/vendor/qrcode.js");
const ONLINE_LOGIN_JS: &str = include_str!("../web/online-login.js");
const ONLINE_JS: &str = include_str!("../web/online.js");
const ONLINE_PLAYLISTS_JS: &str = include_str!("../web/online-playlists.js");
const ONLINE_CSS: &str = include_str!("../web/online.css");
```

路由区加对应 `.route("/vendor/qrcode.js", ...)` 等 5 条（MIME：JS/CSS）。

- [ ] **Step 3: index.html 引用**

在现有脚本区，`app.js` 之前按序加：

```html
<link rel="stylesheet" href="online.css">
<script src="vendor/qrcode.js"></script>
<script src="online-login.js"></script>
<script src="online.js"></script>
<script src="online-playlists.js"></script>
```

- [ ] **Step 4: 先放空文件保证接线绿**

先创建 4 个空文件（online-login.js/online.js/online-playlists.js/online.css
各放一行文件头注释），`cargo build` 后跑资源检查：

Run: `node scripts/check-assets.js`
Expected: 新文件三方对账通过。

- [ ] **Step 5: 提交检查点**

```bash
git add crates/vmusicd/src/main.rs crates/vmusicd/web/index.html crates/vmusicd/web/vendor/ crates/vmusicd/web/online*.js crates/vmusicd/web/online.css
git commit -m "feat(web): 接线在线模块与 MIT 二维码库"
```

---

## Task 17: online-login.js 扫码登录

**Files:** `crates/vmusicd/web/online-login.js`、`crates/vmusicd/web/index.html`（弹窗骨架）

- [ ] **Step 1: index.html 加弹窗 DOM**

在 body 末尾加：

```html
<div id="qr-modal" class="qr-modal" hidden>
  <div class="qr-card glass">
    <button id="qr-close" class="qr-close" aria-label="关闭">×</button>
    <div id="qr-title" class="qr-title">扫码登录</div>
    <div id="qr-canvas" class="qr-canvas"></div>
    <div id="qr-status" class="qr-status">请使用手机扫码</div>
    <details class="qr-cookie-fallback">
      <summary>手动粘贴 cookie</summary>
      <textarea id="qr-cookie-input" rows="3" placeholder="粘贴该平台的完整 cookie"></textarea>
      <button id="qr-cookie-save">保存</button>
    </details>
  </div>
</div>
```

- [ ] **Step 2: online-login.js 状态机（完整）**

```javascript
// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  var T = window.VMusicTransport;
  var pollTimer = null;
  var currentSource = null;

  function el(id) { return document.getElementById(id); }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function renderQr(start) {
    var box = el('qr-canvas');
    box.innerHTML = '';
    if (start.qr_image) {
      var img = new Image();
      img.src = start.qr_image;
      img.alt = '登录二维码';
      box.appendChild(img);
    } else if (start.qr_text && window.qrcode) {
      var qr = window.qrcode(0, 'M');
      qr.addData(start.qr_text);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }
    schedulePoll(currentSource, start.ticket, start.poll_ms || 2000);
  }

  function schedulePoll(source, ticket, ms) {
    stopPolling();
    pollTimer = setTimeout(function () { poll(source, ticket, ms); }, ms);
  }

  async function poll(source, ticket, ms) {
    var p;
    try {
      p = await T.get('/v1/online/qr/poll?source=' + encodeURIComponent(source)
        + '&ticket=' + encodeURIComponent(ticket));
    } catch (e) {
      el('qr-status').textContent = '网络异常，重试中…';
      schedulePoll(source, ticket, 3000);
      return;
    }
    if (p.state === 'waiting') {
      el('qr-status').textContent = '请使用手机扫码';
      schedulePoll(source, ticket, ms);
    } else if (p.state === 'scanned') {
      el('qr-status').textContent = '已扫码，请在手机上确认';
      schedulePoll(source, ticket, ms);
    } else if (p.state === 'confirmed') {
      stopPolling();
      el('qr-status').textContent = '登录成功';
      close();
      if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
    } else if (p.state === 'expired') {
      stopPolling();
      el('qr-status').textContent = '二维码已过期';
      el('qr-canvas').style.opacity = '.4';
      el('qr-canvas').onclick = function () { start(source); };
    }
  }

  async function start(source) {
    currentSource = source;
    el('qr-title').textContent = source + ' 扫码登录';
    el('qr-status').textContent = '正在生成二维码…';
    el('qr-canvas').style.opacity = '1';
    el('qr-canvas').onclick = null;
    el('qr-modal').hidden = false;
    var s;
    try {
      s = await T.post('/v1/online/qr/start', { source: source });
    } catch (e) {
      el('qr-status').textContent = '该平台暂不支持扫码，请用 cookie 登录';
      return;
    }
    renderQr(s);
  }

  function close() {
    stopPolling();
    el('qr-modal').hidden = true;
    if (currentSource) {
      T.post('/v1/online/qr/cancel', { source: currentSource, ticket: '' }).catch(function () {});
    }
    currentSource = null;
  }

  el('qr-close').onclick = close;
  el('qr-cookie-save').onclick = async function () {
    var source = currentSource;
    var cookie = el('qr-cookie-input').value.trim();
    if (!source || !cookie) return;
    await T.post('/v1/online/cookie', { source: source, cookie: cookie });
    close();
    if (window.OnlinePlaylists) window.OnlinePlaylists.refresh();
  };

  window.OnlineLogin = { start: start, close: close, stopPolling: stopPolling };
})();
```

- [ ] **Step 3: 样式（online.css，仅用现有令牌）**

```css
.qr-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;
  justify-content:center;background:rgba(0,0,0,.55)}
.qr-modal[hidden]{display:none}
.qr-card{position:relative;width:320px;max-width:86vw;padding:28px 24px;border-radius:20px;
  text-align:center}
.qr-close{position:absolute;top:10px;right:14px;border:0;background:transparent;
  font-size:22px;cursor:pointer;color:var(--text,#eee)}
.qr-canvas{margin:14px auto;min-height:180px;display:flex;align-items:center;
  justify-content:center;cursor:pointer}
.qr-canvas svg,.qr-canvas img{width:180px;height:180px;border-radius:8px;background:#fff;padding:6px}
.qr-status{margin-bottom:10px;font-size:14px}
.qr-cookie-fallback{margin-top:8px;text-align:left;font-size:12px;opacity:.85}
.qr-cookie-fallback textarea{width:100%;box-sizing:border-box}
```

令牌只用项目已有的玻璃/文字变量；若 `--text` 不存在，改用 `style.css` 里
实际的正文色变量名（实施时 grep `:root` 确认）。

- [ ] **Step 4: 提交检查点**

```bash
git add crates/vmusicd/web/online-login.js crates/vmusicd/web/online.css crates/vmusicd/web/index.html
git commit -m "feat(web): 扫码登录弹窗与 cookie 兜底"
```

---

## Task 18: online.js——迁移在线逻辑、All、整盘播放

**Files:** `crates/vmusicd/web/online.js`、`crates/vmusicd/web/app.js`

- [ ] **Step 1: 迁出 app.js 在线代码**

把 app.js 中 1828–2050 行区间的在线搜索/播放/歌词相关函数
（onlineState、sourceLabel、onlineMeta、onlineRow、renderOnline、
searchOnline、safeCoverUrl、playOnline、loadOnlineLyrics、
markOnlineUnplayable、音源清单加载）整体迁入 online.js 的 IIFE，
挂到 `window.Online`，app.js 删除这些代码并把调用点改为
`window.Online.*`。`VMusicTransport` 已由 app.js 挂到 window，
online.js 在其后加载可直接读。

- [ ] **Step 2: 平台徽标与 VIP 行**

`onlineRow` 内 `.t-quality` 位置渲染平台徽标：

```javascript
var SOURCE_BADGE = { netease: ['网易', '#e60026'], qq: ['QQ', '#12b7f5'],
  kugou: ['酷狗', '#2ca5f0'] };
function badge(source) {
  var b = SOURCE_BADGE[source];
  if (!b) return document.createTextNode(source);
  var s = document.createElement('span');
  s.className = 'src-badge';
  s.textContent = b[0];
  s.style.setProperty('--badge', b[1]);
  return s;
}
```

`track.vip_only` 时行加 `is-disabled`、徽标旁加「VIP」角标，点击 toast
「该曲目为 VIP 专享」。

- [ ] **Step 3: All 聚合渲染**

searchOnline 检测 source==='all' 时打 `/v1/online/search/all`：

```javascript
async function searchAll(q) {
  var agg = await T.get('/v1/online/search/all?q=' + encodeURIComponent(q) + '&limit=20');
  body.innerHTML = '';
  agg.results.forEach(function (page) {
    var head = document.createElement('div');
    head.className = 'all-group-head';
    head.appendChild(badge(page.source));
    head.appendChild(document.createTextNode(' · ' + page.total + ' 首'));
    body.appendChild(head);
    page.tracks.forEach(function (t) { body.appendChild(onlineRow(t)); });
  });
  agg.failed.forEach(function (f) {
    var d = document.createElement('div');
    d.className = 'all-failed';
    d.textContent = badgeName(f.source) + ' 暂时不可用：' + f.message;
    body.appendChild(d);
  });
}
```

- [ ] **Step 4: 整盘播放入队**

新增 `playAll(tracks, index)`，POST tracks 数组：

```javascript
async function playAll(tracks, index) {
  var source = tracks[0].source;
  var res = await T.post('/v1/online/play', {
    source: source,
    tracks: tracks.map(function (t) {
      return { id: t.id, title: t.title, artist: t.artist, album: t.album,
        duration_ms: t.duration_ms, cover: t.cover, ref: t.ref || {} };
    }),
    index: index || 0,
  });
  // 用虚拟 id 填充现有队列 UI；元数据整盘缓存进 onlineMeta
  var ids = (res.track_ids || tracks.map(function (t) {
    return 'online:' + t.source + ':' + t.id; }));
  tracks.forEach(function (t, i) {
    onlineMeta.set(ids[i], Object.assign({ id: ids[i], onlineId: t.id }, t));
  });
  window.setStateQueue(ids, ids[index || 0]);
  loadOnlineLyrics(onlineMeta.get(ids[index || 0]));
}
```

`track_ids` 需要后端 /online/play 响应返回（Task 14 补充该字段）。
单曲播放改为 `playAll([track], 0)` 的包装，删除旧 playOnline 分叉。

- [ ] **Step 5: 音源 chips 加 All**

音源清单加载后，若 sources.length≥2，在 chips 最前插入
`{id:'all', label:'All'}`；searchOnline 分流到 searchAll。

- [ ] **Step 6: 浏览器手测搜索/单曲**

启动服务（`cargo run -- --port 0`），打开 UI，切到在线曲库：
单源搜索能出结果、点播放（真机出声在 Task 24 验收，此处先验证请求链路）；
All 出分组。

- [ ] **Step 7: 提交检查点**

```bash
git add crates/vmusicd/web/online.js crates/vmusicd/web/app.js crates/vmusicd/web/online.css
git commit -m "feat(web): 在线模块迁移、All 聚合、平台徽标、整盘播放"
```

---

## Task 19: online-playlists.js——账号区、歌单网格、详情抽屉

**Files:** `crates/vmusicd/web/online-playlists.js`、`crates/vmusicd/web/index.html`、`online.css`

- [ ] **Step 1: index.html 在 #view-online 内加歌单区容器**

```html
<div id="online-plugins">
  <div id="op-accounts" class="op-accounts"></div>
  <div id="op-grid" class="op-grid"></div>
</div>
<aside id="op-drawer" class="op-drawer" hidden>
  <header><button id="op-back">‹</button><div id="op-title"></div></header>
  <div id="op-tracks" class="op-tracks"></div>
  <footer>
    <button id="op-playall">播放全部</button>
    <button id="op-shuffle">随机播放</button>
  </footer>
</aside>
```

- [ ] **Step 2: online-playlists.js（核心结构）**

```javascript
// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  var T = window.VMusicTransport;
  var state = { sources: [], accounts: {}, lists: {}, detailTracks: [] };

  async function loadSources() {
    var data = await T.get('/v1/online/sources');
    state.sources = data.sources.filter(function (s) {
      return s.caps.indexOf('user_playlists') >= 0;
    });
    renderAccounts();
    state.sources.forEach(refreshAccount);
  }

  function renderAccounts() {
    var box = document.getElementById('op-accounts');
    box.innerHTML = '';
    state.sources.forEach(function (s) {
      var card = document.createElement('div');
      card.className = 'op-account glass';
      card.dataset.source = s.id;
      card.innerHTML = '<span class="op-name"></span>'
        + '<button class="op-login">扫码登录</button>'
        + '<button class="op-cookie">cookie</button>';
      card.querySelector('.op-name').textContent = s.label;
      card.querySelector('.op-login').onclick = function () {
        if (s.caps.indexOf('qr_login') < 0) { toast('该平台请用 cookie 登录'); return; }
        window.OnlineLogin.start(s.id);
      };
      card.querySelector('.op-cookie').onclick = function () {
        window.OnlineLogin.start(s.id); /* 弹窗内含 cookie 兜底 */
      };
      box.appendChild(card);
    });
  }

  async function refreshAccount(sourceId) {
    // 同时取账号信息与歌单；401 表示未登录，保留登录按钮
    try {
      var acc = await T.get('/v1/online/account?source=' + sourceId);
      state.accounts[sourceId] = acc;
      paintLoggedIn(sourceId, acc);
    } catch (e) { return; }
    try {
      var lists = await T.get('/v1/online/playlists?source=' + sourceId
        + '&scope=created&limit=30&offset=0');
      state.lists[sourceId] = lists;
      renderGrid();
    } catch (e) {}
  }

  function paintLoggedIn(src, acc) {
    var card = document.querySelector('.op-account[data-source="' + src + '"]');
    if (!card) return;
    card.innerHTML = (acc.avatar ? '<img class="op-avatar">' : '<span class="op-avatar-fallback"></span>')
      + '<div class="op-meta"><div class="op-nick"></div><div class="op-vip"></div></div>'
      + '<button class="op-logout">退出</button>';
    if (acc.avatar) card.querySelector('.op-avatar').src = acc.avatar;
    card.querySelector('.op-nick').textContent = acc.nickname;
    card.querySelector('.op-vip').textContent = acc.vip_label || '';
    card.querySelector('.op-logout').onclick = function () { logout(src); };
  }

  async function logout(src) {
    await T.post('/v1/online/cookie', { source: src, cookie: '' });
    delete state.accounts[src];
    renderAccounts(); state.sources.forEach(refreshAccount);
  }

  function renderGrid() {
    var grid = document.getElementById('op-grid');
    grid.innerHTML = '';
    Object.keys(state.lists).forEach(function (src) {
      state.lists[src].forEach(function (p) {
        var c = document.createElement('div');
        c.className = 'op-card' + (p.kind === 'liked' ? ' is-liked' : '');
        c.innerHTML = '<div class="op-cover"></div><div class="op-pl-name"></div>'
          + '<div class="op-pl-sub"></div>';
        c.querySelector('.op-pl-name').textContent = (p.kind === 'liked' ? '♥ ' : '') + p.name;
        c.querySelector('.op-pl-sub').textContent = p.track_count + ' 首'
          + (p.play_count ? ' · 播放 ' + p.play_count : '');
        if (p.cover) c.querySelector('.op-cover').style
          .backgroundImage = 'url("' + window.Online.safeCover(p.cover) + '")';
        c.onclick = function () { openDetail(src, p); };
        grid.appendChild(c);
      });
    });
  }

  async function openDetail(src, p) {
    var d = await T.get('/v1/online/playlist?source=' + src + '&id='
      + encodeURIComponent(p.id) + '&limit=50&offset=0');
    state.detailTracks = d.tracks.map(function (t) { t.source = src; return t; });
    document.getElementById('op-title').textContent = p.name;
    var box = document.getElementById('op-tracks');
    box.innerHTML = '';
    state.detailTracks.forEach(function (t, i) {
      var row = window.Online.row(t);
      row.appendChild(removeButton(src, p, t, i));
      box.appendChild(row);
    });
    document.getElementById('op-drawer').hidden = false;
    document.getElementById('op-playall').onclick = function () {
      window.Online.playAll(state.detailTracks, 0); };
    document.getElementById('op-shuffle').onclick = function () {
      var shuffled = state.detailTracks.slice().sort(function () { return Math.random() - .5; });
      window.Online.playAll(shuffled, 0); };
  }

  function removeButton(src, p, t) {
    // 仅在 caps 含 playlist_write 时渲染；调 remove 端点后刷新详情
    var b = document.createElement('button');
    b.className = 'op-remove';
    b.textContent = '移除';
    b.onclick = async function (e) {
      e.stopPropagation();
      await T.post('/v1/online/playlist/tracks/remove',
        { source: src, id: p.id, tracks: [t.ref || { id: t.id }] });
      openDetail(src, p);
    };
    return b;
  }

  document.getElementById('op-back').onclick = function () {
    document.getElementById('op-drawer').hidden = true;
  };

  window.OnlinePlaylists = {
    refresh: function () { state = { sources: [], accounts: {}, lists: {}, detailTracks: [] }; loadSources(); },
    init: loadSources,
  };
  document.addEventListener('DOMContentLoaded', loadSources);
})();
```

`window.Online.safeCover` 与 `window.Online.row` 在 Task 18 中导出。
`toast` 复用 app.js 现有 toast（挂 window 或传参）。

- [ ] **Step 3: online.css 补歌单网格/抽屉样式**

用现有 glass 令牌实现：`.op-accounts` flex 横排账号卡；`.op-grid`
`display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px`；
`.op-cover` 150×150 圆角封面；`.op-drawer` 右侧 fixed 滑出
（`transform:translateX` + 过渡，宽 min(420px,90vw)）。

- [ ] **Step 4: 提交检查点**

```bash
git add crates/vmusicd/web/online-playlists.js crates/vmusicd/web/index.html crates/vmusicd/web/online.css
git commit -m "feat(web): 在线账号区、歌单网格与详情抽屉"
```

---

## Task 20: check-online.js 前端契约脚本

**Files:** `scripts/check-online.js`、`.github/workflows/ci.yml`

- [ ] **Step 1: 零依赖契约脚本**

仿 `scripts/check-creative.js` 的桩法：桩 `window`/`document`/`VMusicTransport`/
`setTimeout`（可控时钟），加载 online-login.js 源码后断言：

1. 扫码四态迁移：waiting 重新轮询、scanned 继续、confirmed 停定时器并关闭、
   expired 停轮询且画布可点刷新
2. 关弹窗调用 cancel 并清 timer
3. All 分组：假 transport 返回两 results 一 failed，断言渲染出两个组头与
   失败条
4. caps 驱动：账号源无 `qr_login` 时点扫码给提示而不发 start 请求；
   无 `playlist_write` 时不渲染移除按钮
5. 错误码映射：401 → 调 OnlineLogin.start（用 spy 断言）

脚本结构：

```javascript
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'crates', 'vmusicd', 'web');
let failures = 0, checks = 0;
function ok(cond, label){ checks++; if(!cond){failures++;console.error('  ✗ '+label);} }
// ……桩环境（document: getElementById 返回带 style/onclick/innerHTML 的假节点；
// transport: 可编排的响应队列；clock: 收集 setTimeout 并手动 flush）……
const loginSrc = fs.readFileSync(path.join(WEB, 'online-login.js'), 'utf8');
eval(loginSrc);
// 逐场景断言……
console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
```

目标 ≥40 条断言，全部不触网、不依赖浏览器。

- [ ] **Step 2: 接入 CI 与本地验证**

ci.yml 在现有 check 脚本步骤旁加 `- run: node scripts/check-online.js`。
Run: `node scripts/check-online.js`
Expected: `0 failures`。

- [ ] **Step 3: 提交检查点**

```bash
git add scripts/check-online.js .github/workflows/ci.yml
git commit -m "test(web): 在线登录/聚合/caps 前端契约脚本"
```

---

## Task 21: 冒烟脚本、文档与边界声明

**Files:** `scripts/smoke-online.ps1`、`README.md`、`NOTICE`、
`crates/vmusicd/src/online/mod.rs`（模块注释）

- [ ] **Step 1: smoke-online.ps1**

参数化 base/token，分层输出（进程层由调用方先启动服务）：

```powershell
param([Parameter(Mandatory=$true)][string]$Base,
      [Parameter(Mandatory=$true)][string]$Token)
$H = @{ Authorization = "Bearer $Token" }
# 协议层
$health = Invoke-RestMethod "$Base/v1/health" -Headers $H
if (-not $health.version) { throw "health 失败" }
$sources = Invoke-RestMethod "$Base/v1/online/sources" -Headers $H
$sources.sources | ForEach-Object { "$($_.id) caps=$($_.caps -join ',')" }
# 业务层（每源）：搜索→取 stream→下载前 64KB 校验音频魔数
foreach ($s in 'netease','qq','kugou') {
  $page = Invoke-RestMethod "$Base/v1/online/search?source=$s&q=海阔天空&limit=3" -Headers $H
  $t = $page.tracks | Where-Object { $_.playable } | Select-Object -First 1
  if (-not $t) { Write-Warning "$s 无可播结果"; continue }
  $st = Invoke-RestMethod "$Base/v1/online/stream?source=$s&id=$($t.id)" -Headers $H
  $tmp = [IO.Path]::GetTempFileName()
  Invoke-WebRequest $st.url -OutFile $tmp -Headers @{ Referer = 'https://www.kugou.com/' }
  $bytes = [IO.File]::ReadAllBytes($tmp) | Select-Object -First 4
  $magic = -join ($bytes | ForEach-Object { [char]$_ })
  if ($magic -notmatch 'ID3|ftyp|fLaC') { throw "$s 下载内容不是音频: $magic" }
  Remove-Item $tmp
  Write-Host "$s OK $($t.title)"
}
```

Referer 按源区分（网易 music.163.com / QQ 留空 / 酷狗 www.kugou.com），
实施时按源传不同头。

- [ ] **Step 2: README 与模块注释**

README「在线音源的边界」章节更新为：已支持三平台；新增平台自身客户端签名
（D7 授权说明）；保留红线——不做 DRM 解密、不做账号池、不模拟会员权益。
mod.rs 第 27-32 行的「明确不做的事」注释同步修改。NOTICE 加
qrcode-generator (MIT, Kazuhiko Arase) 署名。

- [ ] **Step 3: 提交检查点**

```bash
git add scripts/smoke-online.ps1 README.md NOTICE crates/vmusicd/src/online/mod.rs
git commit -m "docs(online): 真机冒烟脚本与平台边界声明更新"
```

---

## Task 22: 全量验证与真机验收

- [ ] **Step 1: 自动化全绿**

```powershell
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
node scripts/check-assets.js
node scripts/check-css-tokens.js
node scripts/check-creative.js
node scripts/check-online.js
```

Expected: 全部 0 失败。

- [ ] **Step 2: 真机分层验收（逐平台勾选，结果写入任务记录）**

对 netease / qq / kugou 每平台完成：

1. 匿名搜索出结果
2. `smoke-online.ps1` 该源 stream 下载音频魔数正确
3. 真实手机扫码（或 cookie）登录，/account 回真实昵称
4. 拉到我的歌单列表与详情
5. UI 播放全部实际出声，上/下首正常
6. 红心/加歌后手机官方 App 可见
7. VIP 曲灰显且点击有明确提示

QQ/酷狗扫码若失败：从 caps 移除 `QrLogin`、记录结论、cookie 通道补验，
其余六项仍须通过。

- [ ] **Step 3: 性能/稳定性检查**

- 三平台连续搜索无 panic；任一源断网时 All 聚合 6s 内返回且其余源正常
- 整盘 20 首在线队列顺序播放，缓存缺失自动取流，失败跳曲不卡队列
- 日志中不出现 cookie/token/signature 明文（grep 日志目录验证）

- [ ] **Step 4: 对照 DoD 与 spec §5 逐条勾选，产出验收结论**。

---

## 自审记录

**Spec 覆盖**：spec §1（模块/接缝/模型/API/队列/依赖）→ Task 1-5,13-17；
§2.1 网易 → Task 12；§2.2 QQ → Task 9-11；§2.3 酷狗 → Task 6-8；
§2.4 降级/熔断 → Task 5,13,14,22；§3 前端 → Task 16-20；
§4 测试 → Task 2-5,9,20,22；§5 DoD → Task 21,22；
§6 非目标 → 无任务越界（krc/DRM/账号池/SP2/SP4 均无任务）。

**类型一致性**：`CredPack`/`QrStart`/`QrPoll`/`OnlinePlaylist`/
`PlaylistDetail`/`OnlineTrack.{vip_only,track_ref}` 在 Task 1 定义，
后续任务引用同名同字段；`qr_start/qr_poll` 的 `QrStart.platform_ticket`
（serde skip）在 Task 14 明确补充；StreamInfo 构造字段与 mod.rs 现状一致。

**已知实施时需二次确认项**（不阻塞计划，均为真机/编译细节，非设计空白）：
reqwest cookie_store 的 Jar 挂接（Task 12/14）、酷狗歌单 x-router 确切路径
（Task 8，spec 已给降级）、CSS 令牌实际变量名（Task 17）。
