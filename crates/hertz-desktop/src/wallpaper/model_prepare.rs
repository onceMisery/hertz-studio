// SPDX-License-Identifier: MIT
//! Canonical full checked facts bound to their original installed source.
//! The Package texture closure is now canonical; loader, Broker, runtime and
//! GPU gates remain closed.
use super::{
    assets::{AssetStore, CanonicalModelSource},
    budget,
    decode_probe::{ProbeClient, Reservation},
    jobs::JobError,
    target_planner::AssetRef,
};
use crate::root_owner::arc_allocation_bytes;
use hertz_wallpaper::{model_binary::CompactCheckedGlbResource, model_structure::ModelHeapBounds};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[path = "model_texture_closure.rs"]
mod texture_closure;
use texture_closure::ModelTextureClosure;

// String::from(&str) requests the literal's exact byte length. Old model
// diagnostics drop before this is constructed. History/progress/DB copies
// and pre-source channel/frame/control admission remain onward frontiers.
const MODEL_DIAGNOSTIC: &str = "canonical model preparation failed";
const MODEL_QUERY_DIAGNOSTIC: u64 = 59;
const MODEL_REQUEST_STRINGS: u64 = 2 * (128 + 64);
/// Existing Broker read contract: one texture response/chunk is at most 1 MiB.
pub(crate) const MAX_MODEL_TEXTURE_READ_BYTES: usize = 1024 * 1024;

#[path = "model_native_facts.rs"]
mod native_facts;
use native_facts::NativeModelFacts;

#[derive(Clone)]
pub(crate) struct ModelInput(Option<Arc<Inner>>);
struct Resources {
    facts: CompactCheckedGlbResource,
    textures: ModelTextureClosure,
    source: CanonicalModelSource,
}
struct Inner {
    resources: Option<Resources>,
    retained: Option<Reservation>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let source_guard = if let Some(Resources {
            facts,
            textures,
            source,
        }) = self.resources.take()
        {
            drop(facts);
            // The closure's fixed record Vec physically releases before its
            // own ledger charge is refunded.
            drop(textures);
            source.retire_resources()
        } else {
            None
        };
        if let Some(retained) = self.retained.take() {
            retained.finish();
        }
        drop(source_guard);
    }
}
impl Drop for ModelInput {
    fn drop(&mut self) {
        // Every clone consumes by this path. With no escaped Weak, the final
        // Arc allocation physically exits before the moved Inner cleans up.
        if let Some(inner) = self.0.take().and_then(Arc::into_inner) {
            drop(inner);
        }
    }
}
impl ModelInput {
    fn inner(&self) -> &Inner {
        self.0.as_ref().expect("live model outer")
    }
    pub(crate) fn facts(&self) -> NativeModelFacts<'_> {
        NativeModelFacts::new(
            &self
                .inner()
                .resources
                .as_ref()
                .expect("live model input")
                .facts,
        )
    }
    pub(crate) fn reference(&self) -> &AssetRef {
        self.inner()
            .resources
            .as_ref()
            .expect("live model input")
            .source
            .reference()
    }
    /// Borrowed read lease over the pinned canonical texture bytes. The permit
    /// cannot outlive this input and exposes no File, path or closure owner.
    pub(crate) fn texture_read_permit(&self) -> TextureReadPermit<'_> {
        TextureReadPermit { input: self }
    }
    /// Borrowed read-only index of the unique Package texture entries. This is
    /// the future loader/Broker resource list; it grants no decoder or GPU.
    pub(crate) fn texture_resources(&self) -> ModelTextureResources<'_> {
        ModelTextureResources { input: self }
    }
    /// Session/generation-bound lease over the exact texture index. The plan
    /// owns one input clone, so pins, facts and their charges stay alive until
    /// the last plan owner drops.
    pub(crate) fn grant_texture_plan(
        &self,
        session: &str,
        generation: u64,
    ) -> Option<ModelTexturePlan> {
        if generation == 0 || session.is_empty() || session.len() > MAX_TEXTURE_PLAN_SESSION_BYTES {
            return None;
        }
        let mut stored = [0u8; MAX_TEXTURE_PLAN_SESSION_BYTES];
        stored[..session.len()].copy_from_slice(session.as_bytes());
        Some(ModelTexturePlan {
            input: self.clone(),
            session: stored,
            session_len: session.len() as u8,
            generation,
            active: AtomicBool::new(true),
        })
    }
    #[cfg(test)]
    pub(crate) fn reservation_identity_for_test(&self) -> (&str, u64, &str) {
        self.inner().retained.as_ref().unwrap().identity_for_test()
    }
    #[cfg(test)]
    pub(crate) fn texture_closure_for_test(&self) -> (usize, u32, u64) {
        let textures = &self
            .inner()
            .resources
            .as_ref()
            .expect("live model input")
            .textures;
        (
            textures.len(),
            textures.unique_entries(),
            textures.unique_source_bytes(),
        )
    }
}

/// Borrowed-only read lease. No Clone, owned extraction or mutable access to
/// the closure; the loader/Broker may read while the original input is alive.
pub(crate) struct TextureReadPermit<'a> {
    input: &'a ModelInput,
}

impl TextureReadPermit<'_> {
    pub(crate) fn texture_bytes(&self, image_index: usize) -> Option<u64> {
        self.input
            .inner()
            .resources
            .as_ref()
            .expect("live model input")
            .textures
            .texture_bytes(image_index)
    }

    pub(crate) fn read_into(
        &self,
        image_index: usize,
        offset: u64,
        output: &mut [u8],
        cancel: &AtomicBool,
    ) -> Result<(), JobError> {
        self.input
            .inner()
            .resources
            .as_ref()
            .expect("live model input")
            .textures
            .read_into(image_index, offset, output, cancel)
    }
}

/// Borrowed-only resource index. Exact canonical package paths only; there is
/// no URL parsing, path joining, prefix match or File escape here.
pub(crate) struct ModelTextureResources<'a> {
    input: &'a ModelInput,
}

#[derive(Clone, Copy)]
pub(crate) struct TextureResourceDescriptor<'a> {
    pub(crate) path: &'a str,
    pub(crate) mime: &'a str,
    pub(crate) bytes: u64,
    pub(crate) sha256: [u8; 32],
    pub(crate) references: u32,
    pub(crate) image_index: usize,
}

impl ModelTextureResources<'_> {
    pub(crate) fn len(&self) -> usize {
        self.input
            .inner()
            .resources
            .as_ref()
            .expect("live model input")
            .textures
            .unique_entries() as usize
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = TextureResourceDescriptor<'_>> + '_ {
        let input = self.input;
        let resources = input.inner().resources.as_ref().expect("live model input");
        let entries = resources.source.entries();
        resources
            .textures
            .unique_textures()
            .filter_map(move |view| {
                let entry = entries.get(view.entry_index as usize)?;
                Some(TextureResourceDescriptor {
                    path: &entry.path,
                    mime: entry.mime.as_deref().unwrap_or_default(),
                    bytes: view.bytes,
                    sha256: view.sha256,
                    references: view.references,
                    image_index: view.image_index as usize,
                })
            })
    }

    /// Exact package-relative path match against the unique closure entries.
    /// Any suffix, `..`, query, case fold or model-relative alias is not found.
    pub(crate) fn authorize(&self, path: &str) -> Option<TextureResource<'_>> {
        let resources = self.input.inner().resources.as_ref()?;
        let entries = resources.source.entries();
        let view = resources.textures.unique_textures().find(|view| {
            entries
                .get(view.entry_index as usize)
                .is_some_and(|entry| entry.path == path)
        })?;
        Some(TextureResource {
            input: self.input,
            image_index: view.image_index as usize,
            bytes: view.bytes,
        })
    }
}

/// One authorized texture resource. Borrowed from the input and read through
/// the existing positional permit; no new File/path owner exists.
pub(crate) struct TextureResource<'a> {
    input: &'a ModelInput,
    image_index: usize,
    bytes: u64,
}

impl TextureResource<'_> {
    pub(crate) fn image_index(&self) -> usize {
        self.image_index
    }

    pub(crate) fn bytes(&self) -> u64 {
        self.bytes
    }

    pub(crate) fn read_into(
        &self,
        offset: u64,
        output: &mut [u8],
        cancel: &AtomicBool,
    ) -> Result<(), JobError> {
        self.input
            .texture_read_permit()
            .read_into(self.image_index, offset, output, cancel)
    }
}

const MAX_TEXTURE_PLAN_SESSION_BYTES: usize = 128;
const PLAN_REVOKED_DIAGNOSTIC: &str = "canonical model texture plan was revoked";

/// One session/generation-bound texture plan. It owns an input clone, so the
/// canonical source, facts, File pins and closure charge cannot exit while any
/// plan owner exists. Revocation denies new permits and existing leases.
pub(crate) struct ModelTexturePlan {
    input: ModelInput,
    session: [u8; MAX_TEXTURE_PLAN_SESSION_BYTES],
    session_len: u8,
    generation: u64,
    active: AtomicBool,
}

impl ModelTexturePlan {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn matches(&self, session: &str, generation: u64) -> bool {
        self.active.load(Ordering::Acquire)
            && self.generation == generation
            && &self.session[..self.session_len as usize] == session.as_bytes()
    }

    pub(crate) fn resources(&self) -> ModelTextureResources<'_> {
        self.input.texture_resources()
    }

    /// Exact-path permit, only while this plan generation is active.
    pub(crate) fn permit(&self, path: &str) -> Option<ModelTextureLease<'_>> {
        if !self.active.load(Ordering::Acquire) {
            return None;
        }
        let resources = self.input.texture_resources();
        let resource = resources.authorize(path)?;
        Some(ModelTextureLease {
            plan: self,
            image_index: resource.image_index(),
            bytes: resource.bytes(),
        })
    }

    pub(crate) fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}

/// One read lease under an active plan. It borrows the plan, so it cannot
/// outlive it; reads re-check the plan's active flag after revocation.
pub(crate) struct ModelTextureLease<'a> {
    plan: &'a ModelTexturePlan,
    image_index: usize,
    bytes: u64,
}

impl ModelTextureLease<'_> {
    pub(crate) fn image_index(&self) -> usize {
        self.image_index
    }

    pub(crate) fn bytes(&self) -> u64 {
        self.bytes
    }

    pub(crate) fn read_into(
        &self,
        offset: u64,
        output: &mut [u8],
        cancel: &AtomicBool,
    ) -> Result<(), JobError> {
        if !self.plan.active.load(Ordering::Acquire) {
            return Err(JobError::new(
                "model_texture_revoked",
                PLAN_REVOKED_DIAGNOSTIC,
            ));
        }
        self.plan
            .input
            .texture_read_permit()
            .read_into(self.image_index, offset, output, cancel)
    }
}

/// Controller-owned current texture plan. A strictly newer generation replaces
/// the old plan and drops it outside the lock; revocation clears it. Reads are
/// synchronous under the lock, so no lease or File escapes to the caller.
pub(crate) struct ModelTextureController {
    inner: Mutex<Option<ModelTexturePlan>>,
}

impl ModelTextureController {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub(crate) fn install(&self, input: &ModelInput, session: &str, generation: u64) -> bool {
        let Some(plan) = input.grant_texture_plan(session, generation) else {
            return false;
        };
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner
            .as_ref()
            .is_some_and(|current| generation <= current.generation())
        {
            return false;
        }
        let old = inner.replace(plan);
        drop(inner);
        drop(old);
        true
    }

    /// Clear the current plan and release its input clone/charge. Returns
    /// whether a plan was installed.
    pub(crate) fn revoke(&self) -> bool {
        let old = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let installed = old.is_some();
        drop(old);
        installed
    }

    pub(crate) fn generation(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map_or(0, ModelTexturePlan::generation)
    }

    pub(crate) fn matches(&self, session: &str, generation: u64) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_some_and(|plan| plan.matches(session, generation))
    }

    /// Exact-path byte length under the current plan. No file read occurs.
    pub(crate) fn texture_len(&self, path: &str) -> Option<u64> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let plan = inner.as_ref()?;
        let resources = plan.input.texture_resources();
        resources.authorize(path).map(|resource| resource.bytes())
    }

    /// Visit the unique `(package_hash, canonical path)` broker keys of the
    /// current active plan under the controller lock. Absent or revoked plans
    /// visit nothing; no File, descriptor owner or allocation escapes.
    pub(crate) fn with_resource_keys(&self, mut visit: impl FnMut(&str, &str)) -> usize {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(plan) = inner.as_ref() else {
            return 0;
        };
        if !plan.active.load(Ordering::Acquire) {
            return 0;
        }
        let resources = plan.input.texture_resources();
        let hash = plan.input.reference().package_hash.as_str();
        let mut count = 0;
        for descriptor in resources.iter() {
            visit(hash, descriptor.path);
            count += 1;
        }
        count
    }

    /// Chunked loader reader over the current plan. Unknown paths and revoked
    /// plans yield no reader.
    pub(crate) fn chunk_reader<'a>(&'a self, path: &'a str) -> Option<ModelTextureChunkReader<'a>> {
        let total = self.texture_len(path)?;
        self.chunk_reader_range(path, 0, total)
    }

    /// Windowed reader for one exact path. `total` in the reader is the window
    /// end, so request ranges never escape the canonical byte length.
    pub(crate) fn chunk_reader_range<'a>(
        &'a self,
        path: &'a str,
        start: u64,
        length: u64,
    ) -> Option<ModelTextureChunkReader<'a>> {
        let total = self.texture_len(path)?;
        let end = start.checked_add(length)?;
        if end > total {
            return None;
        }
        Some(ModelTextureChunkReader {
            controller: self,
            path,
            offset: start,
            total: end,
        })
    }

    /// Exact-path synchronous read under the current plan. `None` means there
    /// is no plan or the path is not one of its indexed entries.
    pub(crate) fn read_into(
        &self,
        path: &str,
        offset: u64,
        output: &mut [u8],
        cancel: &AtomicBool,
    ) -> Result<Option<()>, JobError> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(plan) = inner.as_ref() else {
            return Ok(None);
        };
        let Some(lease) = plan.permit(path) else {
            return Ok(None);
        };
        lease.read_into(offset, output, cancel)?;
        Ok(Some(()))
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_none()
    }

    /// Whether an active plan is installed. Used by callers that must
    /// distinguish an unknown path from an unavailable/revoked plan.
    pub(crate) fn has_plan(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_some_and(|plan| plan.active.load(Ordering::Acquire))
    }
}

impl Default for ModelTextureController {
    fn default() -> Self {
        Self::new()
    }
}

/// Chunked loader reader over one authorized texture. Every chunk re-enters the
/// controller, so revocation mid-iteration stops the next read and no File,
/// path or closure owner escapes.
pub(crate) struct ModelTextureChunkReader<'a> {
    controller: &'a ModelTextureController,
    path: &'a str,
    offset: u64,
    total: u64,
}

impl ModelTextureChunkReader<'_> {
    pub(crate) fn total(&self) -> u64 {
        self.total
    }

    pub(crate) fn offset(&self) -> u64 {
        self.offset
    }

    pub(crate) fn remaining(&self) -> u64 {
        self.total - self.offset
    }

    /// Fill at most one Broker read (≤1 MiB) and advance the cursor. `0` means
    /// EOF or an empty output; revocation after creation returns a fixed error.
    pub(crate) fn next_chunk(
        &mut self,
        output: &mut [u8],
        cancel: &AtomicBool,
    ) -> Result<usize, JobError> {
        let limit = output.len().min(MAX_MODEL_TEXTURE_READ_BYTES);
        if limit == 0 || self.remaining() == 0 {
            return Ok(0);
        }
        let want = self.remaining().min(limit as u64) as usize;
        match self
            .controller
            .read_into(self.path, self.offset, &mut output[..want], cancel)?
        {
            Some(()) => {
                self.offset += want as u64;
                Ok(want)
            }
            None => Err(JobError::new(
                "model_texture_revoked",
                "model texture plan is no longer current",
            )),
        }
    }
}

impl std::fmt::Debug for ModelTextureController {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ModelTextureController")
            .field("generation", &self.generation())
            .finish_non_exhaustive()
    }
}

// No Clone or public extraction: the returned diagnostic and its charged
// owner have exactly one owned transfer through the original worker/reply.
pub(crate) struct ModelPreparationError {
    error: Option<JobError>,
    guard: Option<ModelErrorGuard>,
}
pub(super) enum ModelErrorGuard {
    Source(CanonicalModelSource),
    Workspace(Reservation),
}
impl ModelErrorGuard {
    pub(super) fn finish(self) {
        match self {
            Self::Source(source) => drop(source),
            Self::Workspace(workspace) => workspace.finish(),
        }
    }
    #[cfg(test)]
    fn identity_for_test(&self) -> (&str, u64, &str) {
        match self {
            Self::Source(source) => source.reservation_identity_for_test(),
            Self::Workspace(workspace) => workspace.identity_for_test(),
        }
    }
}
impl Drop for ModelPreparationError {
    fn drop(&mut self) {
        drop(self.error.take());
        if let Some(guard) = self.guard.take() {
            guard.finish();
        }
    }
}
impl std::fmt::Debug for ModelPreparationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelPreparationError")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}
impl ModelPreparationError {
    pub(crate) fn job_error(&self) -> &JobError {
        self.error.as_ref().expect("live model error")
    }
    pub(super) fn from_parts(error: JobError, guard: Option<ModelErrorGuard>) -> Self {
        Self {
            error: Some(error),
            guard,
        }
    }
    pub(super) fn into_parts(mut self) -> (JobError, Option<ModelErrorGuard>) {
        (
            self.error.take().expect("live model error"),
            self.guard.take(),
        )
    }
    #[cfg(test)]
    pub(crate) fn reservation_identity_for_test(&self) -> Option<(&str, u64, &str)> {
        self.guard.as_ref().map(ModelErrorGuard::identity_for_test)
    }
}
impl From<JobError> for ModelPreparationError {
    fn from(error: JobError) -> Self {
        Self::from_parts(error, None)
    }
}
fn fixed_error(code: &'static str) -> JobError {
    JobError::new(code, MODEL_DIAGNOSTIC)
}
fn normalized(error: hertz_wallpaper::PackageError) -> JobError {
    let code = error.code;
    drop(error);
    fixed_error(code)
}
fn cancelled(cancel: &AtomicBool) -> Result<(), JobError> {
    if cancel.load(Ordering::Acquire) {
        Err(fixed_error("cancelled"))
    } else {
        Ok(())
    }
}
fn model_controls() -> Result<u64, JobError> {
    let arc = arc_allocation_bytes::<Inner>().ok_or_else(|| fixed_error("model_heap_limit"))?;
    let grant = budget::ordinary_memory_grant_diagnostic_heap_bytes()
        .ok_or_else(|| fixed_error("model_heap_limit"))?;
    [
        MODEL_REQUEST_STRINGS,
        MODEL_QUERY_DIAGNOSTIC,
        grant,
        MODEL_DIAGNOSTIC.len() as u64,
    ]
    .iter()
    .try_fold(arc, |n, &term| {
        n.checked_add(term)
            .ok_or_else(|| fixed_error("model_heap_limit"))
    })
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ModelStage {
    SourceReady,
    ReadReturned,
    Compacted,
}

impl AssetStore {
    // Deliberately inline: a rejecting grant cannot require another Box/error
    // allocation. Actual enlarged channel requests are measured separately.
    #[allow(clippy::result_large_err)]
    pub(crate) fn prepare_canonical_model_input(
        &self,
        reference: &AssetRef,
        probe: &ProbeClient,
        preparation: &Reservation,
        cancel: &AtomicBool,
    ) -> Result<ModelInput, ModelPreparationError> {
        self.prepare_model_input_inner(
            reference,
            probe,
            preparation,
            cancel,
            #[cfg(test)]
            None,
        )
    }

    #[allow(clippy::result_large_err)] // Same single inline guard through all factory exits.
    fn prepare_model_input_inner(
        &self,
        reference: &AssetRef,
        probe: &ProbeClient,
        preparation: &Reservation,
        cancel: &AtomicBool,
        #[cfg(test)] mut observer: Option<&mut dyn FnMut(ModelStage)>,
    ) -> Result<ModelInput, ModelPreparationError> {
        let controls = model_controls()?;
        let mut source =
            self.pin_model_input_source(reference, probe, preparation, cancel, controls)?;
        #[cfg(test)]
        if let Some(observer) = observer.as_mut() {
            observer(ModelStage::SourceReady);
        }
        // Full MAX_TEXT_BYTES owner query with the immutable canonical Manifest.
        // Source Wc and identity Wi have already physically finished here.
        let requested =
            ModelHeapBounds::for_json_bytes(hertz_wallpaper::MAX_TEXT_BYTES, source.manifest())
                .and_then(|bounds| {
                    bounds.workspace_with_live_base(source.retained_source_charge())
                });
        let requested = match requested {
            Ok(requested) => requested,
            Err(error) => {
                return Err(ModelPreparationError::from_parts(
                    normalized(error),
                    Some(ModelErrorGuard::Source(source)),
                ))
            }
        };
        let workspace = match probe.job_memory(preparation, "model-inspection", requested, 0) {
            Ok(workspace) => workspace,
            Err(error) => {
                return Err(ModelPreparationError::from_parts(
                    error,
                    Some(ModelErrorGuard::Source(source)),
                ))
            }
        };
        // Move source into the scope: every partial/full fact and source owner
        // drops before returning a W-only guarded error. W explicitly includes
        // the entire source charge, including Cmodel, so attribution survives.
        let outcome = (move || {
            cancelled(cancel)?;
            #[cfg(test)]
            let checked = if let Some(observer) = observer.as_mut() {
                source
                    .inspect_model_content_observed(cancel, &mut || {
                        observer(ModelStage::ReadReturned)
                    })
                    .map_err(normalized)?
            } else {
                source.inspect_model_content(cancel).map_err(normalized)?
            };
            #[cfg(not(test))]
            let checked = source.inspect_model_content(cancel).map_err(normalized)?;
            let compact = checked.into_compact();
            #[cfg(test)]
            if let Some(observer) = observer.as_mut() {
                observer(ModelStage::Compacted);
            }
            cancelled(cancel)?;
            let retained_bytes = compact
                .retained_requested_bytes()
                .map_err(|_| fixed_error("model_heap_limit"))?;
            // Canonical Package texture closure: every image record binds to
            // the installed identity's archive-verified entry tuple, and each
            // unique installed projection File is pinned and fully re-hashed.
            // All three closure backings are admitted on the probe's own ledger
            // before they exist.
            let textures = texture_closure::build(
                self.root(),
                reference.package_hash.as_str(),
                &compact.structure().images,
                source.entries(),
                &probe.budget_handle(),
                cancel,
            )?;
            // Source R already carries the actual native Arc and W/R request
            // string floor. This own facts-R accounts the compact heap only.
            let retained = probe.job_memory(preparation, "model-input", 0, retained_bytes)?;
            let inner = Inner {
                resources: Some(Resources {
                    facts: compact,
                    textures,
                    source,
                }),
                retained: Some(retained),
            };
            // Cancellation drops inner's resources then own facts-R before W.
            cancelled(cancel)?;
            Ok(ModelInput(Some(Arc::new(inner))))
        })();
        match outcome {
            Ok(input) => {
                workspace.finish();
                Ok(input)
            }
            Err(error) => Err(ModelPreparationError::from_parts(
                error,
                Some(ModelErrorGuard::Workspace(workspace)),
            )),
        }
    }
}

#[cfg(test)]
#[path = "model_prepare_tests.rs"]
mod tests;
