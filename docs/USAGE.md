# 使用说明

## 1. 发送第一个请求

1. 打开 HTTP Test。
2. 在地址栏输入 URL，例如 `https://example.com/api`。
3. 不带协议头时默认补 `http://`，例如 `127.0.0.1:8080/api`。
4. 选择请求方法，按需填写 Params、Headers 和 Body。
5. 点击“发送”，或按 `Ctrl+Enter`。
6. 在右侧查看状态、耗时、响应体、Headers 和脚本输出。

HTTP Test 自身不监听端口；地址栏中的端口是目标服务的端口。

## 2. URL 与 Params

- Params 与 URL 查询串双向同步。
- 禁用的参数不会发送。
- 空名称参数不会发送。
- 参数名和值会进行 URL 编码。
- URL 的 `#hash` 会保留在请求 URL 中，但不会作为 HTTP 请求内容发送。
- 前置脚本修改 URL 查询串时，以修改后的 URL 为准；只修改参数请修改 `req.query`。

## 3. Headers

- 支持重复 Header 名。
- Header 名不区分大小写。
- 禁用或空名称行不会发送。
- 手动设置的 `Content-Type` 优先于自动值。
- `form-data` 模式例外：`Content-Type` 始终由 Rust 生成的 multipart boundary 决定，避免手工 boundary 与请求体不一致。
- 非 ASCII Header 值会由 Rust 拒绝并显示错误。

## 4. Body 类型

| 类型 | 行为 |
| --- | --- |
| `none` | 不发送 Body |
| `json` | 默认 `application/json`，发送文本原貌 |
| `form-data` | multipart/form-data，支持文本与文件字段 |
| `urlencoded` | `application/x-www-form-urlencoded`，只发送文本字段 |
| `raw` | 默认 `text/plain; charset=utf-8` |
| `binary` | 单文件原始字节，默认使用文件 MIME 或 `application/octet-stream` |

### JSON 与表单互转

- JSON 对象可通过“→ form-data”或“→ urlencoded”转成表单字段。
- 表单可通过“→ JSON”转成 JSON 对象，所有值均为字符串。
- 只有 JSON 对象可直接转表单；数组和标量会提示错误。
- “格式化”使用无损 JSON 序列化，大整数不会转成 JavaScript Number。

### 变量替换

可用 `{{名称}}` 引用全局变量，变量名两侧允许空格。替换范围包括：

- URL、Body 文本；
- Header 名和值；
- Params 名和值；
- 表单字段名和文本值。

文件内容、文件名和 MIME 不做变量替换。未找到的变量保留原文，并在脚本输出中告警。

## 5. 文件上传

### 单次上传上限

- 默认 **1MB**。
- 在 Body 区域选择 `form-data` 或 `binary` 后，可调整“单次上传上限(MB)”。
- 可配置范围 **1–128MB**，随草稿保存在本机。
- 文件超过当前上限时，会提示当前文件大小、当前上限，并提示去 Body 区域调整上限。
- 降低上限后，已选文件不会自动删除，但发送前会再次校验；超限请求不会发出。
- multipart 表单全部启用文件合计上限 **160MB**。
- 上限是前端保护，Rust 仍有 256MB 请求输入和 IPC 上限。

### binary 单文件

1. 将 Body 类型切换为 `binary`。
2. 选择文件。
3. 文件读取完成后显示文件名和大小。
4. 点击发送。

### form-data 多文件

1. 将 Body 类型切换为 `form-data`。
2. 添加字段行，将字段类型选为“文件”。
3. 填写字段名并选择文件。
4. 可继续添加文本字段或其他文件。
5. “清除”会移除该行文件内容。

历史记录和草稿不保存文件 Base64。重新载入包含文件的历史或重启应用后，需要重新选择文件。

## 6. 超时、重定向与证书

- 超时单位为毫秒；`0` 使用默认值 `30000ms`。
- “跟随重定向”默认开启，最多跟随 10 次。
- “忽略证书”会跳过 TLS 证书校验，仅用于自签名证书或受控测试环境。
- 不要在正式环境长期开启“忽略证书”。

## 7. 全局变量

点击顶部“全局变量”打开抽屉。

- 支持新增、编辑、禁用和删除变量。
- `vars.get(key)`：返回启用中的变量值，不存在时返回 `undefined`。
- `vars.set(key, value)`：新增或更新变量，并自动持久化。
- `vars.remove(key)`：删除变量。
- `vars.all()`：返回启用变量的普通对象。
- 可导出 JSON 备份，也可从 JSON 文件导入。

变量值按字符串处理。变量与草稿、历史一样保存在 localStorage，未加密。

## 8. 前置脚本

前置脚本在变量替换和网络请求之前执行，可修改：

```js
req.method
req.url
req.headers
req.query
req.bodyType
req.body
req.formFields
```

可用 `vars` 和 `console`。示例：

```js
req.headers.push({
  key: 'X-Token',
  value: vars.get('token'),
  enabled: true,
});
req.query.push({ key: 'trace', value: String(Date.now()), enabled: true });
console.log('method', req.method);
```

脚本语法错误和运行异常会记录在“脚本输出”中，不会直接崩溃页面。前置、后置脚本日志各最多保留 2000 行；超出时会显示省略数量，异常和未解析变量告警仍会保留。

## 9. 后置脚本

后置脚本在成功响应返回后执行。`res` 提供：

```js
res.status
res.statusText
res.headers
res.getHeader(name)
res.bodyText
res.json()
res.timeMs
res.sizeBytes
res.finalUrl
res.truncated
```

`res.json()` 使用无损 JSON 解析器。大整数是 `LosslessNumber`：

```js
const data = res.json();
vars.set('token', data.token);
vars.set('orderId', String(data.orderId));
console.log('status', res.status);
```

批量请求不执行后置脚本。

## 10. 响应查看

右侧包含以下页签：

- **可视化**：JSON 树，可显示类型、展开、折叠、复制路径和复制原文。
- **原文**：响应解码后的文本。
- **Headers**：响应 Header 列表。
- **脚本输出**：前置、后置脚本日志和异常，日志各最多保留 2000 行。
- **并发**：批量统计。
- **差异对比**：历史响应比较。

响应体默认最多保留 32MB；超过上限会读取上限内的内容并标记 `truncated`。图片响应可通过 Blob 预览。

## 11. 历史记录

- 最多保存 10 条，按时间倒序。
- 可载入请求、删除单条、清空全部。
- 响应体不超过 512KB 时保留原文，供差异对比使用。
- 文件内容不保存，载入后需重新选择。
- 本地存储写入失败会显示提示；新增记录放不下时会从最旧记录开始淘汰，直到写入成功或清空历史。内存中的剩余记录仍可用于当前会话。
- 载入历史时，URL 与 Params 会一起恢复；旧记录若没有单独保存 Params，会从 URL 查询串重建。

## 12. 差异对比

1. 发送两次会产生 JSON 响应的请求。
2. 打开“历史记录”，把两份记录设为 A 和 B；也可在“差异对比”页签选择。
3. 点击“对比”，或“最近两次”。

比较结果按 JSON 路径展示：新增、删除、值变更、类型变更。数字按原始文本精确比较，`1` 与 `1.0` 会被视为不同。最多显示前 2000 条差异。

## 13. 并发与定时批量

点击“并发”打开批量抽屉：

- 每轮并发数：1–1000。
- 轮数：1–1000。
- 并发数 × 轮数：总计不超过 1000。
- 轮间隔：0–60000ms。
- 批量输入预算：请求大小 × 总请求数不超过 64MB；multipart 会按编码后的实际请求体再次复核。
- 每份批量响应最多保留 512KB，整个批次共享 16MB 样本预算；达到上限或预算耗尽后停止读取，明细和样本会标记“已达上限”；恰好等于上限时也可能出现该标记。
- 只保留第一份 2xx/3xx 响应作为样本；4xx/5xx 计入失败数，不作为样本。
- 明细中的“大小”是实际保留字节数，不是完整响应大小。

前置脚本和变量替换只执行一次，后置脚本不执行。结果包含状态分布、错误聚合、RPS、总耗时和成功请求耗时分位数。`总耗时` 包含预处理和轮间隔；`RPS` 只按各轮请求执行时间计算，不含预处理和轮间隔。

定时示例：并发数 1、轮数 10、间隔 500，表示每 500ms 发送 1 个，共 10 个。

## 14. 从 cURL 导入

1. 点击顶部“导入 cURL”。
2. 粘贴浏览器开发者工具中的“复制为 cURL”命令，或其他单条 curl 命令。
3. 点击“解析并导入”；cURL 抽屉打开时也可按 `Ctrl+Enter`。
4. 检查自动填充的方法、URL、Params、Headers 和 Body，再点击“发送”。

支持单引号、双引号、转义和反斜杠换行。常用映射：

| cURL | 导入结果 |
| --- | --- |
| `-X/--request`、`-I/--head` | 请求方法 |
| URL 位置参数、`--url` | URL；无协议时补 `http://` |
| `-H/--header` | 可重复 Headers |
| `-d/--data/--data-binary/--data-ascii` | raw Body；curl 默认补 `application/x-www-form-urlencoded` |
| `--data-raw` | raw Body；前导 `@` 按字面量保留，不读取文件 |
| `--json` 或 JSON Content-Type | json Body；`--json` 同时补 `Accept: application/json` |
| `-G/--get` + data | Params，不发送 Body |
| `--data-urlencode` | 按 curl 规则编码后写入 Body 或 Params；`=content` 的前导 `=` 标记不发送 |
| `-b/--cookie` | 内联 Cookie 写入 Header；Cookie 文件拒绝读取 |
| `-u/--user` | UTF-8 Basic Authorization |
| `--max-time` | 超时，秒转毫秒 |
| `-L/--location`、`--no-location`、`--max-redirs 10`、`-k/--insecure` | 重定向、忽略证书 |
| `-A/-e/-b` | User-Agent、Referer、Cookie |
| `-s/-S/-g/--basic` | 忽略终端静默、错误输出、URL 通配符和 Basic 认证选项 |
| `--verbose` | 导入请求并提示已忽略 curl 终端输出行为 |
| `--compressed` | `Accept-Encoding: gzip, deflate` |

导入行为：

- 命令最多 **1MB**、最多 **4096 个参数**；URL 与 `-G` data 合计最多 **4096 个查询参数**，超限会显示错误。
- 导入默认关闭“跟随重定向”，与 curl 默认行为一致；原请求默认开启，导入后请按需调整。
- 未指定 `--max-time` 时使用应用默认 30 秒，而不是 curl 的无限等待。
- 导入替换当前请求的 URL、Params、Headers、Body 和连接选项，但保留前置/后置脚本与上传上限。
- 导入结果会写入草稿；Authorization、Cookie 等敏感值因此可能进入明文 localStorage。
- 单请求或批量运行期间禁止导入。

不执行系统 curl 或 Shell，也不读取本地文件。除 `--data-raw` 的字面量前导 `@` 外，`@file`、Cookie 文件、`-F/--form`、`-T/--upload-file`、输出文件、证书文件和未知选项会明确拒绝；`--connect-timeout`、`--fail`、`--include`、`--anyauth`、`--ntlm`、`--negotiate`、`--digest` 以及 `--max-redirs` 的非 10 值也会拒绝，请导入后手动调整。`-u/--user` 仅支持固定的 `用户名:密码` Basic 认证，不交互获取密码。文件请在导入后于 Body 区手动选择。`$NAME` 不展开，会按原文保留并提示。需要拼接多个 URL 或完整复现 curl 终端行为时，请手动调整或继续使用 curl。

## 15. 取消与退出

- 单请求和批量都有独立“取消”按钮。
- 取消会覆盖等待连接、发送、读取响应和批量轮间隔。
- 如果请求仍在 JSON 解析、Base64 解码或 multipart 组装等 CPU 预处理阶段，取消要等当前阻塞步骤完成后才能生效。
- 关闭窗口或点击“退出应用”会请求取消所有在途任务，再退出应用。
- 退出会等待 Tauri 关闭流程，不会保留后台请求进程。
