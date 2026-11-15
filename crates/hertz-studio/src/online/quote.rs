// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 首页「每日一言」的取句通道。
//
// 为什么在后端而不是界面里 fetch：DBX 宿主给插件文档注入的 CSP 是
// `connect-src 'none'`（manifest 没声明任何 `host.network:` 权限），所以原来
// `plugin/ui/home-quote.js` 里那条 `fetch('https://v1.hitokoto.cn/…')` 在插件形态
// 必被浏览器拦掉，用户只会看到回落的本地句池。后端发请求不受 CSP 约束，两种形态
// 因此走同一条路——与在线音源、播客目录、远程封面同一个做法。

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{bad_request, internal, ApiError, ApiResult};

use super::client;
use super::http::get_json;

const ENDPOINT: &str = "https://v1.hitokoto.cn/";
/// 句子长度上限。首页卡片那一格放不下更长的，而上游默认会返回长句。
const MAX_LENGTH: &str = "48";
const DEFAULT_CATEGORY: &str = "poem";

/// 分类名 → 一言的 `c` 参数。**只认这张表里的键**：调用方传什么都不可能被拼成
/// 别的上游地址，也就不存在把用户输入注进第三方 URL 的口子。换句子库时改这一处。
const CATEGORIES: &[(&str, &str)] = &[
    ("poem", "i"),
    ("literature", "d"),
    ("philosophy", "k"),
    ("film", "h"),
];

/// HTTP 与 RPC 两个门面共用同一个入参形状，所以分类白名单也只有一个 owner。
#[derive(Debug, Default, Deserialize)]
pub(crate) struct QuoteQuery {
    /// 分类名，取值见 `CATEGORIES`；缺省走 `DEFAULT_CATEGORY`。
    pub(crate) c: Option<String>,
    /// 请求序号。一言的 CDN 会把相同 URL 的重复/并发请求合并成同一个响应
    /// （实测 8 次只回 3~4 个唯一 id），语料池就塌成一两条；带一个每次都不同的
    /// 查询参数才拿得到不同句子。这里只透传，不解释内容。
    pub(crate) r: Option<String>,
}

fn category_code(name: Option<&str>) -> ApiResult<&'static str> {
    let name = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CATEGORY);
    CATEGORIES
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, code)| *code)
        // 不回显传进来的值：这条会进日志，而值来自界面之外。
        .ok_or_else(|| bad_request("未知的名言分类"))
}

fn quote_url(cat: &str, nonce: Option<&str>) -> ApiResult<reqwest::Url> {
    let mut url = reqwest::Url::parse(ENDPOINT).map_err(|e| internal(e.to_string()))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("encode", "json");
        pairs.append_pair("c", cat);
        pairs.append_pair("max_length", MAX_LENGTH);
        if let Some(nonce) = nonce.map(str::trim).filter(|value| !value.is_empty()) {
            pairs.append_pair("_", nonce);
        }
    }
    Ok(url)
}

/// 上游字段名不统一（`from` / `origin`，作者可能是「匿名」），归一在这里做完，
/// 界面只管显示。取不到正文就当失败，让调用方去落兜底句池。
fn normalize_quote(raw: &Value) -> Option<Value> {
    let text = raw
        .get("hitokoto")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if text.is_empty() {
        return None;
    }
    let from = raw
        .get("from")
        .or_else(|| raw.get("origin"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let author = raw
        .get("author")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let from = if author.is_empty() || author == "匿名" {
        from.to_string()
    } else if from.is_empty() {
        author.to_string()
    } else {
        format!("{from} · {author}")
    };
    Some(json!({ "hitokoto": text, "from": from }))
}

/// 取一条句子，应答形状固定为 `{hitokoto, from}`。
pub(crate) async fn daily_quote(query: &QuoteQuery) -> ApiResult<Value> {
    let url = quote_url(category_code(query.c.as_deref())?, query.r.as_deref())?;
    let raw = get_json(&client()?, url.as_str(), Default::default()).await?;
    normalize_quote(&raw).ok_or_else(|| {
        ApiError::upstream_rejected("一言响应里没有可用的句子").with_source("hitokoto")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_category_maps_to_its_upstream_code() {
        for (name, code) in CATEGORIES {
            assert_eq!(category_code(Some(name)).unwrap(), *code);
        }
        assert_eq!(category_code(None).unwrap(), "i", "缺省走诗词");
        assert_eq!(category_code(Some("  ")).unwrap(), "i", "空白按缺省处理");
    }

    #[test]
    fn unknown_category_is_rejected_without_reaching_the_network() {
        // 这条断言的全部意义在于：非白名单值不会变成上游 URL 的一部分。
        let error = category_code(Some("https://evil/")).unwrap_err();
        assert_eq!(error.code, "bad_request");
    }

    #[test]
    fn request_url_carries_only_the_whitelisted_code_and_the_nonce() {
        let url = quote_url("d", Some("2026-10-10-3")).unwrap();
        assert_eq!(url.host_str().unwrap(), "v1.hitokoto.cn");
        let query: Vec<String> = url
            .query_pairs()
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        assert_eq!(
            query,
            vec!["encode=json", "c=d", "max_length=48", "_=2026-10-10-3"]
        );
        // 空序号不产生一个光秃秃的 `_=`，否则又会被 CDN 合并回去。
        // 查参数名而不是查字符：`max_length` 里本来就带下划线。
        let bare = quote_url("i", Some("   ")).unwrap();
        assert!(!bare.query_pairs().any(|(key, _)| key == "_"));
    }

    #[test]
    fn quote_fields_are_normalized_once_server_side() {
        let full =
            normalize_quote(&json!({ "hitokoto": " 句子 ", "from": "《诗》", "author": "某人" }))
                .unwrap();
        assert_eq!(full["hitokoto"], "句子", "首尾空白不该带进界面");
        assert_eq!(full["from"], "《诗》 · 某人");
        assert_eq!(
            normalize_quote(&json!({ "hitokoto": "句子", "origin": "出处", "author": "匿名" }))
                .unwrap()["from"],
            "出处",
            "「匿名」作者不该出现在出处里"
        );
        assert_eq!(
            normalize_quote(&json!({ "hitokoto": "句子", "author": "某人" })).unwrap()["from"],
            "某人",
            "只有作者时作者顶上来"
        );
        assert!(
            normalize_quote(&json!({ "hitokoto": "  " })).is_none(),
            "空正文算失败"
        );
        assert!(normalize_quote(&json!({})).is_none());
    }
}
