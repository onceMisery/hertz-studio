// SPDX-License-Identifier: MIT
//! Offline discovery only. These pure projections never grant execution authority.
//! Native callers provide catalog facts from the existing library and target planner;
//! model output, management flags and a proposed action cannot issue a native ticket.

use serde::{Deserialize, Serialize};

use crate::{PackageError, Result};

pub const MAX_RECOMMENDATIONS: usize = 32;
pub const MAX_BRIEF_BYTES: usize = 4096;
const MAX_REQUEST_BYTES: usize = 12 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecommendationRequest {
    pub brief: String,
}

impl RecommendationRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(invalid("推荐请求超过 12 KiB"));
        }
        crate::json::check_bounded_json(bytes, 4)?;
        let request: Self =
            serde_json::from_slice(bytes).map_err(|_| invalid("推荐请求结构无效"))?;
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<()> {
        if self.brief.len() > MAX_BRIEF_BYTES
            || self
                .brief
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(invalid("推荐描述需为 4 KiB 以内文本，不能含不可见控制字符"));
        }
        Ok(())
    }
}

/// A caller-supplied discovery fact, not a permission receipt or a runtime promise.
/// No Deserialize implementation: this is not a model/request input DTO.
#[derive(Debug, Clone)]
pub struct CatalogCandidate {
    pub work_key: String,
    pub package_hash: String,
    pub title: String,
    pub tags: Vec<String>,
    pub theme_words: Vec<String>,
    pub low_motion: bool,
    /// Only entries satisfying installed/state/license/adapter/target/budget filters.
    pub eligible: bool,
}

impl CatalogCandidate {
    fn validate(&self) -> Result<()> {
        if self.work_key.is_empty()
            || self.work_key.len() > 128
            || !self
                .work_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || !crate::valid_sha256_hex(&self.package_hash)
            || self.title.trim().is_empty()
            || self.title.len() > 640
            || self.title.chars().any(char::is_control)
            || self.tags.len() > 32
            || self.theme_words.len() > 32
            || self.tags.iter().chain(&self.theme_words).any(|word| {
                word.trim().is_empty() || word.len() > 256 || word.chars().any(char::is_control)
            })
        {
            return Err(invalid("推荐目录身份或名称/标签信息无效"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum RecommendationReason {
    Installed,
    ExactTitle(String),
    Title(String),
    Tag(String),
    Theme(String),
    LowMotion,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub work_key: String,
    pub package_hash: String,
    pub title: String,
    pub reasons: Vec<RecommendationReason>,
    #[serde(skip)]
    score: u32,
}

/// Advisory result only. The trusted native UI must still bind and authorize
/// this exact action before the existing control queue may consume a ticket.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProposal {
    pub target_group_id: String,
    pub work_key: String,
    pub package_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationResult {
    pub items: Vec<Recommendation>,
    pub switch_proposal: Option<SwitchProposal>,
    pub ambiguous_title: bool,
}

fn normalized(text: &str) -> String {
    text.trim().to_lowercase()
}

/// Whole-input syntax: negation, an extra clause or a mood request does not
/// become a switch. Exact title matching is checked over the entire directory.
fn switch_title(brief: &str) -> Option<&str> {
    let brief = brief.trim();
    let title = brief
        .strip_prefix("切换到")
        .or_else(|| brief.strip_prefix("切换为"))
        .or_else(|| {
            brief
                .get(..10)
                .filter(|prefix| prefix.eq_ignore_ascii_case("switch to "))
                .and_then(|_| brief.get(10..))
        })?
        .trim();
    let title = if title.starts_with('「') {
        title.strip_prefix('「')?.strip_suffix('」')?
    } else if title.starts_with('《') {
        title.strip_prefix('《')?.strip_suffix('》')?
    } else if title.starts_with('"') {
        title.strip_prefix('"')?.strip_suffix('"')?
    } else {
        title
    };
    (!title.trim().is_empty()).then_some(title.trim())
}

/// Keeps only the best 32 while scanning every entry. Truncation never proves
/// uniqueness, and the candidate source retains ownership of its data.
pub fn recommend<'a>(
    request: &RecommendationRequest,
    candidates: impl IntoIterator<Item = &'a CatalogCandidate>,
    current_target_group: Option<&str>,
) -> Result<RecommendationResult> {
    request.validate()?;
    if current_target_group.is_some_and(|id| {
        id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }) {
        return Err(invalid("推荐目标组身份无效"));
    }
    let explicit_title = switch_title(&request.brief).map(normalized);
    let query = explicit_title
        .clone()
        .unwrap_or_else(|| normalized(&request.brief));
    let calm = ["安静", "低动态", "少动", "quiet", "calm"]
        .iter()
        .any(|word| query.contains(word));
    let mut items: Vec<Recommendation> = Vec::with_capacity(MAX_RECOMMENDATIONS + 1);
    let mut exact: Option<&CatalogCandidate> = None;
    let mut ambiguous_title = false;
    for candidate in candidates {
        candidate.validate()?;
        if !candidate.eligible {
            continue;
        }
        let title = normalized(&candidate.title);
        if explicit_title.as_deref() == Some(title.as_str()) {
            if exact.is_some_and(|previous| {
                previous.work_key != candidate.work_key
                    || previous.package_hash != candidate.package_hash
            }) {
                ambiguous_title = true;
            }
            exact.get_or_insert(candidate);
        }
        let mut reasons = Vec::with_capacity(4);
        let mut score = 0;
        if query.is_empty() {
            reasons.push(RecommendationReason::Installed);
        } else {
            if title == query {
                score += 1000;
                reasons.push(RecommendationReason::ExactTitle(candidate.title.clone()));
            } else if title.contains(&query) {
                score += 600;
                reasons.push(RecommendationReason::Title(candidate.title.clone()));
            }
            // At most one reason per category. Repeated tags cannot inflate rank.
            if let Some(tag) = candidate
                .tags
                .iter()
                .filter(|tag| query.contains(&normalized(tag)))
                .min_by_key(|tag| (normalized(tag), tag.as_str()))
            {
                score += 350;
                reasons.push(RecommendationReason::Tag(tag.clone()));
            }
            if let Some(theme) = candidate
                .theme_words
                .iter()
                .filter(|word| query.contains(&normalized(word)))
                .min_by_key(|word| (normalized(word), word.as_str()))
            {
                score += 200;
                reasons.push(RecommendationReason::Theme(theme.clone()));
            }
            if calm && candidate.low_motion {
                score += 150;
                reasons.push(RecommendationReason::LowMotion);
            }
            if reasons.is_empty() {
                continue;
            }
        }
        if items.iter().any(|item| {
            item.work_key == candidate.work_key && item.package_hash == candidate.package_hash
        }) {
            continue;
        }
        items.push(Recommendation {
            work_key: candidate.work_key.clone(),
            package_hash: candidate.package_hash.clone(),
            title: candidate.title.clone(),
            reasons,
            score,
        });
        items.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.work_key.cmp(&right.work_key))
                .then_with(|| left.package_hash.cmp(&right.package_hash))
        });
        items.truncate(MAX_RECOMMENDATIONS);
    }
    let switch_proposal = current_target_group
        .zip(exact)
        .filter(|_| !ambiguous_title)
        .map(|(group, candidate)| SwitchProposal {
            target_group_id: group.to_owned(),
            work_key: candidate.work_key.clone(),
            package_hash: candidate.package_hash.clone(),
        });
    Ok(RecommendationResult {
        items,
        switch_proposal,
        ambiguous_title,
    })
}

fn invalid(message: &str) -> PackageError {
    PackageError::new("invalid_recommendation", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(index: u32, title: &str) -> CatalogCandidate {
        CatalogCandidate {
            work_key: format!("work-{index:04}"),
            package_hash: format!("{index:064x}"),
            title: title.into(),
            tags: vec![],
            theme_words: vec![],
            low_motion: false,
            eligible: true,
        }
    }
    fn request(brief: &str) -> RecommendationRequest {
        RecommendationRequest {
            brief: brief.into(),
        }
    }

    #[test]
    fn strict_request_rejects_self_authorization_duplicates_and_invalid_text() {
        for bytes in [
            br#"{"brief":"sea","approved":true}"#.as_slice(),
            br#"{"brief":"sea","brief":"quiet"}"#,
            br#"{"br\u0069ef":"sea","brief":"quiet"}"#,
            br#"{"brief":"\u0000"}"#,
            &[0xff],
        ] {
            assert!(RecommendationRequest::parse(bytes).is_err());
        }
        assert!(RecommendationRequest::parse(
            format!("{{\"brief\":\"{}\"}}", "x".repeat(4097)).as_bytes()
        )
        .is_err());
        assert!(RecommendationRequest::parse(br#"{"brief":"sea"}"#).is_ok());
        assert!(RecommendationRequest::parse(br#"{"brief":"sea\nquiet"}"#).is_ok());
    }

    #[test]
    fn title_uniqueness_scans_beyond_the_output_limit_and_exact_versions() {
        let entries: Vec<_> = (0..40).map(|index| candidate(index, "海岸")).collect();
        let result = recommend(&request("切换到「海岸」"), &entries, Some("main")).unwrap();
        assert_eq!(result.items.len(), 32);
        assert!(result.ambiguous_title);
        assert!(result.switch_proposal.is_none());
        let mut revisions = vec![candidate(1, "海岸"), candidate(1, "海岸")];
        revisions[1].package_hash = format!("{:064x}", 2);
        assert!(
            recommend(&request("切换到海岸"), &revisions, Some("main"))
                .unwrap()
                .ambiguous_title
        );
    }

    #[test]
    fn clear_action_proposes_one_existing_group_without_creating_authority() {
        let entries = [candidate(1, "Coast")];
        let result = recommend(
            &request("SWITCH TO \"Coast\""),
            &entries,
            Some("existing-group"),
        )
        .unwrap();
        let proposal = result.switch_proposal.unwrap();
        assert_eq!(proposal.target_group_id, "existing-group");
        assert_eq!(proposal.package_hash, entries[0].package_hash);
        assert!(recommend(&request("切换到Coast"), &entries, None)
            .unwrap()
            .switch_proposal
            .is_none());
        for text in [
            "不要切换到Coast",
            "切换到Coast并改歌词",
            "想试试Coast",
            "切换到「Coast",
        ] {
            assert!(recommend(&request(text), &entries, Some("main"))
                .unwrap()
                .switch_proposal
                .is_none());
        }
    }

    #[test]
    fn calm_is_an_explained_recommendation_and_never_an_action() {
        let mut entry = candidate(1, "夜航");
        entry.low_motion = true;
        let entries = [entry];
        let result = recommend(&request("安静一点"), &entries, Some("main")).unwrap();
        assert_eq!(result.items[0].reasons, [RecommendationReason::LowMotion]);
        assert!(result.switch_proposal.is_none());
    }

    #[test]
    fn ineligible_entries_do_not_influence_recommendations_or_unique_actions() {
        let mut unavailable = candidate(2, "海岸");
        unavailable.eligible = false;
        let entries = [candidate(1, "海岸"), unavailable];
        let result = recommend(&request("切换到海岸"), &entries, Some("main")).unwrap();
        assert_eq!(result.items.len(), 1);
        assert!(!result.ambiguous_title);
        assert_eq!(
            result.switch_proposal.unwrap().work_key,
            entries[0].work_key
        );
    }

    #[test]
    fn ranking_is_stable_and_repeated_tags_do_not_inflate_it() {
        let mut tagged = candidate(2, "潮汐");
        tagged.tags = vec!["海岸".into(); 32];
        let mut themed = candidate(3, "远洋");
        themed.theme_words = vec!["海岸".into()];
        let mut entries = vec![themed, tagged, candidate(1, "海岸")];
        let first = recommend(&request("海岸"), &entries, Some("main")).unwrap();
        entries.reverse();
        let second = recommend(&request("海岸"), &entries, Some("main")).unwrap();
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap()
        );
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.work_key.as_str())
                .collect::<Vec<_>>(),
            ["work-0001", "work-0002", "work-0003"]
        );
        assert!(first.switch_proposal.is_none());
    }

    #[test]
    fn empty_directory_and_bad_identity_remain_explicit() {
        assert!(recommend(&request(""), [], Some("main"))
            .unwrap()
            .items
            .is_empty());
        let mut entry = candidate(1, "海岸");
        entry.package_hash = "../original.hwpkg".into();
        assert!(recommend(&request(""), &[entry], Some("main")).is_err());
        assert!(recommend(&request(""), [], Some("../all")).is_err());
    }
}
