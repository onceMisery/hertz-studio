// SPDX-License-Identifier: MIT
//! AI candidate commands share management admission, history and the import worker.
use super::super::ai_receipts::AiReceipts;
use super::*;
use serde::Deserialize;
pub(super) async fn handle(
    state: &Arc<State>,
    request: &Request,
    owner: u64,
    native: Arc<super::super::generation::NativeGeneration>,
) -> Value {
    let result = async {
        state.check_owner(owner)?;
        if let Some(value) = state.begin_request(request)? {
            return Ok(value);
        }
        let result = execute(state, request, owner, native).await;
        let value = api::response(Some(&request.request_id), result, None);
        state.finish_request(request, &value);
        Ok::<_, JobError>(value)
    }
    .await;
    result.unwrap_or_else(|error| api::response(Some(&request.request_id), Err(error), None))
}
async fn execute(
    state: &Arc<State>,
    request: &Request,
    owner: u64,
    native: Arc<super::super::generation::NativeGeneration>,
) -> Result<Value, JobError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Job {
        job_id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Candidate {
        receipt_id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Save {
        receipt_id: String,
        title: String,
    }
    let jobs = Arc::clone(state.jobs().await?);
    native.bind_jobs(Arc::clone(&jobs));
    state.check_owner(owner)?;
    use super::super::ai_receipts::AiReceipts;
    let decode = |e: serde_json::Error| JobError::invalid_input(e.to_string());
    match request.command.as_str() {
        "wallpaper.ai.assets.list" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct List {
                #[serde(default)]
                cursor: Option<String>,
                #[serde(default)]
                limit: Option<u32>,
            }
            let input: List = serde_json::from_value(request.payload.clone()).map_err(decode)?;
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                runtime.block_on(
                    super::super::ai_asset_sets::AiAssetSets(jobs.library()).list(
                        jobs.assets(),
                        input.limit.unwrap_or(20),
                        input.cursor.as_deref(),
                    ),
                )
            })
            .await
            .map_err(|e| JobError::io(e.to_string()))?
        }
        "wallpaper.ai.asset-set.create" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Create {
                selections: Vec<super::super::ai_asset_sets::Selection>,
                rights_confirmed: bool,
            }
            let input: Create = serde_json::from_value(request.payload.clone()).map_err(decode)?;
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                runtime.block_on(async {
                    let _writer = jobs.assets().content_writer()?;
                    let sets = super::super::ai_asset_sets::AiAssetSets(jobs.library());
                    let snapshot = sets
                        .freeze(jobs.assets(), input.selections, input.rights_confirmed)
                        .await?;
                    let (service, response, epoch) = native.upload_asset_set(&snapshot)?;
                    sets.insert(&snapshot, &service, &response, || {
                        native.receive_permit(epoch, &std::sync::atomic::AtomicBool::new(false))
                    })
                    .await
                })
            })
            .await
            .map_err(|e| JobError::io(e.to_string()))?
        }
        "wallpaper.ai.receive" => {
            let value: Job = serde_json::from_value(request.payload.clone()).map_err(decode)?;
            let (job, completion) = jobs.receive_ai(native, value.job_id)?;
            let continuation = Arc::clone(state);
            let prepared_jobs = Arc::clone(&jobs);
            tokio::task::spawn_local(async move {
                if let Ok(Ok(value)) = completion.await {
                    if value["kind"] == "composition" && value["state"] == "preparing" {
                        if let Some(id) = value["receiptId"].as_str() {
                            prepare_candidate(continuation, prepared_jobs, id.to_owned());
                        }
                    }
                }
            });
            Ok(json!({"jobId":&*job,"state":"receiving"}))
        }
        "wallpaper.ai.candidates" => {
            if request.payload.as_object().is_none_or(|v| !v.is_empty()) {
                return Err(JobError::invalid_input("此操作不接受额外参数"));
            }
            let value = AiReceipts::new(jobs.library()).list().await?;
            if let Some(items) = value["candidates"].as_array() {
                for item in items {
                    if item["kind"] == "composition" && item["state"] == "preparing" {
                        if let Some(id) = item["receiptId"].as_str() {
                            prepare_candidate(Arc::clone(state), Arc::clone(&jobs), id.into());
                        }
                    }
                }
            }
            Ok(value)
        }
        "wallpaper.ai.candidate.delete" => {
            let value: Candidate =
                serde_json::from_value(request.payload.clone()).map_err(decode)?;
            AiReceipts::new(jobs.library())
                .delete(&value.receipt_id)
                .await
        }
        "wallpaper.ai.candidate.retry" => {
            let value: Candidate =
                serde_json::from_value(request.payload.clone()).map_err(decode)?;
            let result = AiReceipts::new(jobs.library())
                .retry_composition(&value.receipt_id)
                .await?;
            prepare_candidate(Arc::clone(state), jobs, value.receipt_id);
            Ok(result)
        }
        "wallpaper.ai.candidate.thumbnail" => {
            let value: Candidate =
                serde_json::from_value(request.payload.clone()).map_err(decode)?;
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                runtime.block_on(
                    AiReceipts::new(jobs.library())
                        .image_thumbnail(&value.receipt_id, jobs.assets()),
                )
            })
            .await
            .map_err(|e| JobError::io(e.to_string()))?
        }
        "wallpaper.ai.candidate.save" => {
            let value: Save = serde_json::from_value(request.payload.clone()).map_err(decode)?;
            let current = AiReceipts::new(jobs.library())
                .get(&value.receipt_id)
                .await?;
            if current["kind"] == "image" {
                if current["state"] == "saved" {
                    return Ok(current);
                }
                let (_, completion) = jobs.save_ai_image(value.receipt_id, value.title)?;
                return completion
                    .await
                    .map_err(|_| JobError::new("worker_unavailable", "图片保存线程已退出"))?;
            }
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                runtime.block_on(AiReceipts::new(jobs.library()).save(
                    &value.receipt_id,
                    value.title,
                    jobs.assets(),
                ))
            })
            .await
            .map_err(|e| JobError::io(e.to_string()))?
        }
        _ => Err(JobError::invalid_input("候选操作不受支持")),
    }
}
fn prepare_candidate(state: Arc<State>, jobs: Arc<ImportJobs>, id: String) {
    if !state
        .composition_preparing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone())
    {
        return;
    }
    tokio::task::spawn_local(async move {
        struct Guard(Arc<State>, String);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0
                    .composition_preparing
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&self.1);
            }
        }
        let _guard = Guard(state, id.clone());
        let runtime = tokio::runtime::Handle::current();
        let preparing_jobs = Arc::clone(&jobs);
        let preparing_id = id.clone();
        let result = tokio::task::spawn_blocking(move || {
            runtime.block_on(
                AiReceipts::new(preparing_jobs.library())
                    .prepare_composition(&preparing_id, Arc::clone(&preparing_jobs)),
            )
        })
        .await;
        if !matches!(result, Ok(Ok(_))) {
            let error = JobError::new(
                "preparation_failed",
                "组合准备未完成。请重新准备候选，或删除不需要的候选。",
            );
            if AiReceipts::new(jobs.library())
                .preparation_failed(&id, &error)
                .await
                .is_err()
            {
                crate::app::log("composition preparation failure could not be recorded");
            }
        }
    });
}
