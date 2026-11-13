// SPDX-License-Identifier: MIT
//! Native offline authority. Catalog facts remain with Library/AssetStore;
//! tickets remain private to the current authenticated settings session.
use super::{
    api, budget, config,
    display::DisplayTarget,
    jobs::{ImportJobs, JobError},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, JobError>;
pub(crate) const TTL: Duration = Duration::from_secs(30);
const TICKET_CAP: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Binding {
    pub principal: String,
    pub settings_session: u64,
    pub host_generation: String,
    pub profile_digest: String,
    pub target_group_id: String,
    pub selection_generation: u64,
    pub topology_revision: String,
    pub expected_config_revision: u64,
    pub context_digest: String,
}

#[derive(Clone)]
pub(crate) struct CatalogContext {
    pub binding: Binding,
    pub configuration: config::WallpaperConfig,
    pub targets: Vec<DisplayTarget>,
    pub replaced_generations: Vec<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Action {
    pub action_id: String,
    pub target_group_id: String,
    pub work_key: String,
    pub package_hash: String,
    pub title: String,
    pub version: u32,
    pub permission_digest: String,
    pub action_digest: String,
    pub reasons: Vec<hertz_wallpaper::ai::RecommendationReason>,
}

pub(crate) struct Catalog {
    pub binding: Binding,
    pub actions: Vec<Action>,
    pub explicit_action: Option<String>,
    pub ambiguous: bool,
    pub inspected: usize,
}

#[derive(Clone)]
pub(crate) struct Authority {
    pub binding: Binding,
    pub action: Action,
    pub request_id: String,
    pub context: Option<CatalogContext>,
}

struct Ticket {
    binding: Binding,
    action: Action,
    expires: Instant,
}

pub(crate) struct NativeAi {
    owner: u64,
    host_generation: String,
    selection_generation: u64,
    selected_group: Option<String>,
    displayed: BTreeMap<String, (Binding, Action)>,
    tickets: BTreeMap<String, Ticket>,
}

impl NativeAi {
    pub(crate) fn new() -> Self {
        Self {
            owner: 0,
            host_generation: uuid::Uuid::new_v4().to_string(),
            selection_generation: 1,
            selected_group: None,
            displayed: BTreeMap::new(),
            tickets: BTreeMap::new(),
        }
    }
    pub(crate) fn set_owner(&mut self, owner: u64) {
        if self.owner != owner {
            self.owner = owner;
            self.selected_group = None;
            self.invalidate();
        }
    }
    pub(crate) fn invalidate(&mut self) {
        self.selection_generation = self.selection_generation.wrapping_add(1);
        self.displayed.clear();
        self.tickets.clear();
    }
    pub(crate) fn select_group(&mut self, owner: u64, group: Option<&str>) -> Result<()> {
        self.check_owner(owner)?;
        if self.selected_group.as_deref() != group {
            self.invalidate();
            self.selected_group = group.map(str::to_owned);
        }
        Ok(())
    }
    pub(crate) fn selected_group(&self) -> Option<&str> {
        self.selected_group.as_deref()
    }
    pub(crate) fn binding(
        &self,
        owner: u64,
        principal: String,
        configuration: &crate::config::Config,
        targets: &[DisplayTarget],
    ) -> Result<Binding> {
        self.check_owner(owner)?;
        let group = self
            .selected_group
            .as_ref()
            .ok_or_else(|| JobError::new("target_required", "请先选择一个已保存的显示组"))?;
        let selected = configuration
            .wallpaper
            .groups
            .iter()
            .find(|entry| &entry.id == group)
            .ok_or_else(|| JobError::new("target_required", "显示组尚未保存或已经移除"))?;
        if targets.is_empty() || targets.iter().any(|target| &target.group_id != group) {
            return Err(JobError::new(
                "target_unavailable",
                "这个已保存显示组没有唯一、可用的现有显示目标",
            ));
        }
        Ok(Binding {
            principal,
            settings_session: owner,
            host_generation: self.host_generation.clone(),
            profile_digest: digest(&configuration.active_profile),
            target_group_id: group.clone(),
            selection_generation: self.selection_generation,
            topology_revision: digest(&targets),
            expected_config_revision: configuration.revision,
            context_digest: digest(
                &json!({"group":selected,"wallpaper":configuration.wallpaper,"profile":configuration.active_profile}),
            ),
        })
    }
    fn check_owner(&self, owner: u64) -> Result<()> {
        if owner == 0 || owner != self.owner {
            return Err(JobError::new(
                "settings_session_required",
                "离线切换需要当前原生设置会话",
            ));
        }
        Ok(())
    }
    pub(crate) fn show(&mut self, catalog: &Catalog, current: &Binding) -> Result<()> {
        self.check_owner(current.settings_session)?;
        if catalog.binding != *current {
            return Err(stale());
        }
        self.displayed.clear();
        for action in &catalog.actions {
            self.displayed
                .insert(action.action_id.clone(), (current.clone(), action.clone()));
        }
        Ok(())
    }
    /// Called only by the native coordinator after a complete deterministic
    /// parse, or a click referencing an action that native has already displayed.
    pub(crate) fn issue_displayed(
        &mut self,
        action: &str,
        current: &Binding,
        now: Instant,
    ) -> Result<String> {
        self.check_owner(current.settings_session)?;
        self.tickets.retain(|_, entry| entry.expires > now);
        if self.tickets.len() >= TICKET_CAP {
            return Err(JobError::new(
                "budget_busy",
                "本设置会话已有四份活动切换票据",
            ));
        }
        let (binding, action) = self.displayed.get(action).ok_or_else(stale)?;
        if binding != current {
            return Err(stale());
        }
        let token = random_256()?;
        self.tickets.insert(
            token.clone(),
            Ticket {
                binding: binding.clone(),
                action: action.clone(),
                expires: now + TTL,
            },
        );
        Ok(token)
    }
    pub(crate) fn consume(
        &mut self,
        token: &str,
        current: &Binding,
        request_id: &str,
        now: Instant,
    ) -> Result<Authority> {
        self.check_owner(current.settings_session)?;
        let ticket = self.tickets.remove(token).ok_or_else(stale)?;
        if ticket.expires <= now || ticket.binding != *current {
            return Err(stale());
        }
        Ok(Authority {
            binding: ticket.binding,
            action: ticket.action,
            request_id: request_id.to_owned(),
            context: None,
        })
    }
}

pub(crate) fn stale() -> JobError {
    JobError::new(
        "ai_action_stale",
        "目标、选择、配置或设置会话已变化，请重新推荐",
    )
}
pub(crate) fn check_authority(authority: &Authority, current: &Binding) -> Result<()> {
    let action = &authority.action;
    if authority.binding != *current
        || action.target_group_id != current.target_group_id
        || action.action_digest
            != digest(
                &json!({"binding":current.context_digest,"group":current.target_group_id,
            "work":action.work_key,"package":action.package_hash,"permission":action.permission_digest,"operation":"replaceSelection"}),
            )
    {
        return Err(stale());
    }
    Ok(())
}
pub(crate) fn digest(value: &impl Serialize) -> String {
    crate::config_journal::digest(&serde_json::to_vec(value).expect("native serializable fact"))
}

fn random_256() -> Result<String> {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            count: u32,
            flags: u32,
        ) -> i32;
    }
    let mut bytes = [0u8; 32];
    // BCRYPT_USE_SYSTEM_PREFERRED_RNG; full 256 random bits, no UUID version bits.
    if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) } < 0 {
        return Err(JobError::new("identity_unavailable", "系统随机源暂不可用"));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecommendInput {
    pub brief: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TargetInput {
    pub group_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfirmInput {
    pub action_id: String,
}

#[derive(sqlx::FromRow)]
struct Row {
    work_key: String,
    package_hash: String,
    title: String,
    description: String,
    version: i64,
    manifest_json: String,
    version_key: String,
    versions: i64,
    source_id: String,
}

pub(crate) async fn catalog(
    jobs: Arc<ImportJobs>,
    brief: String,
    context: CatalogContext,
) -> Result<Catalog> {
    let request = hertz_wallpaper::ai::RecommendationRequest { brief };
    request.validate()?;
    let mut cursor = String::new();
    let mut best = Vec::<hertz_wallpaper::ai::CatalogCandidate>::new();
    let mut details = BTreeMap::<String, (u32, String)>::new();
    let mut explicit: Option<(String, String)> = None;
    let mut ambiguous = false;
    let mut inspected = 0;
    loop {
        let rows: Vec<Row> = sqlx::query_as("SELECT w.work_key,p.package_hash,w.title,w.description,v.version,p.manifest_json,v.version_key,w.source_id,(SELECT COUNT(*) FROM versions av JOIN packages ap ON ap.package_hash=av.package_hash WHERE av.work_key=w.work_key AND ap.state='installed') AS versions FROM works w JOIN versions v ON v.work_key=w.work_key JOIN packages p ON p.package_hash=v.package_hash WHERE w.archived=0 AND p.state='installed' AND v.release_id IS NULL AND v.version_key>?1 AND length(CAST(p.manifest_json AS BLOB))<=?2 ORDER BY v.version_key LIMIT 128")
            .bind(&cursor).bind(hertz_wallpaper::MAX_MANIFEST_BYTES as i64).fetch_all(jobs.library().pool()).await
            .map_err(|error| JobError::database(error.to_string()))?;
        if rows.is_empty() {
            break;
        }
        cursor = rows.last().expect("nonempty").version_key.clone();
        let mut page = Vec::new();
        for row in rows {
            inspected += 1;
            // Hub revocation/trust ownership is not implemented in AI-01. A
            // release/signed source cannot acquire local authority by installation.
            if !matches!(row.source_id.as_str(), "local" | "unsigned-import") {
                continue;
            }
            let Ok(manifest) =
                hertz_wallpaper::validate_manifest_bytes(row.manifest_json.as_bytes())
            else {
                continue;
            };
            if !permission_eligible(
                &manifest,
                &context.configuration,
                &context.binding.target_group_id,
            ) {
                continue;
            }
            if !type_budget_eligible(&manifest, &context) {
                continue;
            }
            let title = if row.versions > 1 {
                format!("{} · v{}", row.title, row.version)
            } else {
                row.title.clone()
            };
            let words = row
                .description
                .split(|character: char| {
                    character.is_whitespace() || matches!(character, ',' | '，' | ';' | '；')
                })
                .filter(|word| {
                    !word.is_empty() && word.len() <= 256 && !word.chars().any(char::is_control)
                })
                .take(32)
                .map(str::to_owned)
                .collect();
            let candidate = hertz_wallpaper::ai::CatalogCandidate {
                work_key: row.work_key.clone(),
                package_hash: row.package_hash.clone(),
                title,
                tags: vec![],
                theme_words: words,
                low_motion: matches!(manifest.content, hertz_wallpaper::Content::Image { .. })
                    || ["安静", "低动态", "quiet", "calm"]
                        .iter()
                        .any(|word| row.description.to_lowercase().contains(word)),
                eligible: true,
            };
            let single = hertz_wallpaper::ai::recommend(
                &request,
                [&candidate],
                Some(&context.binding.target_group_id),
            )?;
            if single.switch_proposal.is_some() {
                let identity = (candidate.work_key.clone(), candidate.package_hash.clone());
                if explicit
                    .as_ref()
                    .is_some_and(|previous| previous != &identity)
                {
                    ambiguous = true;
                }
                explicit.get_or_insert(identity);
            }
            details.insert(
                format!("{}:{}", row.work_key, row.package_hash),
                (
                    row.version as u32,
                    digest(&json!({"permissions":manifest.permissions,"license":manifest.license})),
                ),
            );
            page.push(candidate);
        }
        best.extend(page);
        let ranking = hertz_wallpaper::ai::recommend(&request, best.iter(), None)?;
        best.retain(|candidate| {
            ranking.items.iter().any(|item| {
                item.work_key == candidate.work_key && item.package_hash == candidate.package_hash
            })
        });
        details.retain(|key, _| {
            best.iter().any(|candidate| {
                key == &format!("{}:{}", candidate.work_key, candidate.package_hash)
            })
        });
    }
    let ranking = hertz_wallpaper::ai::recommend(&request, best.iter(), None)?;
    let source = Arc::clone(&jobs);
    let verify_context = context.clone();
    let valid = tokio::task::spawn_blocking(move || {
        ranking
            .items
            .into_iter()
            .filter(|item| verify_installed_budget(&source, &item.package_hash, &verify_context))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| JobError::new("worker_unavailable", "目录包验证已退出"))?;
    let mut actions = Vec::new();
    for item in valid {
        let Some((version, permission_digest)) =
            details.remove(&format!("{}:{}", item.work_key, item.package_hash))
        else {
            continue;
        };
        let action_digest = digest(
            &json!({"binding":context.binding.context_digest,"group":context.binding.target_group_id,
            "work":item.work_key,"package":item.package_hash,"permission":permission_digest,"operation":"replaceSelection"}),
        );
        actions.push(Action {
            action_id: random_256()?,
            target_group_id: context.binding.target_group_id.clone(),
            work_key: item.work_key,
            package_hash: item.package_hash,
            title: item.title,
            version,
            permission_digest,
            action_digest,
            reasons: item.reasons,
        });
    }
    let explicit_action = explicit.filter(|_| !ambiguous).and_then(|(work, hash)| {
        actions
            .iter()
            .find(|action| action.work_key == work && action.package_hash == hash)
            .map(|action| action.action_id.clone())
    });
    Ok(Catalog {
        binding: context.binding,
        actions,
        explicit_action,
        ambiguous,
        inspected,
    })
}

fn verify_installed_budget(
    jobs: &ImportJobs,
    package_hash: &str,
    context: &CatalogContext,
) -> bool {
    if jobs
        .assets()
        .verify_installed(package_hash)
        .ok()
        .flatten()
        .is_none()
    {
        return false;
    }
    let Ok(package) = jobs.assets().read_installed_manifest(package_hash) else {
        return false;
    };
    if !permission_eligible(
        &package.manifest,
        &context.configuration,
        &context.binding.target_group_id,
    ) {
        return false;
    }
    let asset = match &package.manifest.content {
        hertz_wallpaper::Content::Image { asset } | hertz_wallpaper::Content::Video { asset } => {
            asset
        }
        hertz_wallpaper::Content::Builtin { .. } => {
            return type_budget_eligible(&package.manifest, context)
        }
        _ => return false,
    };
    let Some(descriptor) = package
        .manifest
        .assets
        .iter()
        .find(|entry| &entry.id == asset)
    else {
        return false;
    };
    let Ok(inputs) = jobs
        .assets()
        .probe_installed_media(&package, &AtomicBool::new(false))
    else {
        return false;
    };
    let Some(input) = inputs
        .iter()
        .find(|input| input.media.entry.path == descriptor.source)
    else {
        return false;
    };
    let Some(group) = context
        .configuration
        .groups
        .iter()
        .find(|group| group.id == context.binding.target_group_id)
    else {
        return false;
    };
    let requests = context
        .targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            let projected = super::image_prepare::ImageTarget {
                width: target.bounds.width,
                height: target.bounds.height,
                fit: if group.presentation.fit == config::Fit::Contain {
                    super::image_prepare::ImageFit::Contain
                } else {
                    super::image_prepare::ImageFit::Cover
                },
                purpose: match group.presentation.quality {
                    crate::config::WallpaperQuality::Low => super::image_prepare::ImagePurpose::Low,
                    crate::config::WallpaperQuality::Medium => {
                        super::image_prepare::ImagePurpose::Medium
                    }
                    crate::config::WallpaperQuality::High => {
                        super::image_prepare::ImagePurpose::High
                    }
                },
            };
            super::target_planner::presentation_request(
                &input.metadata,
                projected,
                format!("ai-catalog-{index}"),
                1,
            )
        })
        .collect::<Result<Vec<_>>>();
    requests.is_ok_and(|requests| {
        budget::global()
            .project_desktop_replacement(&context.replaced_generations)
            .check_requests(&requests)
            .is_ok()
    })
}

fn permission_eligible(
    manifest: &hertz_wallpaper::Manifest,
    configuration: &config::WallpaperConfig,
    group: &str,
) -> bool {
    if !configuration.groups.iter().any(|entry| entry.id == group) {
        return false;
    }
    !manifest.license.code.is_empty() && !manifest.license.assets.is_empty()
        // A global pointer/audio toggle is not a persisted per-work permission
        // receipt. Until that owner exists, offline selection cannot grant either.
        && !manifest.permissions.pointer && !manifest.permissions.audio_spectrum
}

fn type_budget_eligible(manifest: &hertz_wallpaper::Manifest, context: &CatalogContext) -> bool {
    // Never qualify by creating a renderer/decoder during discovery. Detailed
    // media/composition costs are verified by the original prepare owner before
    // any save; discovery uses the native type's conservative minimum envelope.
    let projected = budget::global().project_desktop_replacement(&context.replaced_generations);
    let Some(group) = context
        .configuration
        .groups
        .iter()
        .find(|entry| entry.id == context.binding.target_group_id)
    else {
        return false;
    };
    let mut requests = Vec::new();
    for target in &context.targets {
        let request = match &manifest.content {
            hertz_wallpaper::Content::Builtin {
                scene_id,
                state_version,
                params,
            } => {
                let mut params = params.clone();
                if config::normalize_builtin(scene_id, *state_version, &mut params).is_err() {
                    return false;
                }
                let Ok(plan) = super::gl_plan::GlPlan::new(
                    &projected.usage(),
                    budget::OwnerKind::Desktop,
                    "ai-catalog".into(),
                    1,
                    target.bounds.width,
                    target.bounds.height,
                    target.refresh_hz,
                    u32::from(group.presentation.fps),
                    group.presentation.quality.as_str(),
                ) else {
                    return false;
                };
                plan.session.request().clone()
            }
            hertz_wallpaper::Content::Image { .. } | hertz_wallpaper::Content::Video { .. } => {
                budget::BudgetRequest {
                    owner: budget::OwnerKind::Desktop,
                    session: "ai-catalog".into(),
                    generation: 1,
                    task_id: "presentation".into(),
                    targets: 1,
                    contexts: 0,
                    decoders: u32::from(matches!(
                        manifest.content,
                        hertz_wallpaper::Content::Video { .. }
                    )),
                    transcode_slots: 0,
                    decode_pixel_rate: 0,
                    output_pixel_rate: 0,
                    texture_upload_bytes_per_second: 0,
                    cpu_bytes: 0,
                    prepare_cpu_bytes: 0,
                    asset_cpu_bytes: 0,
                    gpu_bytes: 0,
                    prepare_tasks: 0,
                }
            }
            // Composition costs need the P2 exact prepared document/asset envelope;
            // Web is disabled by the original G3-S product qualification gate.
            _ => return false,
        };
        requests.push(request);
    }
    projected.check_requests(&requests).is_ok()
}

pub(crate) async fn revalidate(jobs: &ImportJobs, authority: &Authority) -> Result<()> {
    let action = &authority.action;
    if !jobs
        .library()
        .contains_version(&action.work_key, &action.package_hash)
        .await?
    {
        return Err(stale());
    }
    let manifest = jobs
        .library()
        .cover_manifest(&action.work_key, &action.package_hash)
        .await?;
    let eligible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM works w JOIN versions v ON v.work_key=w.work_key JOIN packages p ON p.package_hash=v.package_hash WHERE w.work_key=?1 AND v.package_hash=?2 AND w.archived=0 AND v.release_id IS NULL AND w.source_id IN ('local','unsigned-import') AND p.state='installed')")
        .bind(&action.work_key).bind(&action.package_hash).fetch_one(jobs.library().pool()).await.map_err(|error|JobError::database(error.to_string()))?;
    if !eligible
        || digest(&json!({"permissions":manifest.permissions,"license":manifest.license}))
            != action.permission_digest
    {
        return Err(stale());
    }
    if jobs
        .assets()
        .verify_installed(&action.package_hash)?
        .is_none()
    {
        return Err(JobError::new("asset_unavailable", "作品包已缺失或损坏"));
    }
    let context = authority.context.as_ref().ok_or_else(stale)?;
    if context.binding != authority.binding
        || !verify_installed_budget(jobs, &action.package_hash, context)
    {
        return Err(JobError::new(
            "ai_action_stale",
            "作品权限、类型或目标预算已变化，请重新推荐",
        ));
    }
    Ok(())
}

pub(crate) fn parse_request(value: Value) -> Result<api::Request> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| JobError::invalid_input(error.to_string()))?;
    if bytes.len() > 12 * 1024 {
        return Err(JobError::invalid_input("离线请求超过12 KiB"));
    }
    let request: api::Request = serde_json::from_value(value)
        .map_err(|error| JobError::invalid_input(error.to_string()))?;
    if request.protocol != 2 || !api::valid_id(&request.request_id) {
        return Err(JobError::invalid_input("离线请求信封无效"));
    }
    Ok(request)
}

#[cfg(test)]
#[path = "ai_tests.rs"]
mod tests;
