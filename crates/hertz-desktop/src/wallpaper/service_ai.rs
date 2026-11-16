// SPDX-License-Identifier: MIT
//! AI candidate commands share management admission, history and the import worker.
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
    state.check_owner(owner)?;
    use super::super::ai_receipts::AiReceipts;
    let decode = |e: serde_json::Error| JobError::invalid_input(e.to_string());
    match request.command.as_str() {
        "wallpaper.ai.receive" => {
            let value: Job = serde_json::from_value(request.payload.clone()).map_err(decode)?;
            let (job, _) = jobs.receive_ai(native, value.job_id)?;
            Ok(json!({"jobId":&*job,"state":"receiving"}))
        }
        "wallpaper.ai.candidates" => {
            if request.payload.as_object().is_none_or(|v| !v.is_empty()) {
                return Err(JobError::invalid_input("此操作不接受额外参数"));
            }
            AiReceipts::new(jobs.library()).list().await
        }
        "wallpaper.ai.candidate.delete" => {
            let value: Candidate =
                serde_json::from_value(request.payload.clone()).map_err(decode)?;
            AiReceipts::new(jobs.library())
                .delete(&value.receipt_id)
                .await
        }
        "wallpaper.ai.candidate.save" => {
            let value: Save = serde_json::from_value(request.payload.clone()).map_err(decode)?;
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
