# 测试与验收

## 1. 验证范围与结论

验证日期：2026-11-24。

本机环境：

- Linux x86_64，WebKitGTK 4.1 2.50.4，GTK 3 3.24.33；
- Rust 与 Tauri CLI 2；
- 真实 Tauri WebView，通过 Xvfb 和 X11 自动化执行界面操作；
- 本地测试夹具只监听 `127.0.0.1:18765`，用于模拟目标 API，不属于应用；
- Node.js 用于前端逻辑验证，不参与应用运行或前端构建。

本轮覆盖了 Rust 自动化测试、前端逻辑测试、真实 WebView 主流程、单实例、无应用监听端口、退出与重启持久化，cURL 自动转换，以及 Linux 安装包构建。Windows、macOS、Linux rpm、代码签名和公证需要在对应目标环境或 CI 中继续验证，不能凭配置视为已通过。

## 2. 自动化测试

### 2.1 Rust 单元测试

执行环境与命令：

```bash
cd server
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

结果：

- `cargo fmt --check`：通过；
- `cargo test --release`：31 passed，0 failed；
- `cargo clippy --all-targets -- -D warnings`：通过。

核心覆盖：

- 非法 JSON 和请求大小边界；
- 任务 ID 重复、任务数量上限、RAII 清理；
- 请求与响应工作预算申请、释放和共享 guard 生命周期；
- Header 大小写和请求大小统计；
- 请求体 `Bytes` 共享，不按并发数复制；
- 批量总输入预算、multipart 实际膨胀和文本字段估算；
- 批量达到样本上限或共享预算耗尽后停止读取，完整读取对照组；
- 批量 2xx/3xx 样本选择、截断标记和 RPS 活跃时间计算；
- 未取消请求的对照组；
- 在途请求取消；
- 响应流读取与取消；
- 批量轮间隔取消和未取消对照组；
- 预取消请求不访问网络。

### 2.2 前端逻辑测试

前端没有 npm 构建步骤。验证脚本位于 `/tmp`，使用 Node.js 读取 ES Module 源码并通过临时 `data:` URL 动态导入，不向项目添加测试依赖。

结果：

- `/tmp/httptest-api-test.mjs`：5 项通过；
- `/tmp/httptest-script-test.mjs`：4 项通过；
- `/tmp/httptest-script-log-limit-test.mjs`：通过；未保护对照组复现 20 万行 `push(...logs)` 的 RangeError，修复后前后置脚本各保留 2000 行、记录省略数量，异常与未解析变量告警保留，渲染节点不超过 2000；
- `/tmp/httptest-upload-test.mjs`：通过；
- `/tmp/httptest-history-race-test.mjs`：通过；未保护对照组复现旧 FileReader 覆盖历史请求，版本保护后旧回调被忽略；
- `/tmp/httptest-curl-test.mjs`：31 项通过；
- `/tmp/httptest-frontend-fix-test.mjs`：URL 编辑、脚本快照、历史淘汰、草稿 flush、JSON 转表单、历史字节上限和在途后置脚本快照通过；
- `web/js/*.js` 全部模块语法检查通过。

覆盖内容：

- IPC 正常发送；
- 发送前取消；
- 运行中取消并等待确认；
- 取消命令失败时抛出错误；
- 任务尚未注册时有限重试；
- 脚本异常捕获；
- 脚本日志 2000 行采集与渲染上限、超限计数和系统告警保留；
- JSON `__proto__` 自有属性；
- 大整数原文保留；
- 默认 1MB 文件上限、超限提示与动态调整；
- 历史载入使旧 binary FileReader 回调失效，防止旧文件回填到新请求；
- 浏览器多行 cURL、JSON/raw Body、`-G`、URL 编码、UTF-8 Basic 认证和连接选项；
- Shell 变量保留、命令替换拒绝、转义字面量、`@file`/multipart 拒绝；
- 重复 URL、未知选项、非法 Header、1MB 输入、4096 参数与查询参数上限；
- 显式 Authorization Header 按 curl 规则覆盖 Basic，空 Authorization 可抑制 Basic，重复自定义 Header 保留；
- `--data-raw` 的字面量前导 `@`、`--data-urlencode =content`、Cookie 文件拒绝和 `--json` Accept Header；
- 历史恢复 URL/Params、旧记录查询串回退、UTF-8 响应字节上限和在途脚本快照。

### 2.3 生产源码监听检查

扫描结果：

- 生产 Rust 和前端没有 Axum 服务或 `fetch('/api')`；
- `TcpListener` 只出现在 `server/src/core.rs` 的 `#[cfg(test)]` 测试模块；
- `chat/` 中的历史源码快照包含旧版本内容，不进入当前应用；
- 应用运行期间使用 `ss -ltnp` 检查，没有 HTTP Test 进程拥有的监听端口；系统和其他应用的既有端口不计入本应用。

### 2.4 cURL 解析耗时抽样

使用 `/tmp/httptest-curl-bench.mjs` 在本机 Node.js 20.17.0 中各执行 5 次，结果仅代表该运行环境，不代表 WebKitGTK 或低端设备：

| 上限场景 | 命令字节数 | 中位耗时 | 最大耗时 |
| --- | ---: | ---: | ---: |
| 4096 个 URL 查询参数 | 46,960 | 95.75ms | 242.56ms |
| 4096 个 token | 37,809 | 56.90ms | 89.95ms |
| 接近 1MB 的 inline Body | 1,048,488 | 1209.07ms | 3978.33ms |

解析仍在 WebView 主线程同步执行。1MB 文本边界会出现可感知阻塞，因此文档不建议把粘贴超大命令作为常规用法；WebView 实机耗时和低端设备峰值尚未验证。

## 3. 真实 WebView 验证记录

### 3.1 基础请求

- [x] 应用启动，窗口标题和默认布局可见。
- [x] GET `http://127.0.0.1:18765/` 返回 200，响应状态、耗时和大小可见。
- [x] 真实 Tauri IPC 请求链路可用，不经过本地应用 HTTP 服务。
- [x] JSON Body 按原文发送；测试请求 `bodyLength=74`，目标端 SHA256 为 `010db617f19ad91445e1b16820863f8c19de579ae6e447d71484d1d26636d44c`。
- [x] 大整数 `900719925474099312345` 按原文发送。
- [x] `__proto__` 键按普通 JSON 字段发送，未触发页面原型赋值。
- [ ] 无协议头 URL 自动补全的界面实测。
- [ ] Params 与 URL 双向同步的界面实测。
- [ ] 重复 Header、raw、urlencoded 的界面实测。
- [ ] 超时、连接错误、重定向开关、404/500 的界面实测。

### 3.2 文件上传

- [x] 默认上限为 1MB。
- [x] 选择 1,280,000 字节文件时被拒绝，提示包含“请在 Body 区调整‘单次上传上限’后重试”。
- [x] 将上限调整为 2MB 后，同一文件发送成功。
- [x] 目标端记录 `bodyLength=1280000`，SHA256 为 `7d471e4af16db5a30ce10aebbc29f5178b2edbad6c7dc2e8ff8ee6e4848a726f`。
- [x] 本地 `sha256sum` 与目标端记录一致。
- [x] 重启后 binary 草稿保留，但文件显示“[需重新选择文件]”，不持久化文件内容。
- [ ] multipart 多文件与文本字段的真实上传。
- [ ] 降低上限后旧文件在发送前被拒绝的界面实测。
- [ ] 表单文件合计上限的界面实测。

### 3.3 脚本与变量

- [x] 前置脚本将 GET 改为 POST，并添加 `X-Script: pre-ok` 和 `fromScript=yes`；目标端记录一致。
- [x] 后置脚本读取 JSON，将 `sha256` 写入变量 `lastSha`。
- [x] “脚本输出”显示 `pre-ok` 与 `post-ok`，无脚本错误。
- [x] 全局变量抽屉显示 `lastSha`。
- [x] 重启后脚本和变量恢复。
- [ ] 变量导入、导出控件的界面实测。
- [ ] 未解析变量告警的界面实测。

### 3.4 历史与差异

- [x] 历史抽屉显示 6 条记录，重启后仍为 6 条。
- [x] 差异页可选择历史响应并执行比较。
- [x] 两份相同 GET 响应比较结果为“新增 0、删除 0、值变更 0、类型变更 0”，并显示“两份响应结构完全一致”。
- [ ] 新增、删除、值变更、类型变更四类差异的界面实测。
- [ ] 超过差异展示上限的界面实测。
- [ ] 历史载入、删除、清空控件的逐项界面实测。

### 3.5 批量与取消

- [x] 批量配置为每轮并发 3、轮数 2、间隔 100ms。
- [x] 夹具日志由 7 条增至 13 条，即新增 6 个请求。
- [x] 页面显示总请求 6、成功 6、失败 0、RPS 12.8、总耗时 468ms。
- [x] 页面显示 min 67ms、avg 112ms、P50 124ms、P90/P95/P99/max 133ms。
- [x] 状态分布为 200 × 6，请求明细全部为 200。
- [x] 慢请求 `/slow` 在途取消成功；旧响应未覆盖后续新状态，取消后应用可继续发送请求。
- [ ] 慢响应流读取中的界面取消。
- [ ] 批量轮间隔取消的界面实测。
- [ ] 退出时存在在途任务的界面实测。

### 3.6 持久化、单实例与退出

- [x] 使用相同 XDG 数据目录重启后，URL、binary Body、2MB 文件上限、前置/后置脚本、6 条历史和 1 个变量均恢复。
- [x] 通过 Python `sqlite3` 只读查询确认草稿、历史和变量已写入 WebView 本地存储。
- [x] 第二次启动返回码为 0，进程数未增加，已有窗口被聚焦。
- [x] 点击退出并确认后应用正常退出，后台任务结束码为 0。
- [ ] 未确认关窗可取消的界面实测。
- [ ] localStorage 写入失败的界面实测。

### 3.7 无端口验证

- [x] 应用运行前后没有 HTTP Test 新增监听端口。
- [x] `ss -ltnp` 中无 HTTP Test 进程拥有的监听端口；系统和其他应用的端口不计入本应用，测试夹具仅监听 `127.0.0.1:18765`。
- [x] 生产源码无 Axum 或 `/api` fetch；测试监听器不进入生产二进制。

### 3.8 cURL 自动转换

- [x] 多行 JSON POST 导入后发送成功：目标端方法为 POST，保留 `existing=1` 查询参数，Authorization 为 UTF-8 `user:päss` 对应的 `Basic dXNlcjpww6Rzcw==`。
- [x] 44 字节 JSON Body 原文发送，SHA256 为 `8b2f62017b7b9fe659fa506e5aaff4cbf1ce90893d5d5969a7cc1fabc9118fbc`，与原文本地计算一致；大整数原文未丢失。
- [x] `-G -d 'q=hello world' -d 'empty='` 导入后方法为 GET，UI 和目标端均包含原查询参数及新增参数，Body 为空且不自动发送 Content-Type。
- [x] `--data-binary @payload.bin`、`-F 'file=@payload.bin'`、双引号 `$(...)` 和 `--retry 3` 均在真实 WebView 中显示明确错误，当前草稿未被替换，未产生预期外的文件。
- [x] `/slow` 请求运行期间点击“导入 cURL”不会打开抽屉；取消后发送按钮恢复，可继续操作。
- [x] cURL 导入保留前置/后置脚本与 2MB 上传上限；退出并重启后 URL、Header、2000ms 超时、脚本和上限恢复。
- [x] 重启后发送恢复的请求返回 `200 OK`，“脚本输出”实际显示 `curl-pre-ok` 与 `curl-post-ok`，无脚本异常。
- [x] 导入和运行期间 `ss -ltnp` 均未发现 HTTP Test 进程拥有的监听端口。

### 3.9 缺陷修复回归

- [x] Rust release 31 项测试、`cargo fmt --check` 和 release Clippy 通过。
- [x] 前端 cURL 31 项、历史竞态、URL/Params、脚本快照、草稿 flush、JSON 转表单和字节上限回归通过。
- [x] 真实 WebView 验证 `=content`、Cookie、字面量 `@literal` 和 `--json` Accept Header；目标端日志与本地 SHA256 一致。
- [x] 独立 XDG 目录重启后，草稿 URL/Params、4 条历史及脚本持久化状态可读。
- [x] 应用进程无监听端口。
- [ ] 批量 600KB“已达上限”、500/204 样本选择和退出 flush 的界面自动化；Rust 单元测试已覆盖对应逻辑。
- [ ] 实际物理内存峰值、低端设备与极高压缩比响应。

### 3.10 脚本日志上限回归

- [x] 未保护对照组在 Node.js 20.17.0 中执行 `target.push(...Array.from({ length: 200000 }, ...))`，复现 `RangeError: Maximum call stack size exceeded`。
- [x] `/tmp/httptest-script-log-limit-test.mjs` 通过：前后置脚本各执行 20 万行 `console.log`，各保留 2000 行并记录省略 198000 行；异常与未解析变量告警保留；合并不再使用 spread；渲染日志节点不超过 2000。
- [x] WebKitGTK 4.1 MiniBrowser 加载同一生产模块和渲染函数，采集上限、异常可见、省略提示和 DOM 上限全部通过。
- [x] 真实 Tauri WebView 发送 `http://127.0.0.1:18765/`，后置脚本输出 20 万行日志后抛出 `LOG_LIMIT_ERROR`；请求返回 `200 OK`，历史记录增加 1 条，日志区显示 2000 行、异常行和“仅显示 2000 行，已省略 198001 行”，未复现发送失败或页面冻结。

## 4. 五轮角色验收

### 第 1 轮：桌面应用架构评审

角色：桌面应用架构师。

检查项：

- Tauri 2 + 系统 WebView；
- 无本地 HTTP 服务；
- IPC 命令边界；
- 单实例与退出；
- 三平台安装包配置；
- macOS 最低部署目标。

结论：完成。应用采用 `WebView → Tauri IPC → Rust/reqwest → 目标 API`，不存在需要保留本地监听端口的架构理由。单实例、退出和 IPC 命令边界已完成静态审查；单实例与退出在本机 WebView 中实测。

未闭环：Windows/macOS 原生进程和安装器行为需要在目标系统验证。

### 第 2 轮：Rust 代码审查

角色：Rust 后端工程师。

检查项：

- 请求准备与共享；
- Base64、multipart 和 URL 编码；
- 响应截断；
- 取消检查点；
- 任务注册和清理；
- 并发预算；
- 批量输入与样本预算；
- 单元测试对照组。

结论：完成。批量大 Body 重复准备问题已通过“只准备一次、并发共享 `Bytes`”修复；请求/响应工作预算、共享 guard 生命周期、multipart 实际大小复核、限量停读和任务 RAII 清理已覆盖。格式、31 项测试和 Clippy 全部通过。

未闭环：低内存设备最大文件峰值、极高压缩比响应的实际资源消耗未实测。

### 第 3 轮：前端与 WebView 兼容性审查

角色：前端工程师。

检查项：

- ES Modules 与系统 WebView；
- Safari 14 之前 flex gap 兼容；
- 文件读取竞态；
- 草稿、历史和变量持久化失败；
- 剪贴板失败回退；
- 脚本语法错误；
- 关窗语义；
- JSON 原型污染。

结论：完成代码整改，并在本机 WebKitGTK WebView 中验证请求、上传、脚本、变量、历史、差异、批量、取消、退出和重启持久化。flex 容器使用子项 margin 提供间距，避免旧 Safari 不支持 flex gap。

未闭环：macOS 10.15 对应 WebKit、Windows WebView2 和其他 Linux WebView 版本未实机验证。

### 第 4 轮：构建与 QA

角色：桌面测试工程师。

检查项：

- Rust 格式、测试和 Clippy；
- Tauri 配置校验；
- Linux 真实窗口启动；
- Linux 安装包构建与解包检查；
- 无端口和单实例验证。

结论：以本机 Linux deb 为范围完成，具体构建产物、哈希和解包 IPC 验证见下一节。AppImage 因外部打包工具下载超时未生成；RPM、Windows、macOS 不在本机通过结论内。

未闭环：AppImage 与 rpm 未构建；Windows NSIS/MSI 和 macOS app/dmg 未构建或安装；安装、升级、卸载仅在本机 deb 解包运行范围内验证，未修改系统安装状态。

### 第 5 轮：发布与安全验收

角色：发布/安全工程师。

检查项：

- Tauri 权限白名单；
- CSP 与 `unsafe-eval`；
- localStorage 明文风险；
- 大请求并发峰值；
- 不可取消的 CPU 预处理；
- multipart 边界膨胀；
- 文件默认 1MB 与配置入口；
- 发布签名策略；
- 文档完整性。

结论：完成静态审查和本机运行时检查。capability 只授予 `main` 窗口 `core:default`；应用没有任意文件系统、Shell 或本地 HTTP 服务权限；1MB 默认上限与调整入口已实测；残余风险已在 `SECURITY.md` 和 `LIMITS.md` 中列明。

未闭环：Windows Authenticode、macOS Developer ID/Hardened Runtime/公证、Linux 仓库签名均未在目标发布环境执行。

### 4.6 cURL 专项角色复审

- 发布/安全工程师：复核 tokenizer、Shell 操作符、命令替换、`@file`、Header 控制字符、认证优先级和导入失败回滚；31 项及额外边界测试通过。发现历史载入未使旧 binary FileReader 失效，已补齐版本保护与可复现对照组。
- 前端工程师：复核导入界面、运行中禁用、快捷键、草稿保留和 binary 异步回填；发现并修复历史载入竞态，文档中的 `--data`、`--no-location`、支持/拒绝选项和 Ctrl+Enter 行为已同步。
- 桌面 QA：独立复测 31 项解析器测试，并在真实 WebView 中验证 POST、`-G`、错误输入、运行中保护、重启持久化和脚本实际执行；发现的文档边界已补齐。

三类角色均完成复审，前述五轮桌面应用验收仍有效；cURL 没有新增 Rust IPC、后台进程或监听端口。

### 4.7 缺陷修复三方复审

- Rust 工程师：确认零共享预算不等待 Body、恰好上限统一为“已达上限”、parse/prepare 阻塞任务通过 `Arc<OwnedSemaphorePermit>` 持续持有预算；31 项测试和 Clippy 通过。残余是取消不能终止 `spawn_blocking`，且缺少 Future 丢弃专项测试。
- 前端工程师：确认发送时后置脚本快照、历史真实字节上限、URL/Params 恢复和批量提示一致；前端回归通过。批量与退出界面自动化未闭环。
- 文档工程师：确认测试数量、历史字节口径、`truncated` 文案、RPS 与样本语义已同步；本机构建哈希和真实 WebView 结果已补入本文档。

## 5. Linux 构建产物

### 5.1 deb

构建命令：

```bash
npx --yes @tauri-apps/cli@2 build --bundles deb
```

脚本日志上限修复纳入本轮 release 构建，Tauri 编译与打包耗时 16 分 42 秒。

| 项目 | 结果 |
| --- | --- |
| 路径 | `server/target/release/bundle/deb/HTTPTest_0.1.0_amd64.deb` |
| 大小 | 5,123,714 字节 |
| SHA256 | `e15c44ca6cb8636b9df9ac9f1e6a0fb481dac3743df054d0b7037ff105f0ba80` |
| 包名 / 版本 / 架构 | `http-test` / `0.1.0` / `amd64` |
| 运行依赖 | `libwebkit2gtk-4.1-0`、`libgtk-3-0` |
| 可执行文件 | `usr/bin/httptest`，13,396,016 字节 |
| release 二进制 SHA256 | `15653c99bb50d81668495a1cde335cfe859c01835b391ab1d6408e0fb5fa30e8` |
| deb 解包二进制 SHA256 | `b060ade3654b3b521a619356beb2f6a24357983f295ced42226c3ce1f12c1f36` |

验证结果：

- `dpkg-deb --info` 和 `--contents` 通过，包含可执行文件、桌面入口和图标。
- 解包到 `/tmp/httptest-log-limit-deb` 后使用独立 XDG 数据目录启动，真实 WebView 可用。
- 包级日志上限回归：后置脚本输出 200000 行后抛出 `LOG_LIMIT_ERROR`，请求返回 `200 OK`；日志区显示 2000 行、异常和“仅显示 2000 行，已省略 198001 行”，未复现发送失败。
- 真实 WebView 验证 cURL `--data-urlencode '=content'` 发送 `content`，Cookie 为 `session=abc`；`--data-raw '@literal'` 发送 8 字节字面量；`--json` 自动发送 `Accept: application/json`，40 字节 JSON 大整数原文未丢失。
- 重启后草稿恢复为 `/large?size=600000`，Params 同步为 `size=600000`；本地存储保留 4 条历史及各自查询参数。
- 运行期间 `ss -ltnp` 未发现 HTTP Test 进程拥有的监听端口；`127.0.0.1:18765` 仅属于测试夹具。
- 批量 600KB 停读、500/204 样本和退出 flush 的界面自动化未完成；对应 Rust 路径有单元测试和对照组，不把界面项记为通过。

### 5.2 AppImage

本轮未生成 AppImage。Tauri CLI 在下载 `linuxdeploy-x86_64.AppImage` 时连接 `release-assets.githubusercontent.com` 超时；单独使用 curl 重试也连续出现连接超时。已完成编译和 deb 不依赖该下载。

本机存在旧版 linuxdeploy 缓存，但直接运行缺少 `libfuse.so.2`，且版本与 Tauri 当前请求的工具不一致，因此未用旧缓存冒充本轮产物。AppImage 需要在工具下载可用的环境重新执行：

```bash
npx --yes @tauri-apps/cli@2 build --bundles appimage
```

### 5.3 rpm

本机没有 `rpmbuild`，未构建 rpm。配置和构建命令见 `BUILD.md`，需要在 Fedora/RHEL 系或安装 rpmbuild 的环境验证。

## 6. 当前未验证项

最终交付明确区分以下状态：

### 已在本机 Linux 执行

- Rust 格式、31 项单元测试和 Clippy；
- 前端逻辑与语法检查；
- 真实 WebView 主流程；
- 文件上传内容哈希一致性；
- 单实例、无应用监听端口、退出和重启持久化；
- Linux deb 构建、元数据检查、解包启动和包级 IPC 请求。

### 仅完成静态审查

- 三平台 Tauri bundle 配置；
- macOS 10.15/11.0 部署目标；
- Windows WebView2 离线安装器配置；
- CSP、capability 和发布签名要求；
- 未逐项执行的 UI 边界路径。

### 需要在目标环境继续执行

- Windows NSIS/MSI 实际构建、安装、升级、卸载；
- Windows WebView2 安装与 SmartScreen；
- macOS 10.15/11.0 实机启动；
- macOS Developer ID 签名和公证；
- Linux AppImage 在打包工具下载可用的环境重新构建；
- Linux rpm 构建与 Fedora/RHEL 系安装；
- 低内存设备上的最大文件峰值；
- 正式签名后的完整发布回归。
