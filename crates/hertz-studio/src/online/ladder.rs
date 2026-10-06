// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 取流候选阶梯。
//!
//! 一首曲子可以有多个可播直链（不同音质档、不同 CDN 域名），播放侧按序尝试。
//! 承载它们的容器必须带类型：只放 URL 的话，每个候选自己的 Referer、标称码率
//! 和容器就没有归宿，档位标注与诚实性判定只能拿主地址去猜——而主地址恰恰可能
//! 不是最终交付字节的那一个。

use super::{referer, StreamInfo};

/// 一个可播直链候选。
#[derive(Debug, Clone)]
pub struct Candidate {
    pub url: String,
    /// 这一档的标称码率（bps）。`None` = 上游没说，不参与码率诚实性判定。
    pub bitrate: Option<u64>,
    /// 上游证据给出的容器名（`"flac"` / `"mp3"` / `"m4a"` …，不带点）。
    /// `None` = 只能靠首 32 字节嗅探。
    pub container: Option<&'static str>,
    /// 下载这条时要带的 Referer。`None` = 用本音源的默认值
    /// （[`StreamInfo::ladder`] 负责把默认值填进来）。
    pub referer: Option<&'static str>,
}

impl Candidate {
    /// 只知道地址的候选：其余元数据一律未知，交给嗅探与默认 Referer。
    pub fn bare(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            bitrate: None,
            container: None,
            referer: None,
        }
    }
}

impl StreamInfo {
    /// 完整播放阶梯：**主地址恒在首位**，其后依次是 `fallbacks`。
    ///
    /// 播放与预取两条路径都必须走这里。此前两边各自
    /// `once(url).chain(fallback_urls)`，改一处漏一处；Referer 也由调用方按
    /// 音源现算，于是跨域名的候选根本没法自带 Referer。
    pub fn ladder(&self) -> Vec<Candidate> {
        let def = referer(&self.source);
        let mut out = Vec::with_capacity(1 + self.fallbacks.len());
        out.push(Candidate {
            url: self.url.clone(),
            bitrate: self.bitrate,
            container: None,
            referer: def,
        });
        for mut c in self.fallbacks.clone() {
            c.referer = c.referer.or(def);
            out.push(c);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(url: &str, fallbacks: Vec<Candidate>) -> StreamInfo {
        StreamInfo {
            url: url.into(),
            source: "qq".into(),
            id: "1".into(),
            bitrate: Some(320_000),
            expires_in_secs: None,
            fallbacks,
            rg_gain_db: None,
            rg_peak: None,
        }
    }

    /// 主地址必须在第一位，且每个候选都拿得到 Referer（自己的或音源默认的）。
    #[test]
    fn ladder_puts_the_primary_first_and_fills_referers() {
        let ladder = info(
            "https://a/m800.flac",
            vec![
                Candidate {
                    url: "https://cdn.example/x.m4a".into(),
                    bitrate: Some(96_000),
                    container: Some("m4a"),
                    referer: Some("https://mirror.example/"),
                },
                Candidate::bare("https://b/c.mp3"),
            ],
        )
        .ladder();

        assert_eq!(ladder.len(), 3);
        assert_eq!(ladder[0].url, "https://a/m800.flac");
        assert_eq!(ladder[0].bitrate, Some(320_000), "主档码率要能参与判定");
        assert_eq!(ladder[1].referer, Some("https://mirror.example/"));
        assert_eq!(
            ladder[2].referer,
            referer("qq"),
            "没声明的候选落到音源默认 Referer"
        );
        assert_eq!(ladder[2].container, None);
    }

    #[test]
    fn empty_fallbacks_still_yield_one_candidate() {
        assert_eq!(info("https://a/only.mp3", Vec::new()).ladder().len(), 1);
    }
}
