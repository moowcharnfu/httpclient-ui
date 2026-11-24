function invokeCommand(command, args = {}) {
  return Promise.resolve().then(() => {
    const bridge = window.__TAURI__;
    if (!bridge || !bridge.core || typeof bridge.core.invoke !== 'function') {
      throw new Error('当前页面不在 HTTP Test 桌面应用中');
    }
    return bridge.core.invoke(command, args);
  }).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

function createJobId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function confirmCancellation(jobId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const accepted = await invokeCommand('cancel_job', { jobId });
    if (accepted) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function runJob(command, payload, signal) {
  if (signal && signal.aborted) {
    const error = new Error('已取消');
    error.name = 'AbortError';
    return Promise.reject(error);
  }

  const jobId = createJobId();
  let rawPayload;
  try {
    rawPayload = JSON.stringify(payload);
  } catch (error) {
    return Promise.reject(new Error(`请求参数序列化失败：${error.message}`));
  }
  const work = invokeCommand(command, { req: rawPayload, jobId });
  if (!signal) return work;

  let abortHandler;
  const aborted = new Promise((_, reject) => {
    abortHandler = () => {
      confirmCancellation(jobId).then((accepted) => {
        if (accepted) {
          rejectWithAbort(reject);
          return;
        }
        work.then(
          () => rejectWithAbort(reject),
          (error) => reject(error)
        );
      }).catch((error) => {
        const cancelError = new Error(`取消失败：${error.message || String(error)}`);
        cancelError.name = 'CancelError';
        reject(cancelError);
      });
    };
    signal.addEventListener('abort', abortHandler, { once: true });
  });

  return Promise.race([work, aborted]).finally(() => {
    signal.removeEventListener('abort', abortHandler);
  });
}

function rejectWithAbort(reject) {
  const error = new Error('已取消');
  error.name = 'AbortError';
  reject(error);
}

export function sendRequest(payload, signal) {
  return runJob('send_request', payload, signal);
}

export function sendBatch(payload, signal) {
  return runJob('batch_request', payload, signal);
}

export function exitApp() {
  return invokeCommand('exit_app');
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToText(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
