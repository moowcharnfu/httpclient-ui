# 构建与安装

## 1. 通用要求

- Rust stable 工具链。
- Tauri 2 CLI。
- 目标平台的 C/C++ 构建工具和 WebView 运行库。
- 首次构建需要网络下载 Rust crates；Linux AppImage 打包可能额外下载打包工具。
- Windows 和 macOS 安装包应在对应原生系统或原生 CI 上构建。

安装 Tauri CLI：

```bash
cargo install tauri-cli --version '^2' --locked
```

也可以不全局安装 CLI，使用 npm 临时运行 Tauri 2（需要 Node.js 和网络）：

```bash
npx --yes @tauri-apps/cli@2 --version
```

检查环境：

```bash
cargo tauri info
```

所有构建命令均在 `server/` 目录执行。

## 2. 开发运行

```bash
cd server
cargo test
cargo tauri dev
```

未全局安装 CLI 时，开发命令使用 `npx --yes @tauri-apps/cli@2 dev`。开发模式会启动 Tauri 应用窗口，不会启动 HTTP Test 的本地 Web 服务。

## 3. Linux

### 3.1 Debian / Ubuntu

安装构建依赖：

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file libxdo-dev libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libfuse2 \
  libayatana-appindicator3-dev librsvg2-dev
```

如果系统没有可用的 WebKitGTK 4.1 开发包，需要先升级发行版或配置提供该包的软件源。WebKitGTK 4.0 不能直接替代 4.1。

### 3.2 Fedora / RHEL 系

依赖名称示例：

```bash
sudo dnf install -y \
  gcc gcc-c++ make curl wget file libXdo-devel openssl-devel \
  webkit2gtk4.1-devel gtk3-devel fuse-libs \
  libappindicator-gtk3-devel librsvg2-devel
```

不同发行版的小版本和仓库可能使用不同包名，以系统包管理器为准。

### 3.3 Arch Linux

依赖名称示例：

```bash
sudo pacman -S --needed \
  base-devel curl wget file xdotool libxdo openssl \
  webkit2gtk-4.1 gtk3 fuse2 libayatana-appindicator librsvg
```

### 3.4 打包命令

```bash
cargo tauri build --bundles deb
cargo tauri build --bundles rpm
cargo tauri build --bundles appimage
```

或一次构建：

```bash
cargo tauri build --bundles deb,rpm,appimage
```

未全局安装 Tauri CLI 时，将上述 `cargo tauri` 替换为：

```bash
npx --yes @tauri-apps/cli@2 build --bundles deb,appimage
```

产物：

```text
server/target/release/bundle/deb/
server/target/release/bundle/rpm/
server/target/release/bundle/appimage/
```

deb/rpm 配置中声明了 WebKitGTK 4.1 和 GTK 3 运行依赖。AppImage 仍依赖系统提供 WebKitGTK 4.1，并不代表所有运行库都已打包。

### 3.5 安装

```bash
sudo apt install './HTTP Test_0.1.0_amd64.deb'
sudo dnf install ./http-test-0.1.0.x86_64.rpm
chmod +x ./http-test_0.1.0_amd64.AppImage
./http-test_0.1.0_amd64.AppImage
```

实际文件名可能随版本、架构和 Tauri CLI 命名规则变化，请使用 `ls` 查看产物。

## 4. Windows

### 4.1 构建环境

- 64 位 Windows 10 或 Windows 11。
- Rust MSVC 工具链。
- Visual Studio Build Tools，包含“使用 C++ 的桌面开发”。
- Tauri 2 CLI。

安装包配置为内置 WebView2 离线安装器并静默安装。企业环境如果禁止安装 WebView2，需要由管理员预先部署受支持的 Evergreen Runtime。

### 4.2 构建

```bat
cd server
cargo tauri build --bundles nsis,msi
```

产物：

```text
server/target/release/bundle/nsis/
server/target/release/bundle/msi/
```

- NSIS：适合交互式安装，也可用于静默安装参数。
- MSI：适合企业分发、组策略和软件管理工具。

### 4.3 代码签名与 SmartScreen

未签名应用可以本地运行和测试，但 Windows SmartScreen 可能提示“Windows 已保护你的电脑”或显示未知发布者。

正式分发应：

1. 购买或使用受信任的 Authenticode 代码签名证书。
2. 对 `.exe` 可执行文件和 NSIS/MSI 安装包签名。
3. 使用受信任时间戳，避免证书过期后签名失效。
4. 让用户从可信渠道下载，逐步建立 SmartScreen 信誉。

可使用 `signtool` 或 Tauri 的 Windows 签名配置完成签名。不要通过关闭 SmartScreen 来替代签名。代码签名只证明发布者身份和包完整性，不代表应用没有安全问题。

## 5. macOS

### 5.1 构建环境

- macOS 主机。
- Xcode Command Line Tools。
- Rust stable。
- Tauri 2 CLI。

```bash
xcode-select --install
```

### 5.2 最低系统配置

项目配置：

- Intel：macOS 10.15 Catalina。
- Apple Silicon：macOS 11.0 Big Sur。

`server/.cargo/config.toml` 和 `tauri.conf.json` 都设置了对应部署目标。实际兼容性还取决于 Tauri、Rust 依赖、WebKit 和系统框架，发布前仍需在目标最低系统或接近最低系统的环境验证。

### 5.3 Intel 构建

```bash
MACOSX_DEPLOYMENT_TARGET=10.15 \
  cargo tauri build --target x86_64-apple-darwin --bundles app,dmg
```

### 5.4 Apple Silicon 构建

```bash
MACOSX_DEPLOYMENT_TARGET=11.0 \
  cargo tauri build --target aarch64-apple-darwin --bundles app,dmg
```

产物：

```text
server/target/release/<target>/bundle/macos/
server/target/release/<target>/bundle/dmg/
```

### 5.5 签名与公证

正式分发应：

1. 使用 Developer ID Application 证书签名 `.app` 和 `.dmg`。
2. 启用 Hardened Runtime，并仅保留应用需要的 entitlements。
3. 使用 Apple 公证服务提交构建物。
4. 公证通过后 staple 公证票据。
5. 在干净的 macOS 环境验证首次打开和离线/在线公证检查。

未签名或未公证应用首次打开时，用户可能需要在“系统设置 → 隐私与安全性”中允许，或右键打开。不要建议用户全局关闭 Gatekeeper。

## 6. 版本与发布

修改版本时同步更新：

- `server/Cargo.toml` 的 `version`；
- `server/tauri.conf.json` 的 `version`；
- `server/Cargo.lock` 中本包的版本。

发布前检查：

1. `cargo fmt --check`。
2. `cargo test`。
3. `cargo clippy --all-targets -- -D warnings`。
4. `cargo tauri info`。
5. 三平台原生构建。
6. 安装包安装、升级、卸载和首次启动。
7. Windows 签名、macOS 签名/公证、Linux 仓库签名策略。
8. 更新本目录中的验证记录和已知问题。

## 7. 配置位置

| 配置 | 文件 |
| --- | --- |
| 产品名、版本、标识符 | `server/tauri.conf.json` |
| 窗口大小 | `server/tauri.conf.json` |
| 前端资源目录 | `server/tauri.conf.json` |
| CSP | `server/tauri.conf.json` |
| 权限白名单 | `server/capabilities/default.json` |
| 安装包目标 | `server/tauri.conf.json` |
| macOS 最低系统 | `server/tauri.conf.json`、`server/.cargo/config.toml` |
| Linux 运行依赖 | `server/tauri.conf.json` |
| Rust 依赖与 release 配置 | `server/Cargo.toml` |
| 文件默认上限 | `web/js/main.js`、`web/js/kvEditor.js` |

## 8. 常见构建问题

- **缺少 WebKitGTK 4.1**：安装对应开发包，或更换提供该包的发行版版本。
- **AppImage 打包下载失败**：检查网络和代理，必要时单独重试 AppImage 打包。
- **linuxdeploy 提示缺少 libfuse.so.2**：安装提供 FUSE 2 兼容库的系统包；仅安装 FUSE 3 不一定能运行旧的 AppImage 工具。
- **Windows 找不到 linker**：安装 MSVC C++ 生成工具并使用 MSVC Rust 工具链。
- **macOS deployment target 警告**：检查环境变量、`.cargo/config.toml` 和依赖的最低系统要求。
- **签名后仍被拦截**：检查时间戳、证书链、发布者信誉和文件是否在签名后又被修改。
