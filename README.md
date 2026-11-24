# HTTP Client

HTTP Client 是一个独立桌面 HTTP 请求测试工具。应用使用 Tauri 2 嵌入系统 WebView，前端通过 Tauri IPC 调用 Rust/reqwest 请求引擎；**不启动本地 HTTP 服务、不监听端口，也不需要先运行 Node.js 或浏览器**。

当前版本：`0.1.0`

## 功能概览

- 支持 GET、POST、PUT、PATCH、DELETE、HEAD、OPTIONS。
- 支持 URL、Params、Headers、none/json/form-data/urlencoded/raw/binary Body。
- 支持粘贴 cURL 命令自动填充方法、URL、Params、Headers、Body、Basic 认证和常用连接选项；不执行 Shell、不读取 `@file`。
- URL 与 Params 双向同步，JSON 与表单互转，自动补充 Content-Type。
- 全局变量、变量替换、前置/后置脚本、脚本输出。
- 无损 JSON：大整数按原始文本保存和发送，响应树不经过 JavaScript Number。
- multipart 多文件与 binary 单文件上传。
- 单次上传上限默认 **1MB**，可在 Body 区域调整为 **1–128MB**；超限会提示去调整该上限。
- 响应 JSON 树、原文、Headers、状态、耗时、大小、图片预览和截断提示。
- 最多 10 条本地历史，可载入请求、删除、清空，并对两份 JSON 响应做路径级差异对比。
- 并发/定时批量请求、状态分布、错误聚合、耗时分位数和响应样本。
- 超时、重定向开关、忽略证书、请求取消、批量取消和退出时取消。
- 草稿、历史、变量保存在应用自己的 WebView 本地数据目录，不与普通浏览器共享。

## 快速开始

1. 从对应平台的安装包安装应用。
2. 打开 HTTP Client。
3. 输入完整 URL，或输入不带协议头的地址（默认补 `http://`）。
4. 按需设置方法、Params、Headers、Body、超时和脚本。
5. 点击“发送”，或按 `Ctrl+Enter`。

应用不会要求开放防火墙端口。需要访问网络的是目标 HTTP API，而不是 HTTP Client 提供的本地服务。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [使用说明](docs/USAGE.md) | 界面、请求、脚本、变量、上传、历史、差异、批量与取消 |
| [限制与配置](docs/LIMITS.md) | 文件上限、请求/响应/批量/并发限制及配置项 |
| [构建与安装](docs/BUILD.md) | Linux、Windows、macOS 环境、打包、签名与发布 |
| [安全说明](docs/SECURITY.md) | 信任边界、权限、CSP、本地存储、网络与内存风险 |
| [测试与验收](docs/TESTING.md) | 单元测试、UI 验证、五轮验收和已知未验证项 |
| [IPC 接口](docs/api/IPC.md) | Tauri 命令、请求/响应结构和错误约定 |
| [常见问题](docs/FAQ.md) | 启动、上传、WebView、签名、取消和存储问题 |

## 平台支持

| 平台 | 安装包 | 运行要求 |
| --- | --- | --- |
| Windows | NSIS `.exe`、MSI `.msi` | 64 位 Windows 10/11；安装包包含 WebView2 离线安装器 |
| macOS Intel | `.app`、`.dmg` | 最低部署目标 macOS 10.15；实际发布仍需目标系统验证 |
| macOS Apple Silicon | `.app`、`.dmg` | 最低部署目标 macOS 11.0 |
| Linux | `.deb`、`.rpm`、`.AppImage` | WebKitGTK 4.1 与 GTK 3；AppImage 不内置 WebKitGTK |

macOS 的 `10.15` 是编译/打包部署目标，不等同于已经完成所有系统版本的实机验证。Windows/macOS 的安装包应在各自原生系统或 CI 上构建。

本轮已实际生成并验证 Linux amd64 deb；AppImage 因外部打包工具下载超时未生成，rpm 因本机缺少 `rpmbuild` 未构建。详细产物、哈希和未验证项见 [测试与验收](docs/TESTING.md)。

## 开发

前置条件：Rust stable、Tauri 2 CLI，以及目标平台的系统依赖。

```bash
cd server
cargo test
cargo tauri dev
```

`web/` 是原生 ES Modules 前端，由 Tauri 直接作为资源加载，无需 npm install、Vite 或前端构建产物。

## 构建安装包

以下命令均在 `server/` 目录执行。

### Linux

```bash
cargo tauri build --bundles deb,rpm,appimage
```

产物位于 `server/target/release/bundle/`。

### Windows

```bat
cargo tauri build --bundles nsis,msi
```

产物位于 `server/target/release/bundle/nsis/` 和 `server/target/release/bundle/msi/`。

### macOS

```bash
MACOSX_DEPLOYMENT_TARGET=10.15 cargo tauri build --target x86_64-apple-darwin --bundles app,dmg
MACOSX_DEPLOYMENT_TARGET=11.0 cargo tauri build --target aarch64-apple-darwin --bundles app,dmg
```

详细的依赖安装、签名、公证、SmartScreen 和 Linux 运行库说明见 [构建与安装](docs/BUILD.md)。

## 项目结构

```text
httpclient-ui/
├── README.md
├── docs/                   使用、构建、安全、限制、测试与排障文档
├── server/
│   ├── src/main.rs         Tauri 命令、任务注册、取消、退出和并发预算
│   ├── src/core.rs         reqwest 请求、响应读取、批量与单元测试
│   ├── tauri.conf.json     窗口、权限、CSP、安装包与最低系统配置
│   ├── capabilities/       WebView 能力白名单
│   └── icons/              应用图标
└── web/                    无构建步骤的前端资源
```

## 安全与数据

- 不开放任意文件系统、Shell 或对话框权限；文件由用户通过 WebView 文件输入控件选择。
- cURL 导入只解析文本，拒绝命令替换、管道、重定向、文件读写和未知选项；Shell 变量按原文保留。
- 用户脚本使用 `new Function`，CSP 因此允许 `unsafe-eval`；只执行可信脚本。
- localStorage 中的草稿、历史和变量未加密，不要长期保存生产密钥。
- 请求可能访问本机、内网或云服务，应用不会阻止你主动发送的请求。
- 大文件会经过 Base64、IPC 和请求体复制；默认 1MB 限制用于降低误操作和内存峰值。

完整风险、取消语义、峰值内存估算和发布注意事项见 [安全说明](docs/SECURITY.md) 与 [限制与配置](docs/LIMITS.md)。
