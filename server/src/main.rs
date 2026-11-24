#![allow(non_snake_case)]

mod core;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use core::{BatchRequest, BatchResponse, SendRequest, SendResponse};
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager, RunEvent, State};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

const MAX_ACTIVE_JOBS: usize = 32;
const MAX_REQUEST_JSON_BYTES: usize = 256 * 1024 * 1024;
const MAX_CONCURRENT_REQUEST_WORK_BYTES: u32 = 768 * 1024 * 1024;
const REQUEST_WORK_MULTIPLIER: u32 = 3;
const MAX_CONCURRENT_RESPONSE_WORK_BYTES: u32 = 768 * 1024 * 1024;
const SINGLE_RESPONSE_WORK_RESERVE: u32 = 96 * 1024 * 1024;
const BATCH_RESPONSE_WORK_RESERVE: u32 = 64 * 1024 * 1024;

#[derive(Clone)]
struct JobState {
    tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    requestWork: Arc<Semaphore>,
    responseWork: Arc<Semaphore>,
}

impl Default for JobState {
    fn default() -> Self {
        Self {
            tokens: Arc::new(Mutex::new(HashMap::new())),
            requestWork: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUEST_WORK_BYTES as usize)),
            responseWork: Arc::new(Semaphore::new(MAX_CONCURRENT_RESPONSE_WORK_BYTES as usize)),
        }
    }
}

impl JobState {
    fn start(&self, jobId: &str) -> Result<CancellationToken, String> {
        let token = CancellationToken::new();
        let mut tokens = self
            .tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tokens.contains_key(jobId) {
            return Err("任务 ID 已存在".to_string());
        }
        if tokens.len() >= MAX_ACTIVE_JOBS {
            return Err("运行中的任务过多，请稍后重试".to_string());
        }
        tokens.insert(jobId.to_string(), token.clone());
        Ok(token)
    }

    fn finish(&self, jobId: &str) {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(jobId);
    }

    fn cancel(&self, jobId: &str) -> bool {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(jobId)
            .is_some_and(|token| {
                token.cancel();
                true
            })
    }

    fn cancelAll(&self) {
        let tokens = self
            .tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, token)| token)
            .collect::<Vec<_>>();
        for token in tokens {
            token.cancel();
        }
    }

    fn tryAcquireRequestWork(&self, bytes: usize) -> Result<Option<OwnedSemaphorePermit>, String> {
        if bytes == 0 {
            return Ok(None);
        }
        let permits = bytes.saturating_mul(REQUEST_WORK_MULTIPLIER as usize) as u32;
        self.requestWork
            .clone()
            .try_acquire_many_owned(permits)
            .map(Some)
            .map_err(|_| "并发请求内存预算不足，请稍后重试".to_string())
    }

    fn tryAcquireResponseWork(&self, bytes: u32) -> Result<OwnedSemaphorePermit, String> {
        self.responseWork
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(|_| "并发响应内存预算不足，请稍后重试".to_string())
    }
}

struct ActiveJob<'a> {
    state: &'a JobState,
    jobId: String,
}

impl Drop for ActiveJob<'_> {
    fn drop(&mut self) {
        self.state.finish(&self.jobId);
    }
}

fn validateRequestPayloadSize(bytes: usize) -> Result<(), String> {
    if bytes > MAX_REQUEST_JSON_BYTES {
        return Err(format!(
            "请求数据超过上限 {}MB",
            MAX_REQUEST_JSON_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn parseCommandRequest<T: DeserializeOwned>(raw: String) -> Result<T, String> {
    validateRequestPayloadSize(raw.len())?;
    serde_json::from_str(&raw).map_err(|error| format!("请求参数解析失败: {error}"))
}

fn validateJobId(jobId: &str) -> Result<(), String> {
    if jobId.is_empty() || jobId.len() > 128 {
        return Err("无效的任务 ID".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn send_request(
    req: String,
    jobId: String,
    state: State<'_, JobState>,
) -> Result<SendResponse, String> {
    validateJobId(&jobId)?;
    validateRequestPayloadSize(req.len())?;
    let requestWork = state.tryAcquireRequestWork(req.len())?.map(Arc::new);
    let responseWork = Arc::new(state.tryAcquireResponseWork(SINGLE_RESPONSE_WORK_RESERVE)?);
    let token = state.start(&jobId)?;
    let _active = ActiveJob {
        state: &state,
        jobId,
    };
    let parseGuards = requestWork
        .iter()
        .cloned()
        .chain(std::iter::once(responseWork.clone()))
        .collect::<Vec<_>>();
    let request: SendRequest = tokio::task::spawn_blocking(move || {
        let _parseGuards = parseGuards;
        parseCommandRequest(req)
    })
    .await
    .map_err(|_| "请求参数解析任务失败".to_string())??;
    let workGuards = requestWork
        .iter()
        .cloned()
        .chain(std::iter::once(responseWork.clone()))
        .collect::<Vec<_>>();
    let result =
        core::execute_with_guards(request, core::BodyMode::Full, Some(&token), &workGuards).await;
    Ok(result)
}

#[tauri::command]
async fn batch_request(
    req: String,
    jobId: String,
    state: State<'_, JobState>,
) -> Result<BatchResponse, String> {
    validateJobId(&jobId)?;
    validateRequestPayloadSize(req.len())?;
    let requestWork = state.tryAcquireRequestWork(req.len())?.map(Arc::new);
    let responseWork = Arc::new(state.tryAcquireResponseWork(BATCH_RESPONSE_WORK_RESERVE)?);
    let token = state.start(&jobId)?;
    let _active = ActiveJob {
        state: &state,
        jobId,
    };
    let parseGuards = requestWork
        .iter()
        .cloned()
        .chain(std::iter::once(responseWork.clone()))
        .collect::<Vec<_>>();
    let request: BatchRequest = tokio::task::spawn_blocking(move || {
        let _parseGuards = parseGuards;
        parseCommandRequest(req)
    })
    .await
    .map_err(|_| "请求参数解析任务失败".to_string())??;
    let workGuards = requestWork
        .iter()
        .cloned()
        .chain(std::iter::once(responseWork.clone()))
        .collect::<Vec<_>>();
    let result = core::run_batch_with_guards(request, Some(&token), &workGuards).await;
    Ok(result)
}

#[tauri::command]
fn cancel_job(jobId: String, state: State<'_, JobState>) -> Result<bool, String> {
    validateJobId(&jobId)?;
    Ok(state.cancel(&jobId))
}

#[tauri::command]
fn exit_app(app: AppHandle, state: State<'_, JobState>) {
    state.cancelAll();
    app.exit(0);
}

fn focusMainWindow(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let jobState = JobState::default();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focusMainWindow(app);
        }))
        .manage(jobState.clone())
        .invoke_handler(tauri::generate_handler![
            send_request,
            batch_request,
            cancel_job,
            exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("HTTP Test 应用构建失败");
    app.run(move |_app, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            jobState.cancelAll();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_request_rejects_invalid_json() {
        let result: Result<SendRequest, String> = parseCommandRequest("{".into());
        assert!(result.unwrap_err().contains("请求参数解析失败"));
    }

    #[test]
    fn duplicate_job_id_cannot_replace_running_token() {
        let state = JobState::default();
        let first = state.start("job").unwrap();
        assert!(state.start("job").is_err());
        assert!(state.cancel("job"));
        assert!(first.is_cancelled());
    }

    #[test]
    fn dropped_command_guard_releases_job_id() {
        let state = JobState::default();
        let token = state.start("job").unwrap();
        {
            let _active = ActiveJob {
                state: &state,
                jobId: "job".into(),
            };
            assert!(state.cancel("job"));
            assert!(token.is_cancelled());
        }
        assert!(state.start("job").is_ok());
    }

    #[test]
    fn active_jobs_have_a_hard_limit() {
        let state = JobState::default();
        for index in 0..MAX_ACTIVE_JOBS {
            assert!(state.start(&index.to_string()).is_ok());
        }
        assert!(state.start("overflow").is_err());
        state.cancelAll();
        assert!(state.start("after-exit").is_ok());
    }

    #[test]
    fn request_work_budget_is_released_with_the_permit() {
        let state = JobState::default();
        let permit = state
            .tryAcquireRequestWork(MAX_REQUEST_JSON_BYTES)
            .unwrap()
            .unwrap();
        assert!(state.tryAcquireRequestWork(1).is_err());
        drop(permit);
        assert!(state.tryAcquireRequestWork(1).is_ok());
    }

    #[test]
    fn response_work_budget_is_released_with_the_permit() {
        let state = JobState::default();
        let permits = (0..MAX_CONCURRENT_RESPONSE_WORK_BYTES / SINGLE_RESPONSE_WORK_RESERVE)
            .map(|_| {
                state
                    .tryAcquireResponseWork(SINGLE_RESPONSE_WORK_RESERVE)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(state
            .tryAcquireResponseWork(SINGLE_RESPONSE_WORK_RESERVE)
            .is_err());
        drop(permits);
        assert!(state
            .tryAcquireResponseWork(SINGLE_RESPONSE_WORK_RESERVE)
            .is_ok());
    }

    #[test]
    fn shared_guard_keeps_work_budget_until_last_owner_drops() {
        let state = JobState::default();
        let permit = Arc::new(
            state
                .tryAcquireRequestWork(MAX_REQUEST_JSON_BYTES)
                .unwrap()
                .unwrap(),
        );
        let detached = permit.clone();
        drop(permit);
        assert!(state.tryAcquireRequestWork(1).is_err());
        drop(detached);
        assert!(state.tryAcquireRequestWork(1).is_ok());
    }

    #[test]
    fn request_payload_limit_is_enforced_before_parsing() {
        assert!(validateRequestPayloadSize(MAX_REQUEST_JSON_BYTES).is_ok());
        assert!(validateRequestPayloadSize(MAX_REQUEST_JSON_BYTES + 1).is_err());
    }
}
