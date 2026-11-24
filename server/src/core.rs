use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::multipart::{Form, Part};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use tokio::sync::OwnedSemaphorePermit;
use tokio_util::sync::CancellationToken;

pub(crate) const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_REDIRECTS: usize = 10;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Kv {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) value: String,
    #[serde(default = "defaultTrue")]
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FormField {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) value: String,
    #[serde(default)]
    pub(crate) kind: String,
    pub(crate) file_name: Option<String>,
    pub(crate) content_type: Option<String>,
    pub(crate) base64: Option<String>,
    #[serde(default = "defaultTrue")]
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BinaryFile {
    pub(crate) content_type: Option<String>,
    pub(crate) base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendRequest {
    pub(crate) method: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) headers: Vec<Kv>,
    #[serde(default)]
    pub(crate) query: Vec<Kv>,
    #[serde(default)]
    pub(crate) body_type: String,
    #[serde(default)]
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) form_fields: Vec<FormField>,
    pub(crate) binary: Option<BinaryFile>,
    #[serde(default)]
    pub(crate) timeout_ms: u64,
    #[serde(default = "defaultTrue")]
    pub(crate) follow_redirects: bool,
    #[serde(default)]
    pub(crate) insecure: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KvOut {
    key: String,
    value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendResponse {
    pub(crate) ok: bool,
    pub(crate) status: u16,
    status_text: String,
    pub(crate) headers: Vec<KvOut>,
    pub(crate) body_base64: String,
    pub(crate) content_type: String,
    pub(crate) time_ms: u128,
    pub(crate) size_bytes: usize,
    pub(crate) truncated: bool,
    pub(crate) final_url: String,
    pub(crate) error: Option<String>,
}

fn defaultTrue() -> bool {
    true
}

impl SendResponse {
    pub(crate) fn fail(started: Instant, message: String) -> Self {
        SendResponse {
            ok: false,
            status: 0,
            status_text: String::new(),
            headers: Vec::new(),
            body_base64: String::new(),
            content_type: String::new(),
            time_ms: started.elapsed().as_millis(),
            size_bytes: 0,
            truncated: false,
            final_url: String::new(),
            error: Some(message),
        }
    }
}

fn sharedClient(follow_redirects: bool, insecure: bool) -> &'static Client {
    static FOLLOW: OnceLock<Client> = OnceLock::new();
    static NO_FOLLOW: OnceLock<Client> = OnceLock::new();
    static FOLLOW_INSECURE: OnceLock<Client> = OnceLock::new();
    static NO_FOLLOW_INSECURE: OnceLock<Client> = OnceLock::new();
    let cell = match (follow_redirects, insecure) {
        (true, false) => &FOLLOW,
        (false, false) => &NO_FOLLOW,
        (true, true) => &FOLLOW_INSECURE,
        (false, true) => &NO_FOLLOW_INSECURE,
    };
    cell.get_or_init(|| {
        let policy = if follow_redirects {
            Policy::limited(MAX_REDIRECTS)
        } else {
            Policy::none()
        };
        let mut builder = Client::builder().redirect(policy);
        if insecure {
            builder = builder.danger_accept_invalid_certs(true);
        }
        builder.build().expect("构建 reqwest Client 失败")
    })
}

fn errorChain(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = std::error::Error::source(err);
    while let Some(e) = source {
        parts.push(e.to_string());
        source = e.source();
    }
    parts.join(": ")
}

fn hasHeader(headers: &[Kv], name: &str) -> bool {
    headers
        .iter()
        .any(|h| h.enabled && h.key.eq_ignore_ascii_case(name))
}

fn reserveBudget(budget: &AtomicUsize, want: usize) -> usize {
    if want == 0 {
        return 0;
    }
    let mut cur = budget.load(Ordering::Relaxed);
    loop {
        if cur == 0 {
            return 0;
        }
        let take = want.min(cur);
        match budget.compare_exchange_weak(cur, cur - take, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return take,
            Err(updated) => cur = updated,
        }
    }
}

pub(crate) fn encoded_request_size(req: &SendRequest) -> usize {
    let headers = req.headers.iter().fold(0usize, |total, h| {
        total
            .saturating_add(h.key.len())
            .saturating_add(h.value.len())
    });
    let query = req.query.iter().fold(0usize, |total, q| {
        total
            .saturating_add(q.key.len())
            .saturating_add(q.value.len())
    });
    let formFields = req.form_fields.iter().fold(0usize, |total, f| {
        total
            .saturating_add(f.key.len())
            .saturating_add(f.value.len())
            .saturating_add(f.file_name.as_deref().unwrap_or("").len())
            .saturating_add(f.content_type.as_deref().unwrap_or("").len())
            .saturating_add(f.base64.as_deref().unwrap_or("").len())
    });
    let binary = req.binary.as_ref().map_or(0, |b| {
        b.base64
            .len()
            .saturating_add(b.content_type.as_deref().unwrap_or("").len())
    });
    req.method
        .len()
        .saturating_add(req.url.len())
        .saturating_add(req.body.len())
        .saturating_add(headers)
        .saturating_add(query)
        .saturating_add(formFields)
        .saturating_add(binary)
}

fn encodedFormValueLen(value: &str) -> usize {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .map(|part| part.len())
        .sum()
}

fn estimatedBase64DecodedLen(base64: &str) -> u64 {
    (base64.len() as u64).saturating_add(3) / 4 * 3
}

fn estimatedPreparedRequestSize(req: &SendRequest) -> Result<u64, String> {
    let headers = req.headers.iter().fold(0u64, |total, header| {
        total
            .saturating_add(header.key.len() as u64)
            .saturating_add(header.value.len() as u64)
    });
    let query = req
        .query
        .iter()
        .filter(|query| query.enabled && !query.key.is_empty())
        .fold(0u64, |total, query| {
            total
                .saturating_add(encodedFormValueLen(&query.key) as u64)
                .saturating_add(1)
                .saturating_add(encodedFormValueLen(&query.value) as u64)
                .saturating_add(1)
        });
    let bodyType = if req.body_type.is_empty() {
        "none"
    } else {
        req.body_type.as_str()
    };
    let body = match bodyType {
        "json" | "raw" => req.body.len() as u64,
        "urlencoded" => {
            let fields: Vec<&FormField> = req
                .form_fields
                .iter()
                .filter(|field| field.enabled && field.kind != "file" && !field.key.is_empty())
                .collect();
            fields
                .iter()
                .enumerate()
                .fold(0u64, |total, (index, field)| {
                    total
                        .saturating_add(encodedFormValueLen(&field.key) as u64)
                        .saturating_add(1)
                        .saturating_add(encodedFormValueLen(&field.value) as u64)
                        .saturating_add(u64::from(index + 1 < fields.len()))
                })
        }
        "form" => req
            .form_fields
            .iter()
            .try_fold(0u64, |total, field| -> Result<u64, String> {
                if !field.enabled || field.key.is_empty() {
                    return Ok(total);
                }
                let contentSize = if field.kind == "file" {
                    let base64 = field.base64.as_deref().unwrap_or("");
                    estimatedBase64DecodedLen(base64)
                } else {
                    field.value.len() as u64
                };
                Ok(total
                    .saturating_add(512)
                    .saturating_add(field.key.len().saturating_mul(3) as u64)
                    .saturating_add(field.file_name.as_deref().unwrap_or("").len() as u64)
                    .saturating_add(field.content_type.as_deref().unwrap_or("").len() as u64)
                    .saturating_add(contentSize))
            })?,
        "binary" => {
            let base64 = req
                .binary
                .as_ref()
                .map_or("", |binary| binary.base64.as_str());
            estimatedBase64DecodedLen(base64)
        }
        _ => 0,
    };
    Ok((req.method.len().saturating_mul(2) as u64)
        .saturating_add(req.url.len() as u64)
        .saturating_add(headers)
        .saturating_add(query)
        .saturating_add(body))
}

fn validatePreparedRequestEstimate(req: &SendRequest) -> Result<(), String> {
    if estimatedPreparedRequestSize(req)? > MAX_REQUEST_BYTES as u64 {
        return Err(format!(
            "编码后请求数据超过上限 {}MB",
            MAX_REQUEST_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) enum BodyMode {
    Full,
    Limited {
        max: usize,
        budget: Arc<AtomicUsize>,
    },
}

async fn waitForCancel(token: Option<&CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

struct PreparedRequest {
    client: Client,
    method: Method,
    url: Url,
    headers: HeaderMap,
    timeout: Duration,
    body: Option<Bytes>,
}

fn prepared_request_size(req: &PreparedRequest) -> u64 {
    let headers = req.headers.iter().fold(0u64, |total, (name, value)| {
        total
            .saturating_add(name.as_str().len() as u64)
            .saturating_add(value.len() as u64)
    });
    [
        req.method.as_str().len() as u64,
        req.url.as_str().len() as u64,
        headers,
        req.body.as_ref().map_or(0, |body| body.len() as u64),
    ]
    .into_iter()
    .fold(0u64, |total, size| total.saturating_add(size))
}

fn prepareRequest(req: SendRequest) -> Result<PreparedRequest, String> {
    let SendRequest {
        method,
        url,
        headers: userHeaders,
        query,
        body_type,
        body,
        form_fields,
        binary,
        timeout_ms,
        follow_redirects,
        insecure,
    } = req;

    let method = Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("非法请求方式: {method}"))?;
    let mut url = Url::parse(url.trim()).map_err(|e| format!("URL 解析失败: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("仅支持 http/https 协议: {}", url.scheme()));
    }
    let queryPairs: Vec<(String, String)> = query
        .iter()
        .filter(|q| q.enabled && !q.key.is_empty())
        .map(|q| (q.key.clone(), q.value.clone()))
        .collect();
    if !queryPairs.is_empty() {
        url.query_pairs_mut().extend_pairs(queryPairs.iter());
    }

    let bodyType = if body_type.is_empty() {
        "none"
    } else {
        body_type.as_str()
    };
    let mut headers = HeaderMap::new();
    for h in userHeaders
        .iter()
        .filter(|h| h.enabled && !h.key.is_empty())
    {
        let name = HeaderName::from_bytes(h.key.as_bytes())
            .map_err(|_| format!("非法 Header 名: {}", h.key))?;
        let value = HeaderValue::from_str(&h.value)
            .map_err(|_| format!("Header 值含非法字符: {}", h.key))?;
        if bodyType == "form" && name == CONTENT_TYPE {
            continue;
        }
        headers.append(name, value);
    }

    let preparedBody = match bodyType {
        "json" | "raw" => {
            if !hasHeader(&userHeaders, "content-type") {
                let ct = if bodyType == "json" {
                    "application/json"
                } else {
                    "text/plain; charset=utf-8"
                };
                headers.insert(CONTENT_TYPE, HeaderValue::from_static(ct));
            }
            Some(Bytes::from(body))
        }
        "urlencoded" => {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for f in form_fields
                .iter()
                .filter(|f| f.enabled && f.kind != "file" && !f.key.is_empty())
            {
                serializer.append_pair(&f.key, &f.value);
            }
            if !hasHeader(&userHeaders, "content-type") {
                headers.insert(
                    CONTENT_TYPE,
                    HeaderValue::from_static("application/x-www-form-urlencoded"),
                );
            }
            let encoded: String = serializer.finish();
            Some(Bytes::from(encoded))
        }
        "form" => {
            let mut form = Form::new();
            for f in form_fields
                .iter()
                .filter(|f| f.enabled && !f.key.is_empty())
            {
                if f.kind == "file" {
                    let b64 = f.base64.as_deref().unwrap_or("");
                    let bytes = B64
                        .decode(b64)
                        .map_err(|e| format!("文件字段 {} base64 解码失败: {e}", f.key))?;
                    let fileName = f.file_name.clone().unwrap_or_else(|| "file".to_string());
                    let mut part = Part::bytes(bytes).file_name(fileName);
                    if let Some(ct) = f.content_type.as_deref().filter(|s| !s.is_empty()) {
                        part = part
                            .mime_str(ct)
                            .map_err(|e| format!("文件字段 {} MIME 非法: {}", f.key, e))?;
                    }
                    form = form.part(f.key.clone(), part);
                } else {
                    form = form.text(f.key.clone(), f.value.clone());
                }
            }
            let contentType = format!("multipart/form-data; boundary={}", form.boundary());
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_str(&contentType)
                    .map_err(|_| "构建 multipart Content-Type 失败".to_string())?,
            );
            let bytes = futures_executor::block_on(async {
                let mut bytes = bytes::BytesMut::new();
                let mut stream = form.into_stream();
                while let Some(chunk) = stream.try_next().await? {
                    bytes.extend_from_slice(&chunk);
                }
                Ok::<_, reqwest::Error>(bytes.freeze())
            })
            .map_err(|e| format!("构建 multipart 请求失败: {e}"))?;
            Some(bytes)
        }
        "binary" => {
            let bin = binary.ok_or_else(|| "binary 模式缺少文件".to_string())?;
            let bytes = B64
                .decode(&bin.base64)
                .map_err(|e| format!("文件 base64 解码失败: {e}"))?;
            if !hasHeader(&userHeaders, "content-type") {
                let ct = bin
                    .content_type
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                headers.insert(
                    CONTENT_TYPE,
                    HeaderValue::from_str(&ct)
                        .map_err(|_| "binary Content-Type 非法".to_string())?,
                );
            }
            Some(Bytes::from(bytes))
        }
        _ => None,
    };

    Ok(PreparedRequest {
        client: sharedClient(follow_redirects, insecure).clone(),
        method,
        url,
        headers,
        timeout: Duration::from_millis(if timeout_ms == 0 {
            DEFAULT_TIMEOUT_MS
        } else {
            timeout_ms
        }),
        body: preparedBody,
    })
}

#[cfg(test)]
pub(crate) async fn execute(
    req: SendRequest,
    bodyMode: BodyMode,
    cancel: Option<&CancellationToken>,
) -> SendResponse {
    execute_with_guards(req, bodyMode, cancel, &[]).await
}

pub(crate) async fn execute_with_guards(
    req: SendRequest,
    bodyMode: BodyMode,
    cancel: Option<&CancellationToken>,
    workGuards: &[Arc<OwnedSemaphorePermit>],
) -> SendResponse {
    let started = Instant::now();
    if encoded_request_size(&req) > MAX_REQUEST_BYTES {
        return SendResponse::fail(
            started,
            format!("请求数据超过上限 {}MB", MAX_REQUEST_BYTES / 1024 / 1024),
        );
    }
    if let Err(message) = validatePreparedRequestEstimate(&req) {
        return SendResponse::fail(started, message);
    }
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return SendResponse::fail(started, "请求已取消".to_string());
    }
    let preparationGuards = workGuards.to_vec();
    let prepared = match tokio::task::spawn_blocking(move || {
        let _preparationGuards = preparationGuards;
        prepareRequest(req)
    })
    .await
    {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(message)) => return SendResponse::fail(started, message),
        Err(_) => return SendResponse::fail(started, "请求预处理任务失败".to_string()),
    };
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return SendResponse::fail(started, "请求已取消".to_string());
    }
    if prepared_request_size(&prepared) > MAX_REQUEST_BYTES as u64 {
        return SendResponse::fail(
            started,
            format!(
                "编码后请求数据超过上限 {}MB",
                MAX_REQUEST_BYTES / 1024 / 1024
            ),
        );
    }
    executePrepared(&prepared, bodyMode, cancel).await
}

async fn executePrepared(
    prepared: &PreparedRequest,
    bodyMode: BodyMode,
    cancel: Option<&CancellationToken>,
) -> SendResponse {
    let started = Instant::now();
    let mut builder = prepared
        .client
        .request(prepared.method.clone(), prepared.url.clone())
        .timeout(prepared.timeout)
        .headers(prepared.headers.clone());
    if let Some(body) = &prepared.body {
        builder = builder.body(body.clone());
    }

    let resp = tokio::select! {
        biased;
        _ = waitForCancel(cancel) => {
            return SendResponse::fail(started, "请求已取消".to_string());
        }
        result = builder.send() => match result {
            Ok(r) => r,
            Err(e) => {
                let msg = if e.is_timeout() {
                    format!("请求超时（{}ms）", prepared.timeout.as_millis())
                } else if e.is_connect() {
                    format!("连接失败: {}", errorChain(&e))
                } else if e.is_redirect() {
                    format!("重定向错误（超过 {MAX_REDIRECTS} 次或 Location 非法）: {}", errorChain(&e))
                } else {
                    errorChain(&e)
                };
                return SendResponse::fail(started, msg);
            }
        }
    };

    let status = resp.status().as_u16();
    let statusText = resp.status().canonical_reason().unwrap_or("").to_string();
    let finalUrl = resp.url().to_string();
    let headers: Vec<KvOut> = resp
        .headers()
        .iter()
        .map(|(k, v)| KvOut {
            key: k.as_str().to_string(),
            value: v.to_str().unwrap_or("<非 ASCII 值>").to_string(),
        })
        .collect();
    let contentType = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let cap = match bodyMode {
        BodyMode::Full => MAX_BODY_BYTES,
        BodyMode::Limited { max, .. } => max,
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = resp.bytes_stream();
    match bodyMode {
        BodyMode::Full => loop {
            let chunk = tokio::select! {
                biased;
                _ = waitForCancel(cancel) => {
                    return SendResponse::fail(started, "请求已取消".to_string());
                }
                chunk = stream.next() => match chunk {
                    Some(chunk) => chunk,
                    None => break,
                }
            };
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    return SendResponse::fail(
                        started,
                        format!("读取响应体失败: {}", errorChain(&e)),
                    )
                }
            };
            if buf.len() + chunk.len() > cap {
                let take = cap - buf.len();
                buf.extend_from_slice(&chunk[..take]);
                truncated = true;
                break;
            }
            buf.extend_from_slice(&chunk);
        },
        BodyMode::Limited { budget, .. } => {
            if budget.load(Ordering::Relaxed) == 0 {
                truncated = true;
            } else {
                loop {
                    let chunk = tokio::select! {
                        biased;
                        _ = waitForCancel(cancel) => {
                            return SendResponse::fail(started, "请求已取消".to_string());
                        }
                        chunk = stream.next() => match chunk {
                            Some(chunk) => chunk,
                            None => break,
                        }
                    };
                    let chunk = match chunk {
                        Ok(c) => c,
                        Err(e) => {
                            return SendResponse::fail(
                                started,
                                format!("读取响应体失败: {}", errorChain(&e)),
                            )
                        }
                    };
                    let want = cap.saturating_sub(buf.len()).min(chunk.len());
                    let take = want.min(reserveBudget(&budget, want));
                    buf.extend_from_slice(&chunk[..take]);
                    if buf.len() >= cap || take < want {
                        truncated = true;
                        break;
                    }
                }
            }
        }
    }

    SendResponse {
        ok: true,
        status,
        status_text: statusText,
        headers,
        body_base64: B64.encode(&buf),
        content_type: contentType,
        time_ms: started.elapsed().as_millis(),
        size_bytes: buf.len(),
        truncated,
        final_url: finalUrl,
        error: None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchRequest {
    #[serde(flatten)]
    pub(crate) req: SendRequest,
    #[serde(default)]
    pub(crate) count: u32,
    #[serde(default)]
    pub(crate) rounds: u32,
    #[serde(default)]
    pub(crate) interval_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchItem {
    index: u32,
    status: u16,
    time_ms: u128,
    size_bytes: usize,
    truncated: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchTimeStats {
    min: u128,
    max: u128,
    avg: u128,
    p50: u128,
    p90: u128,
    p95: u128,
    p99: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchSample {
    status: u16,
    content_type: String,
    body_base64: String,
    time_ms: u128,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchResponse {
    pub(crate) ok: bool,
    pub(crate) total: u32,
    pub(crate) success: u32,
    pub(crate) failed: u32,
    pub(crate) status_dist: std::collections::HashMap<String, u32>,
    pub(crate) errors: std::collections::HashMap<String, u32>,
    pub(crate) time_stats: Option<BatchTimeStats>,
    pub(crate) duration_ms: u128,
    pub(crate) rps: f64,
    pub(crate) sample: Option<BatchSample>,
    pub(crate) results: Vec<BatchItem>,
    pub(crate) error: Option<String>,
}

const MAX_BATCH_TOTAL: u32 = 1000;
const MAX_BATCH_INPUT_TOTAL: u64 = 64 * 1024 * 1024;
const SAMPLE_MAX_BYTES: usize = 512 * 1024;
const MAX_BATCH_INTERVAL_MS: u64 = 60_000;
pub(crate) const MAX_BATCH_SAMPLE_TOTAL: usize = 16 * 1024 * 1024;

fn exceedsBatchInputBudget(encodedSize: u64, totalRequests: u64) -> bool {
    encodedSize.saturating_mul(totalRequests) > MAX_BATCH_INPUT_TOTAL
}

fn batchRps(total: u32, activeDuration: Duration) -> f64 {
    total as f64 / activeDuration.as_millis().max(1) as f64 * 1000.0
}

fn batchFail(error: String) -> BatchResponse {
    BatchResponse {
        ok: false,
        total: 0,
        success: 0,
        failed: 0,
        status_dist: Default::default(),
        errors: Default::default(),
        time_stats: None,
        duration_ms: 0,
        rps: 0.0,
        sample: None,
        results: Vec::new(),
        error: Some(error),
    }
}

#[cfg(test)]
pub(crate) async fn run_batch(
    req: BatchRequest,
    cancel: Option<&CancellationToken>,
) -> BatchResponse {
    run_batch_with_guards(req, cancel, &[]).await
}

pub(crate) async fn run_batch_with_guards(
    req: BatchRequest,
    cancel: Option<&CancellationToken>,
    workGuards: &[Arc<OwnedSemaphorePermit>],
) -> BatchResponse {
    let BatchRequest {
        req: sendReq,
        count: requestedCount,
        rounds: requestedRounds,
        interval_ms,
    } = req;
    let encodedSize = encoded_request_size(&sendReq) as u64;
    if encodedSize > MAX_REQUEST_BYTES as u64 {
        return batchFail(format!(
            "请求数据超过上限 {}MB",
            MAX_REQUEST_BYTES / 1024 / 1024
        ));
    }
    if let Err(message) = validatePreparedRequestEstimate(&sendReq) {
        return batchFail(message);
    }
    let started = Instant::now();
    let count = requestedCount.clamp(1, MAX_BATCH_TOTAL);
    let rounds = requestedRounds.clamp(1, MAX_BATCH_TOTAL);
    if count.saturating_mul(rounds) > MAX_BATCH_TOTAL {
        return batchFail(format!("总请求数（并发数×轮数）超过上限 {MAX_BATCH_TOTAL}"));
    }
    let totalRequests = count.saturating_mul(rounds) as u64;
    if exceedsBatchInputBudget(encodedSize, totalRequests) {
        return batchFail(format!(
            "批量请求总输入超过上限 {}MB（请求大小×总请求数）",
            MAX_BATCH_INPUT_TOTAL / 1024 / 1024
        ));
    }
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return batchFail("批量请求已取消".to_string());
    }

    let preparationGuards = workGuards.to_vec();
    let prepared = tokio::select! {
        biased;
        _ = waitForCancel(cancel) => return batchFail("批量请求已取消".to_string()),
        prepared = tokio::task::spawn_blocking(move || {
            let _preparationGuards = preparationGuards;
            prepareRequest(sendReq)
        }) => {
            match prepared {
                Ok(Ok(value)) => Arc::new(value),
                Ok(Err(message)) => return batchFail(message),
                Err(_) => return batchFail("请求预处理任务失败".to_string()),
            }
        }
    };
    if cancel.is_some_and(CancellationToken::is_cancelled) {
        return batchFail("批量请求已取消".to_string());
    }
    let preparedSize = prepared_request_size(&prepared);
    if exceedsBatchInputBudget(preparedSize, totalRequests) {
        return batchFail(format!(
            "批量请求总输入超过上限 {}MB（编码后请求大小×总请求数）",
            MAX_BATCH_INPUT_TOTAL / 1024 / 1024
        ));
    }

    let mut results: Vec<BatchItem> = Vec::with_capacity((count * rounds) as usize);
    let mut okTimes: Vec<u128> = Vec::new();
    let mut statusDist: std::collections::HashMap<String, u32> = Default::default();
    let mut errors: std::collections::HashMap<String, u32> = Default::default();
    let mut sample: Option<BatchSample> = None;
    let sampleBudget = Arc::new(AtomicUsize::new(MAX_BATCH_SAMPLE_TOTAL));
    let mut activeDuration = Duration::ZERO;

    for round in 0..rounds {
        let roundStarted = Instant::now();
        let outs = tokio::select! {
            biased;
            _ = waitForCancel(cancel) => return batchFail("批量请求已取消".to_string()),
            outs = futures_util::future::join_all((0..count).map(|_| {
                executePrepared(
                    &prepared,
                    BodyMode::Limited {
                        max: SAMPLE_MAX_BYTES,
                        budget: sampleBudget.clone(),
                    },
                    cancel,
                )
            })) => outs
        };
        activeDuration += roundStarted.elapsed();
        for (i, mut out) in outs.into_iter().enumerate() {
            let idx = round * count + i as u32;
            let key = if out.ok {
                out.status.to_string()
            } else {
                "ERR".to_string()
            };
            *statusDist.entry(key).or_insert(0) += 1;
            if let Some(err) = &out.error {
                *errors.entry(err.clone()).or_insert(0) += 1;
            } else if (200..400).contains(&out.status) {
                okTimes.push(out.time_ms);
            }
            if sample.is_none() && out.ok && (200..400).contains(&out.status) {
                sample = Some(BatchSample {
                    status: out.status,
                    content_type: std::mem::take(&mut out.content_type),
                    body_base64: std::mem::take(&mut out.body_base64),
                    time_ms: out.time_ms,
                    truncated: out.truncated,
                });
            }
            results.push(BatchItem {
                index: idx,
                status: out.status,
                time_ms: out.time_ms,
                size_bytes: out.size_bytes,
                truncated: out.truncated,
                error: out.error.clone(),
            });
        }
        if round + 1 < rounds && interval_ms > 0 {
            tokio::select! {
                biased;
                _ = waitForCancel(cancel) => return batchFail("批量请求已取消".to_string()),
                _ = tokio::time::sleep(Duration::from_millis(interval_ms.min(MAX_BATCH_INTERVAL_MS))) => {}
            }
        }
    }

    let total = results.len() as u32;
    let success = statusDist
        .iter()
        .filter(|(k, _)| k.parse::<u16>().is_ok_and(|s| (200..400).contains(&s)))
        .map(|(_, v)| v)
        .sum();
    let failed = total - success;
    okTimes.sort_unstable();
    let timeStats = (!okTimes.is_empty()).then(|| {
        let pick = |p: f64| -> u128 {
            let idx = ((okTimes.len() as f64 * p).ceil() as usize)
                .saturating_sub(1)
                .min(okTimes.len() - 1);
            okTimes[idx]
        };
        let sum: u128 = okTimes.iter().sum();
        BatchTimeStats {
            min: okTimes[0],
            max: okTimes[okTimes.len() - 1],
            avg: sum / okTimes.len() as u128,
            p50: pick(0.50),
            p90: pick(0.90),
            p95: pick(0.95),
            p99: pick(0.99),
        }
    });
    let durationMs = started.elapsed().as_millis().max(1);

    BatchResponse {
        ok: true,
        total,
        success,
        failed,
        status_dist: statusDist,
        errors,
        time_stats: timeStats,
        duration_ms: durationMs,
        rps: batchRps(total, activeDuration),
        sample,
        results,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    fn requestFor(url: String) -> SendRequest {
        SendRequest {
            method: "GET".into(),
            url,
            headers: Vec::new(),
            query: Vec::new(),
            body_type: "none".into(),
            body: String::new(),
            form_fields: Vec::new(),
            binary: None,
            timeout_ms: 30_000,
            follow_redirects: true,
            insecure: false,
        }
    }

    async fn delayedResponseServer(
        delay: Duration,
    ) -> (String, oneshot::Receiver<()>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (acceptedTx, acceptedRx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await;
            acceptedTx.send(()).unwrap();
            tokio::time::sleep(delay).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nok",
                )
                .await;
        });
        (url, acceptedRx, server)
    }

    async fn streamingResponseServer(
        delay: Duration,
    ) -> (String, oneshot::Receiver<()>, tokio::task::JoinHandle<()>) {
        let bodyLength = 32 * 1024;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (startedTx, startedRx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await;
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {bodyLength}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nhello"
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            startedTx.send(()).unwrap();
            tokio::time::sleep(delay).await;
            socket.write_all(&vec![b'x'; bodyLength - 5]).await.unwrap();
        });
        (url, startedRx, server)
    }

    async fn countingServer() -> (
        String,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        oneshot::Receiver<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let serverAccepted = accepted.clone();
        let (notifiedTx, notifiedRx) = oneshot::channel();
        let mut notifiedTx = Some(notifiedTx);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nok",
                    )
                    .await;
                if serverAccepted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    if let Some(tx) = notifiedTx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        });
        (url, accepted, notifiedRx, server)
    }

    #[test]
    fn reserve_budget_never_exceeds_limit() {
        let budget = AtomicUsize::new(100);
        assert_eq!(reserveBudget(&budget, 40), 40);
        assert_eq!(reserveBudget(&budget, 40), 40);
        assert_eq!(reserveBudget(&budget, 40), 20);
        assert_eq!(reserveBudget(&budget, 40), 0);
        assert_eq!(budget.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn reserve_budget_zero_want_keeps_budget() {
        let budget = AtomicUsize::new(100);
        assert_eq!(reserveBudget(&budget, 0), 0);
        assert_eq!(budget.load(Ordering::Relaxed), 100);
    }

    #[test]
    fn reserve_budget_concurrent_never_overdraw() {
        let budget = Arc::new(AtomicUsize::new(1000));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let b = budget.clone();
                thread::spawn(move || {
                    let mut got = 0;
                    for _ in 0..100 {
                        got += reserveBudget(&b, 10);
                    }
                    got
                })
            })
            .collect();
        let total: usize = handles.into_iter().map(|h| h.join().unwrap()).sum();
        assert!(total <= 1000, "总预留 {total} 超过预算");
        assert_eq!(budget.load(Ordering::Relaxed), 1000 - total);
    }

    #[test]
    fn has_header_ignores_disabled_and_matches_case_insensitive() {
        let headers = vec![
            Kv {
                key: "Content-Type".into(),
                value: "a".into(),
                enabled: true,
            },
            Kv {
                key: "X-Off".into(),
                value: "b".into(),
                enabled: false,
            },
        ];
        assert!(hasHeader(&headers, "content-type"));
        assert!(hasHeader(&headers, "CONTENT-TYPE"));
        assert!(!hasHeader(&headers, "x-off"));
        assert!(!hasHeader(&headers, "accept"));
    }

    #[test]
    fn encoded_request_size_counts_binary_and_form_files() {
        let req = SendRequest {
            method: "POST".into(),
            url: "https://example.com".into(),
            headers: vec![Kv {
                key: "X-Test".into(),
                value: "1".into(),
                enabled: true,
            }],
            query: Vec::new(),
            body_type: "form".into(),
            body: String::new(),
            form_fields: vec![FormField {
                key: "file".into(),
                value: String::new(),
                kind: "file".into(),
                file_name: Some("a.bin".into()),
                content_type: None,
                base64: Some("AAAA".into()),
                enabled: true,
            }],
            binary: Some(BinaryFile {
                content_type: None,
                base64: "BBBB".into(),
            }),
            timeout_ms: 0,
            follow_redirects: true,
            insecure: false,
        };
        assert_eq!(
            encoded_request_size(&req),
            "POST".len()
                + "https://example.com".len()
                + "X-Test".len()
                + 1
                + "file".len()
                + "a.bin".len()
                + 4
                + 4
        );
    }

    #[test]
    fn prepared_size_estimate_counts_form_encoding_expansion() {
        assert_eq!(encodedFormValueLen("\n"), 3);
        let mut req = requestFor("https://example.com".into());
        req.body_type = "urlencoded".into();
        req.form_fields.push(FormField {
            key: "field".into(),
            value: "\n".repeat(1024),
            kind: "text".into(),
            file_name: None,
            content_type: None,
            base64: None,
            enabled: true,
        });
        assert!(estimatedPreparedRequestSize(&req).unwrap() >= 3072);
        assert!(validatePreparedRequestEstimate(&req).is_ok());
    }

    #[test]
    fn prepared_body_is_shared_without_copying() {
        let mut req = requestFor("https://example.com".into());
        req.body_type = "raw".into();
        req.body = "x".repeat(1024 * 1024);
        let prepared = prepareRequest(req).unwrap();
        let first = prepared.body.clone().unwrap();
        let second = prepared.body.clone().unwrap();
        assert_eq!(first.as_ptr(), second.as_ptr());
        assert_eq!(first.len(), 1024 * 1024);
    }

    #[test]
    fn prepared_size_counts_multipart_boundary_overhead() {
        let mut req = requestFor("https://example.com".into());
        req.body_type = "form".into();
        req.form_fields.push(FormField {
            key: "field".into(),
            value: "value".into(),
            kind: "text".into(),
            file_name: None,
            content_type: None,
            base64: None,
            enabled: true,
        });
        let encodedSize = encoded_request_size(&req) as u64;
        let prepared = prepareRequest(req).unwrap();
        assert!(prepared_request_size(&prepared) > encodedSize);
    }

    #[test]
    fn multipart_text_estimate_does_not_assume_encoding_expansion() {
        let mut req = requestFor("https://example.com".into());
        req.body_type = "form".into();
        req.form_fields.push(FormField {
            key: "field".into(),
            value: "x".repeat(1024),
            kind: "text".into(),
            file_name: None,
            content_type: None,
            base64: None,
            enabled: true,
        });
        assert!(estimatedPreparedRequestSize(&req).unwrap() < 2500);
    }

    #[test]
    fn batch_rps_uses_active_duration() {
        assert_eq!(batchRps(10, Duration::from_secs(1)), 10.0);
        assert_eq!(batchRps(10, Duration::ZERO), 10_000.0);
    }

    #[test]
    fn batch_input_budget_uses_total_request_count() {
        let half = MAX_BATCH_INPUT_TOTAL / 2;
        assert!(!exceedsBatchInputBudget(half, 2));
        assert!(exceedsBatchInputBudget(half + 1, 2));
        assert!(exceedsBatchInputBudget(u64::MAX, 2));
    }

    #[tokio::test]
    async fn uncancelled_inflight_request_completes() {
        let (url, _accepted, server) = delayedResponseServer(Duration::from_millis(50)).await;
        let out = execute(requestFor(url), BodyMode::Full, None).await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.status, 200);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_inflight_request_stops_promptly() {
        let (url, accepted, server) = delayedResponseServer(Duration::from_secs(5)).await;
        let token = CancellationToken::new();
        let taskToken = token.clone();
        let task = tokio::spawn(async move {
            execute(requestFor(url), BodyMode::Full, Some(&taskToken)).await
        });
        accepted.await.unwrap();
        token.cancel();
        let out = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("请求已取消"));
        server.abort();
    }

    #[tokio::test]
    async fn uncancelled_response_stream_completes() {
        let (url, _started, server) = streamingResponseServer(Duration::from_millis(50)).await;
        let out = execute(requestFor(url), BodyMode::Full, None).await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.size_bytes, 32 * 1024);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_response_stream_stops_promptly() {
        let (url, started, server) = streamingResponseServer(Duration::from_secs(5)).await;
        let token = CancellationToken::new();
        let taskToken = token.clone();
        let task = tokio::spawn(async move {
            execute(
                requestFor(url),
                BodyMode::Limited {
                    max: 512 * 1024,
                    budget: Arc::new(AtomicUsize::new(512 * 1024)),
                },
                Some(&taskToken),
            )
            .await
        });
        started.await.unwrap();
        token.cancel();
        let out = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("请求已取消"));
        server.abort();
    }

    async fn stalledBodyServer(
        bodyLength: usize,
        initialLength: usize,
    ) -> (
        String,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (startedTx, startedRx) = oneshot::channel();
        let (releaseTx, releaseRx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.set_nodelay(true).unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await;
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {bodyLength}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n"
            );
            let mut initial = headers.into_bytes();
            initial.extend_from_slice(&vec![b'x'; initialLength]);
            socket.write_all(&initial).await.unwrap();
            socket.flush().await.unwrap();
            startedTx.send(()).unwrap();
            let _ = releaseRx.await;
            let _ = socket
                .write_all(&vec![b'y'; bodyLength - initialLength])
                .await;
        });
        (url, startedRx, releaseTx, server)
    }

    #[tokio::test]
    async fn limited_body_stops_at_cap_while_full_body_waits_for_stream() {
        let bodyLength = 4096;
        let (url, _started, release, server) = stalledBodyServer(bodyLength, bodyLength / 2).await;
        let limited = execute(
            requestFor(url.clone()),
            BodyMode::Limited {
                max: 1024,
                budget: Arc::new(AtomicUsize::new(1024)),
            },
            None,
        )
        .await;
        assert!(limited.ok, "{:?}", limited.error);
        assert!(limited.truncated);
        assert_eq!(limited.size_bytes, 1024);
        assert_eq!(B64.decode(&limited.body_base64).unwrap().len(), 1024);

        release.send(()).unwrap();
        server.await.unwrap();

        let (controlUrl, _started, controlRelease, controlServer) =
            stalledBodyServer(bodyLength, bodyLength / 2).await;
        let mut control =
            tokio::spawn(
                async move { execute(requestFor(controlUrl), BodyMode::Full, None).await },
            );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut control)
                .await
                .is_err()
        );
        controlRelease.send(()).unwrap();
        let full = control.await.unwrap();
        assert!(full.ok, "{:?}", full.error);
        assert!(!full.truncated);
        assert_eq!(full.size_bytes, bodyLength);
        controlServer.await.unwrap();
    }

    #[tokio::test]
    async fn limited_body_does_not_wait_for_data_when_budget_is_zero() {
        let bodyLength = 4096;
        let (url, _started, release, server) = stalledBodyServer(bodyLength, bodyLength / 2).await;
        let out = tokio::time::timeout(
            Duration::from_secs(1),
            execute(
                requestFor(url),
                BodyMode::Limited {
                    max: 1024,
                    budget: Arc::new(AtomicUsize::new(0)),
                },
                None,
            ),
        )
        .await
        .unwrap();
        assert!(out.ok, "{:?}", out.error);
        assert!(out.truncated);
        assert_eq!(out.size_bytes, 0);
        release.send(()).unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn limited_body_stops_when_shared_budget_is_exhausted() {
        let bodyLength = 4096;
        let (url, _started, release, server) = stalledBodyServer(bodyLength, bodyLength / 2).await;
        let out = execute(
            requestFor(url),
            BodyMode::Limited {
                max: 1024,
                budget: Arc::new(AtomicUsize::new(512)),
            },
            None,
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        assert!(out.truncated);
        assert_eq!(out.size_bytes, 512);
        release.send(()).unwrap();
        server.await.unwrap();
    }

    async fn responseSequenceServer(
        responses: Vec<(u16, Vec<u8>)>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                socket.set_nodelay(true).unwrap();
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let headers = format!(
                    "HTTP/1.1 {status} Status\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(headers.as_bytes()).await;
                if body.len() > SAMPLE_MAX_BYTES {
                    let _ = socket.write_all(&body[..SAMPLE_MAX_BYTES]).await;
                    socket.flush().await.unwrap();
                    let _ = socket.write_all(&body[SAMPLE_MAX_BYTES..]).await;
                } else {
                    let _ = socket.write_all(&body).await;
                }
            }
        });
        (url, server)
    }

    #[tokio::test]
    async fn batch_sample_uses_first_2xx_or_3xx_response() {
        let (url, server) =
            responseSequenceServer(vec![(500, b"error".to_vec()), (204, Vec::new())]).await;
        let out = run_batch(
            BatchRequest {
                req: requestFor(url),
                count: 1,
                rounds: 2,
                interval_ms: 0,
            },
            None,
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.success, 1);
        assert_eq!(out.failed, 1);
        assert_eq!(out.sample.unwrap().status, 204);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn batch_marks_limited_result_and_sample_as_truncated() {
        let body = vec![b'x'; SAMPLE_MAX_BYTES + 1024];
        let (url, server) = responseSequenceServer(vec![(200, body)]).await;
        let out = run_batch(
            BatchRequest {
                req: requestFor(url),
                count: 1,
                rounds: 1,
                interval_ms: 0,
            },
            None,
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.results[0].size_bytes, SAMPLE_MAX_BYTES);
        assert!(out.results[0].truncated);
        assert!(out.sample.unwrap().truncated);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn batch_interval_can_be_cancelled_before_next_round() {
        let (url, accepted, firstRound, server) = countingServer().await;
        let token = CancellationToken::new();
        let taskToken = token.clone();
        let task = tokio::spawn(async move {
            run_batch(
                BatchRequest {
                    req: requestFor(url),
                    count: 1,
                    rounds: 2,
                    interval_ms: 60_000,
                },
                Some(&taskToken),
            )
            .await
        });
        firstRound.await.unwrap();
        tokio::task::yield_now().await;
        token.cancel();
        let out = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("批量请求已取消"));
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn batch_interval_control_group_runs_next_round() {
        let (url, _accepted, _firstRound, server) = countingServer().await;
        let out = run_batch(
            BatchRequest {
                req: requestFor(url),
                count: 1,
                rounds: 2,
                interval_ms: 10,
            },
            None,
        )
        .await;
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.total, 2);
        assert_eq!(out.success, 2);
        server.abort();
    }

    #[tokio::test]
    async fn cancelled_request_stops_before_network() {
        let started = Instant::now();
        let req = SendRequest {
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: Vec::new(),
            query: Vec::new(),
            body_type: "none".into(),
            body: String::new(),
            form_fields: Vec::new(),
            binary: None,
            timeout_ms: 30_000,
            follow_redirects: true,
            insecure: false,
        };
        let token = CancellationToken::new();
        token.cancel();
        let out = execute(req, BodyMode::Full, Some(&token)).await;
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("请求已取消"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
