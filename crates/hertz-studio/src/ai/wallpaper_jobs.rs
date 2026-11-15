// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AI-02 切片 2：壁纸生成的 capability snapshot、generation schema 哈希与
//! quote 内存态（设计 §19.3/§19.4）。
//!
//! - snapshot：服务对「本版本能力 ∩ 已就绪 adapter」产生，`snapshotId` 对
//!   内容字节求 SHA-256；已连接桌面能力的交集随 §19.2 短会话配对切片加入。
//! - schema 哈希：对生成合同的规范描述（版本、输出类别、边界、场景目录
//!   哈希）求 SHA-256；请求携带的 `generationSchemaHash` 不一致即拒绝，
//!   不做静默字段降级。
//! - quote：只做本地编码/计价，不发 provider 网络请求；quoteId 绑定
//!   owner、请求摘要、provider/model/endpoint、凭据代际、价格快照与输出
//!   规格，5 分钟到期；每 owner 最多 8 个、合计 ≤128 KiB、只存内存，
//!   重启即丢。submit 的消费/幂等回放流程在 [`super::jobs`]。

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ai::usage::PricingSnapshot;
use crate::error::ApiError;
use crate::state::AppState;

/// quote 有效期（§19.4）：5 分钟，不静默续期。
pub(crate) const QUOTE_TTL_MS: i64 = 5 * 60_000;
/// 每 owner 未消费 quote 上限（§19.4：最多 8 个）。
pub(crate) const MAX_QUOTES_PER_OWNER: usize = 8;
/// quote 与待提交请求合计字节上限（§19.4：128 KiB）。
pub(crate) const MAX_QUOTE_TOTAL_BYTES: usize = 128 * 1024;

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 生成合同的规范描述与哈希：同一构建内确定，跨版本不兼容即哈希不同。
pub(crate) fn generation_schema_hash() -> String {
    let descriptor = serde_json::json!({
        "version": hertz_wallpaper::generation::GENERATION_REQUEST_VERSION,
        "outputKinds": ["builtin", "composition", "image"],
        "briefMaxBytes": hertz_wallpaper::ai::MAX_BRIEF_BYTES,
        "requestMaxBytes": hertz_wallpaper::generation::MAX_REQUEST_BYTES,
        "outputMaxBytes": hertz_wallpaper::generation::MAX_OUTPUT_BYTES,
        "image": {
            "edgeMax": hertz_wallpaper::generation::MAX_IMAGE_EDGE,
            "pixelsMax": hertz_wallpaper::generation::MAX_IMAGE_PIXELS,
        },
        "artifactBytesMax": hertz_wallpaper::generation::MAX_ARTIFACT_BYTES,
        "sceneRegistryHash": hertz_wallpaper::catalog().registry_hash,
    });
    sha256_hex(&serde_json::to_vec(&descriptor).expect("generation schema descriptor serializes"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputCapability {
    pub kind: &'static str,
    pub provider: String,
    pub model: String,
    pub ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilitySnapshot {
    pub snapshot_id: String,
    pub registry_hash: String,
    pub generation_schema_hash: String,
    pub outputs: Vec<OutputCapability>,
}

/// 服务端产生 capability snapshot（§19.3）：本版本能力（builtin 结构化文本
/// 输出）∩ 已就绪 adapter。snapshotId 对内容字节求哈希，同内容同 id。
pub(crate) async fn capability_snapshot(state: &AppState) -> CapabilitySnapshot {
    let provider = state.ai_runtime.provider().await;
    let outputs = vec![OutputCapability {
        kind: "builtin",
        provider: provider.id().to_string(),
        model: provider.model().to_string(),
        ready: provider.ready() && provider.supports_wallpaper_builtin(),
    }];
    let registry_hash = hertz_wallpaper::catalog().registry_hash.clone();
    let schema_hash = generation_schema_hash();
    let content = serde_json::json!({
        "registryHash": registry_hash,
        "generationSchemaHash": schema_hash,
        "outputs": outputs,
    });
    let snapshot_id =
        sha256_hex(&serde_json::to_vec(&content).expect("capability snapshot content serializes"));
    CapabilitySnapshot {
        snapshot_id,
        registry_hash,
        generation_schema_hash: schema_hash,
        outputs,
    }
}

/// 内存中的待提交 quote（§19.4）。brief 与完整请求只存活在这里，重启即丢。
pub(crate) struct StoredQuote {
    pub quote_id: String,
    pub owner: String,
    pub request: hertz_wallpaper::generation::WallpaperGenerateRequest,
    pub request_digest: String,
    pub request_bytes: usize,
    pub pricing: PricingSnapshot,
    pub consumed: bool,
    pub expires_at: i64,
}

#[derive(Default)]
pub(crate) struct QuoteStore {
    quotes: Vec<StoredQuote>,
}

impl QuoteStore {
    fn sweep(&mut self, now: i64) {
        self.quotes.retain(|quote| quote.expires_at > now);
    }

    fn owner_bytes(&self, owner: &str) -> usize {
        self.quotes
            .iter()
            .filter(|quote| quote.owner == owner)
            .map(|quote| quote.request_bytes)
            .sum()
    }

    /// 新增 quote；超出数量/字节上限返回拒绝。过期项先清扫。
    pub(crate) fn insert(
        &mut self,
        owner: &str,
        quote_id: String,
        request: hertz_wallpaper::generation::WallpaperGenerateRequest,
        request_digest: String,
        pricing: PricingSnapshot,
        now: i64,
    ) -> Result<i64, ApiError> {
        self.sweep(now);
        let request_bytes = serde_json::to_vec(&request)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        let owner_count = self.quotes.iter().filter(|q| q.owner == owner).count();
        if owner_count >= MAX_QUOTES_PER_OWNER {
            return Err(ApiError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "quote_capacity_exceeded",
                "待提交 quote 数量已满",
            ));
        }
        if self.owner_bytes(owner) + request_bytes > MAX_QUOTE_TOTAL_BYTES {
            return Err(ApiError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "quote_capacity_exceeded",
                "待提交 quote 合计字节超上限",
            ));
        }
        let expires_at = now + QUOTE_TTL_MS;
        self.quotes.push(StoredQuote {
            quote_id,
            owner: owner.to_string(),
            request,
            request_digest,
            request_bytes,
            pricing,
            consumed: false,
            expires_at,
        });
        Ok(expires_at)
    }

    /// 查找未过期 quote（含已消费的，供幂等回放）。
    pub(crate) fn lookup(&self, owner: &str, quote_id: &str, now: i64) -> Option<&StoredQuote> {
        self.quotes.iter().find(|quote| {
            quote.owner == owner && quote.quote_id == quote_id && quote.expires_at > now
        })
    }

    /// 标记已消费（admission 成功后；重试回放沿用同一事实）。
    pub(crate) fn mark_consumed(&mut self, owner: &str, quote_id: &str) {
        if let Some(quote) = self
            .quotes
            .iter_mut()
            .find(|quote| quote.owner == owner && quote.quote_id == quote_id)
        {
            quote.consumed = true;
        }
    }

    /// 受理失败还原为未消费（用户修正后可重试同一 quote）。
    pub(crate) fn restore(&mut self, owner: &str, quote_id: &str) {
        if let Some(quote) = self
            .quotes
            .iter_mut()
            .find(|quote| quote.owner == owner && quote.quote_id == quote_id)
        {
            quote.consumed = false;
        }
    }
}
