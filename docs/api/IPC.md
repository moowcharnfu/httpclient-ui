# Tauri IPC 接口

本文档描述应用内部 WebView 与 Rust 命令之间的接口，不是对外 HTTP API。

## 1. 调用方式

Tauri 配置启用 `withGlobalTauri`，前端使用：

```js
const result = await window.__TAURI__.core.invoke('send_request', {
  req: JSON.stringify(payload),
  jobId: crypto.randomUUID(),
});
```

`req` 是 JSON 字符串，不是已解析对象。Rust 在阻塞线程中解析，避免 Tauri 先构造大型嵌套 DTO。

## 2. 通用约束

- `jobId` 不能为空，长度不能超过 128 字符。
- 同一时刻 `jobId` 必须唯一。
- 活动任务总数最多 32。
- `req` 字符串最多 256MB。
- 并发请求工作预算按 `req.len() × 3` 估算，总预算 768MB。
- 并发响应工作预算总预算 768MB；单请求估算预留 96MB，批量估算预留 64MB。
- 预算不足时立即失败，不在 IPC 层排队。
- 响应 guard 覆盖命令执行到结果返回前；Tauri 返回后的 IPC 序列化和 WebView 副本不在其直接约束内。
- 命令 Future 被丢弃时，任务注册通过 RAII 清理。

## 3. `send_request`

参数：

```ts
{
  req: string;
  jobId: string;
}
```

`req` 解析后的请求结构：

```ts
{
  method: string;
  url: string;
  headers?: Array<{ key: string; value?: string; enabled?: boolean }>;
  query?: Array<{ key: string; value?: string; enabled?: boolean }>;
  bodyType?: 'none' | 'json' | 'form' | 'urlencoded' | 'raw' | 'binary';
  body?: string;
  formFields?: Array<{
    key: string;
    value?: string;
    kind?: string;
    fileName?: string;
    contentType?: string;
    base64?: string;
    enabled?: boolean;
  }>;
  binary?: {
    contentType?: string;
    base64: string;
  };
  timeoutMs?: number;
  followRedirects?: boolean;
  insecure?: boolean;
}
```

响应：

```ts
{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Array<{ key: string; value: string }>;
  bodyBase64: string;
  contentType: string;
  timeMs: number;
  sizeBytes: number;
  truncated: boolean;
  finalUrl: string;
  error: string | null;
}
```

网络错误和取消也以 `ok=false` 的响应结构返回，便于统一展示和记录历史。

## 4. `batch_request`

参数与单请求相同，额外包含：

```ts
{
  count: number;
  rounds: number;
  intervalMs: number;
}
```

限制：

- `count` 和 `rounds` 各自限制在 1–1000；
- 乘积不得超过 1000；
- `intervalMs` 最大 60000；
- 请求大小 × 总请求数不得超过 64MB；
- multipart 生成后会按实际请求体再次检查。

响应：

```ts
{
  ok: boolean;
  total: number;
  success: number;
  failed: number;
  statusDist: Record<string, number>;
  errors: Record<string, number>;
  timeStats: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  } | null;
  durationMs: number;
  rps: number;
  sample: {
    status: number;
    contentType: string;
    bodyBase64: string;
    timeMs: number;
    truncated: boolean;
  } | null;
  results: Array<{
    index: number;
    status: number;
    timeMs: number;
    sizeBytes: number;
    truncated: boolean;
    error: string | null;
  }>;
  error: string | null;
}
```

批量每份响应最多保留 512KB，批次共享 16MB；达到上限或预算耗尽后停止读取并设置 `truncated=true`。该字段表示因上限停止读取，响应恰好等于上限时也可能为 `true`。`sizeBytes` 统一表示实际保留字节数。样本只取第一份 2xx/3xx 响应；`durationMs` 包含预处理和轮间隔，`rps` 不含这两个阶段。

## 5. `cancel_job`

参数：

```ts
{ jobId: string }
```

返回：

```ts
boolean
```

- `true`：任务存在，取消信号已设置。
- `false`：任务尚未注册或已经结束。

前端在任务尚未注册时会进行有限重试，确认取消成功后才进入“已取消”状态。

## 6. `exit_app`

无参数。Rust 先取消所有已注册任务，再请求退出应用。

## 7. 错误约定

- 参数解析失败：`请求参数解析失败: ...`。
- 任务 ID 重复：`任务 ID 已存在`。
- 任务数超限：`运行中的任务过多，请稍后重试`。
- 请求工作预算不足：`并发请求内存预算不足，请稍后重试`。
- 响应工作预算不足：`并发响应内存预算不足，请稍后重试`。
- 请求过大：`请求数据超过上限 256MB`。
- 批量输入超限：`批量请求总输入超过上限 64MB ...`。
- 网络取消：`请求已取消` 或 `批量请求已取消`。

## 8. 安全边界

这些命令只应由应用自身页面调用。Tauri capability 只授予 `main` 窗口的 `core:default`；没有启用任意文件系统或 Shell 能力。接口文档不代表应该向第三方网页暴露 IPC。
