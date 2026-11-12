// SPDX-License-Identifier: MIT
//! Canonical full checked facts bound to their original installed source.
//! Texture closure, loader, Broker, runtime and GPU gates remain closed.
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
    Arc,
};

// String::from(&str) requests the literal's exact byte length. Old model
// diagnostics drop before this is constructed. History/progress/DB copies
// and pre-source channel/frame/control admission remain onward frontiers.
const MODEL_DIAGNOSTIC: &str = "canonical model preparation failed";
const MODEL_QUERY_DIAGNOSTIC: u64 = 59;
const MODEL_REQUEST_STRINGS: u64 = 2 * (128 + 64);

#[path = "model_native_facts.rs"]
mod native_facts;
use native_facts::NativeModelFacts;

#[derive(Clone)]
pub(crate) struct ModelInput(Option<Arc<Inner>>);
struct Resources {
    facts: CompactCheckedGlbResource,
    source: CanonicalModelSource,
}
struct Inner {
    resources: Option<Resources>,
    retained: Option<Reservation>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let source_guard = if let Some(Resources { facts, source }) = self.resources.take() {
            drop(facts);
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
    #[cfg(test)]
    pub(crate) fn reservation_identity_for_test(&self) -> (&str, u64, &str) {
        self.inner().retained.as_ref().unwrap().identity_for_test()
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
            // Source R already carries the actual native Arc and W/R request
            // string floor. This own facts-R accounts the compact heap only.
            let retained = probe.job_memory(preparation, "model-input", 0, retained_bytes)?;
            let inner = Inner {
                resources: Some(Resources {
                    facts: compact,
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
