<div align="center">
  <img src="logo.png" alt="NoteBoard" width="120" />

  # NoteBoard

  **Windows / macOS / Linux / 安卓 / 网页 笔记 + 画板 + 多维表格 + 知识工作台**

  像记事本一样随手打开任意文本文件，像 Typora 一样写 Markdown，像飞书一样整理多维表格，像白板一样画图，像 XMind 一样梳理脑图。

  [![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
  ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20Web-lightgrey.svg)
  ![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB.svg)
  [![Release](https://img.shields.io/github/v/release/CrazyFigure/NoteBoard)](https://github.com/CrazyFigure/NoteBoard/releases/latest)
</div>

---

## 概览

NoteBoard 是一款轻量、现代化的跨端效率工具，提供桌面、安卓与可自行部署的网页版本，集 Markdown 笔记、多维表格、声明式信息图、思维导图、白板绘图、代码配置编辑、文本对比与图片预览于一体。

坚持本地优先（Local-First）与文件优先理念：无强制工作区绑定、无强制云端同步。双击即开，即开即写，数据完全由你掌控。

## 下载安装

前往 [Releases](https://github.com/CrazyFigure/NoteBoard/releases/latest) 下载最新版本：

| 平台 | 安装包 | 说明 |
|---|---|---|
| **Windows** | `NoteBoard_x.y.z_windows_x64-setup.exe` | Windows 10 1809+，需 WebView2 Runtime（Win11 已内置）；支持应用内检查更新与自动重启。 |
| **安卓** | `NoteBoard_x.y.z_android_arm64.apk` | arm64 设备；新版本可在应用内检查并跳转浏览器下载 APK。 |
| **macOS** | `.dmg` | Apple Silicon / Intel 分别构建；采用系统标题栏与 Command 快捷键，当前使用 ad-hoc 签名，未做 Apple 公证。 |
| **Linux** | `.deb` / `.AppImage` | x86_64；基于 Ubuntu 22.04 构建，AppImage 首次使用需赋予执行权限，可能需要系统安装 FUSE。 |

macOS / Linux 包由 GitHub Actions 的 **macOS and Linux packages** 工作流生成；手动运行可下载 Artifacts，`v*` 标签运行时附加到对应 Release。macOS 首次启动如被系统拦截，可在“系统设置 → 隐私与安全性”允许打开。Unix 版本可手动下载安装更新，macOS 也可使用下方 Homebrew 命令。多端同步复用同一引擎和配置界面，数据与缓存保存到各系统的标准应用目录。

### 软件包管理器

| 平台 | 安装 | 更新 |
|---|---|---|
| Windows / WinGet | `winget install --id CrazyFigure.NoteBoard --exact` | `winget upgrade --id CrazyFigure.NoteBoard --exact` |
| macOS / Homebrew | `brew install --cask crazyfigure/tap/noteboard` | `brew update && brew upgrade --cask crazyfigure/tap/noteboard` |

WinGet 已[收录到官方软件源](https://github.com/microsoft/winget-pkgs/pull/453871)。Homebrew 使用[项目维护的 Tap](https://github.com/CrazyFigure/homebrew-tap)，自动选择 Apple Silicon / Intel 包并跟进正式 Release；当前未进入 Homebrew 官方主仓，安装包仍未经过 Apple 公证。

推送 `v*` 标签会自动构建 Windows EXE、安卓 APK、macOS DMG（Apple Silicon / Intel）、Linux DEB / AppImage，以及 Docker 多架构镜像。三段正式版本（如 `v0.5.8`）还会在安装包上传后自动触发 Homebrew 更新并提交 WinGet 更新申请；WinGet 须等待官方审核合并后才能升级。预发布标签（如 `v0.5.8-beta.1`）只构建发布，不更新软件源。维护者需在本仓库配置 `PACKAGE_PUBLISH_TOKEN` Secret，令牌须允许触发 `CrazyFigure/homebrew-tap` 工作流，以及向 `microsoft/winget-pkgs` 提交 PR（含维护 `CrazyFigure/winget-pkgs` 分支）。

## Docker / 1Panel 网页部署

镜像：`crazyfigure/noteboard:latest`（发布工作流构建 `linux/amd64`、`linux/arm64`）。一个部署实例共用一份笔记；未保存草稿和恢复记录按浏览器区分，不提供注册和多用户隔离。

```bash
# 下载仓库中的 compose.yaml 和 .env.example 到同一目录
cp .env.example .env
# 可选：在 .env 中同时填写 NOTEBOARD_USERNAME / NOTEBOARD_PASSWORD
docker compose up -d
# 浏览器访问 http://服务器IP:18427
```

默认对外端口为 `18427`，可在 `.env` 中修改 `NOTEBOARD_PORT`；已有 `.env` 需自行同步修改，容器内端口保持 `3000`。直接通过 IP 访问时，放行服务器防火墙 / 安全组的 `18427/TCP`。

### 1Panel 参数

在 1Panel 的“容器”页面点击“创建容器”，按以下参数填写。也可进入“容器 → 编排 → 创建编排”，粘贴 [compose.yaml](compose.yaml)，按 `.env.example` 设置环境变量后部署。

首次使用本机目录挂载时，先在服务器终端执行以下命令，为镜像内用户 `1000:1000` 准备可写目录：

```bash
sudo mkdir -p /opt/noteboard/data
sudo chown 1000:1000 /opt/noteboard/data
```

也可在 1Panel“系统 → 文件”中找到 `/opt/noteboard/data`，点击该目录的用户 / 用户组，将两项均改为 `1000`（宿主机可能显示为 `debian (1000)` 等名称，以数字 ID 为准）。**挂载选“读写”不会自动修改目录属主，此步骤不可省略**；否则启动时会出现 `EACCES: permission denied, mkdir '/data/workspace'`。修正后启动或重启 NoteBoard 容器即可，环境变量仍可留空。

| 参数 | 填写值 / 说明 |
|---|---|
| 名称 | `noteboard` |
| 镜像 | 勾选“手动输入”，填写 `docker.io/crazyfigure/noteboard:latest`；固定版本可改为 `:0.5.7` |
| 强制拉取镜像 | 勾选，确保拉取所选标签的最新镜像 |
| 端口模式 | 选择“暴露端口” |
| 端口映射 | 服务器：`18427`；容器：`3000`；协议：`tcp` |
| 网络 | `1panel-network`（或面板已有的自定义桥接网络） |
| IPv4 / IPv6 | 留空，使用所选网络的默认地址分配 |
| 挂载 | 选择“本机目录”：本机目录 `/opt/noteboard/data` → 容器目录 `/data`；权限选“读写” |
| Command / Entrypoint | 均留空，使用镜像默认启动命令 |
| 容器退出后自动删除容器 | 不勾选 |
| 特权模式 | 不勾选 |
| 控制台交互 | “伪终端（-t）”“标准输入（-i）”均不勾选 |
| 重启规则 | 选择“未手动停止则重启”（`unless-stopped`） |
| CPU 权重 | `1024`，保持默认 |
| CPU 限制 | `0`，不限制；可按服务器资源调整 |
| 内存限制 | `0`，不限制；可按服务器资源调整 |
| 标签 | 留空 |
| 环境变量 | 按下表逐行填写 `变量名=值`；不启用认证和反代时可全部留空 |

| 环境变量 | 示例值 | 说明 |
|---|---|---|
| `NOTEBOARD_USERNAME` | `admin` | 可选访问账号，不能包含冒号；必须与密码同时设置或同时留空 |
| `NOTEBOARD_PASSWORD` | 自行设置的密码 | 配置后访问网页会弹出登录框；启用网页多端同步必须设置账号密码 |
| `NOTEBOARD_PUBLIC_URL` | `https://notes.example.com` | 反向代理未保留原始 `Host` 时填写浏览器实际访问的源地址；使用非默认端口时需包含端口，不含末尾 `/` 或路径；其他情况留空 |

`NOTEBOARD_PORT` 仅供 Compose 读取；1Panel 手动创建容器时直接填写“服务器”端口，无需添加此环境变量。镜像已设置内部 `PORT=3000` 和数据目录 `/data`，无需覆盖。

创建后访问 `http://服务器IP:18427`。**不用反向代理、直接 HTTP 访问时，`NOTEBOARD_PUBLIC_URL` 留空即可**，1Panel 中也可不添加该变量。若显式填写，应与浏览器访问地址一致，例如 `http://服务器IP:18427`，使用对外端口，不含末尾 `/` 或路径。

使用域名时，在“网站”中创建反向代理并开启 HTTPS：

- 反代运行在宿主机上或使用宿主机网络时，上游填 `http://127.0.0.1:18427`。
- 反代运行在独立容器中时，将其与 NoteBoard 加入同一网络，上游填 `http://noteboard:3000`。
- 保留原始 `Host`；若无法保留，设置上述 `NOTEBOARD_PUBLIC_URL`。同步事件使用 SSE，应关闭响应缓冲。

### 数据与同步

- 账号和密码同时留空即公开共享；配置后浏览器会弹出登录框。**启用网页多端同步必须设置访问账号密码**，再在“设置 → 同步与备份”选择 `/workspace` 下的同步文件夹和 WebDAV / S3 / GitHub / Gitee / GitCode / GitLab。网页服务与桌面、安卓共用同步清单、三方合并、回收站及备份协议；同步在服务器后台运行，关闭网页不停止。
- Compose 使用命名卷 `noteboard-data` 挂载到 `/data`；上述 1Panel 手动配置使用宿主机 `/opt/noteboard/data`，笔记对应 `/opt/noteboard/data/workspace`。容器内的笔记位于 `/data/workspace`，配置、暂存、同步状态与回收文件也在 `/data`；网页看到的路径统一为 `/workspace`，不会直接访问服务器其他目录。备份应覆盖整个卷或宿主机数据目录，更新 / 重建容器时复用原挂载，不要删除数据。
- 网页“打开文件”可选择服务器文件或显式上传本机文件；保存写入服务器，右键文件选择“下载到本机”可导出。单文件上限 50 MB；同时编辑同一文件时会拦截过期保存，不提供实时协同。网页不安装系统字体包，不执行桌面更新安装器。
- 不兼容 Windows 的文件名会在跨端同步前报错；请先改名。符号链接不参与同步，网页拒绝直接访问。Unix 的凭证文件受应用目录和文件权限保护，Windows 继续使用原有 DPAPI。

更新：`docker compose pull && docker compose up -d`。自行构建：`docker build -t noteboard:local .`。不使用 Docker 时可运行 `pnpm install --frozen-lockfile && pnpm build:web && npm ci --prefix server && pnpm start:web`；如需同步，还需构建 `server/native` 并设置 `NOTEBOARD_SYNC_BINARY` 为工作进程绝对路径。

### 自动发布镜像

在 GitHub 仓库 Actions Secrets 中配置 `DOCKERHUB_USERNAME=crazyfigure` 和有镜像写权限的 `DOCKERHUB_TOKEN`，运行 **Docker image** 工作流，或推送 `v*` 标签。正式版本发布版本号及 `latest` 镜像；预发布标签不覆盖 `latest`。macOS / Linux 安装包工作流与现有 Windows / Android 工作流独立。

## 核心功能

- **Markdown 富文本与源码双模笔记**
  - 基于 TipTap 3 与 CodeMirror 6，所见即所得与源码编辑模式无缝切换。
  - 支持 KaTeX 科学公式、Mermaid 与 PlantUML 图表、Infographic 信息图嵌入、GitHub Alerts 提示块。
  - 斜杠命令快捷插入（`/`）、悬浮气泡工具栏、块级拖拽重排与文档大纲实时联动。
  - 表格多选单元格复制为 TSV、二维矩阵粘贴自动填充；查找替换支持首/末跳转与选区高亮。

- **多维表格（Bitable）**
  - 支持 `.bitable` 与 `.table` 文件，表格（Grid）、看板（Kanban）与甘特图（Gantt）视图自由切换。
  - 丰富字段类型：文本、多行文本（支持 Markdown 富文本编辑）、数字、单选、多选、日期、时间、日期时间、复选框等。
  - 自研日期时间选择器、多字段联合排序、按列分组展示与折叠、冻结列、记录详情抽屉侧边栏。
  - 类电子表格操作：矩形选区、填充柄自动填充、右键菜单批量操作，支持导出 CSV。
  - 甘特图视图：条形拖拽改期，周 / 月 / 季 / 年刻度切换，支持工作日模式。
  - 流畅拖拽体验：表头拖拽换列、行拖拽换序、看板泳道与卡片跨分组拖拽、视图 Tab 拖拽重排。

- **Infographic 现代化信息图**
  - 独立 `.infographic` / `.ig` 文件分屏实时预览编辑器，支持在 Markdown 笔记中直接嵌入。
  - 开箱即用预设模板：核心指标看板、项目里程碑时间线、业务流转步骤图、用户转化漏斗、方案对比表、四象限优先级矩阵与统计图表。
  - 声明式轻量配置，自动适配当前主题明暗风格。

- **思维导图与幕布大纲**
  - 支持 `.mindmap`、`.xmind`（XMind 格式兼容导入导出）与 `.mm`。
  - 脑图可视化与层级大纲双向实时同步。
  - 四种布局（向右逻辑图、向左逻辑图、双向平衡图、向下组织图）与 7 套配色主题，样式随文件持久化。
  - 支持整树拖拽与落位指示、节点图标选择器、备注说明与图片附件，`Tab` / `Enter` 快捷添加子节点与同级节点。

- **自由手绘白板与架构设计**
  - **Excalidraw 白板**：支持 `.excalidraw`、`.board`、`.canvas`，自由手绘涂鸦、流程草图与图形素材库。
  - **Draw.io 架构图**：集成 Draw.io 原生设计能力，支持 `.drawio` 与 `.dio` 专业架构图与系统流程设计。

- **代码与配置文本编辑**
  - 支持 `.txt`、`.sql`、`.json`、`.yaml`、`.yml`、`.xml`、`.log`、`.ini`、`.conf` 等格式。
  - 语法高亮、实时语法校验（Lint）、代码折叠与格式化。
  - Mermaid（`.mmd`）与 PlantUML（`.puml`）图表文件分屏实时预览。

- **双栏文本对比**
  - 左右双编辑器逐处差异高亮，支持合并采纳、左右互换、上下差异跳转与折叠相同行。
  - 中缝拖拽调整分栏宽度，双击一键居中复位。

- **图片查看与图表统一导出**
  - 图片查看器：支持 PNG、JPG、JPEG、WebP、SVG、GIF、AVIF、BMP、ICO 等格式直接预览与缩放。
  - 统一图表导出菜单：Mermaid、PlantUML 与 Infographic 均支持一键复制或导出为高清 SVG / PNG 图片。

- **文件管理与安全保存**
  - 桌面支持文件关联、拖拽打开、多窗口与多标签页；资源目录跟随当前文档，收藏支持分组整理。
  - 未命名草稿自动暂存；笔记、画板、表格与脑图支持自动保存，代码及配置文件支持手动保存与防丢拦截。
  - 长文档采用分段虚拟滚动、懒渲染与 Worker 解析，减少编辑大文件时的卡顿。

- **多端同步与备份**
  - 可选指定一个文件夹，通过 WebDAV（支持自定义 User-Agent）、S3 兼容存储、GitHub、Gitee、GitCode 或 GitLab（支持自建）在电脑、手机与网页服务间双向同步。
  - 改名保留文件身份，支持按行合并、跨设备回收站、定时本地 / 云端备份与一键恢复。Windows 凭证使用 DPAPI，Unix 凭证由应用目录和文件权限保护。

- **主题与排版**
  - 提供 `晨光`、`琥珀`、`墨夜` 三套主题，支持跟随系统明暗；可调整字体、字号、行高及内容宽度，桌面端提供可选免安装字体包。

- **手机工作区与系统集成**
  - 安卓端共享桌面的主要编辑器，默认使用私有工作区“我的笔记”，授权后可浏览手机存储。
  - 支持文件导入、系统分享与“用其他应用打开”，切到后台自动保存；脑图支持双指缩放、单指平移，界面适配系统栏与软键盘。

## 技术栈

Tauri v2（Windows / Android） · React 19 · TypeScript · Vite · Tailwind CSS v4 · Zustand · TipTap 3 · CodeMirror 6 · Excalidraw · Mermaid · KaTeX · @dnd-kit · @tanstack/react-virtual

## 快速开始

> 环境要求：Node.js ≥ 20、pnpm ≥ 9、Rust stable、Windows 10 1809+（含 WebView2 Runtime）

```bash
# 安装依赖
pnpm install

# 启动开发环境
pnpm tauri dev

# 构建生产安装包（NSIS）
pnpm tauri build
```

### 安卓版（arm64 APK）

安卓工程（`src-tauri/gen/android`）不入库，由 GitHub Actions 在发布时执行 `tauri android init` 生成，再经 `scripts/patch-android.mjs` 注入原生桥接（`src-tauri/android`）、存储权限、“用其他应用打开/分享到 NoteBoard”与签名配置。推送 `v*` 标签后，APK 会与 Windows 安装包上传到同一个 Release；手动触发工作流时可在 Actions 产物中下载。

正式签名需在仓库 **Settings → Secrets and variables → Actions** 中配置（未配置时使用 debug 签名，可安装但升级需卸载重装）：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 Base64 内容 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码（留空时与 keystore 密码相同） |

```bash
# 生成 keystore（请妥善保管，丢失后无法以相同签名升级）
keytool -genkeypair -v -keystore noteboard.jks -keyalg RSA -keysize 2048 -validity 36500 -alias noteboard
# 转为 Base64 后粘贴到 ANDROID_KEYSTORE_BASE64
base64 -w 0 noteboard.jks        # Linux / Git Bash
# PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("noteboard.jks"))
```

在浏览器中预览移动端界面（无需安卓环境，IPC 为内存模拟）：

```bash
TAURI_ENV_PLATFORM=android pnpm vite --port 1437
# 打开 http://127.0.0.1:1437/?mock=1 ，用浏览器开发者工具切换到手机尺寸
```

## 致谢

- 感谢 [Linux.do](https://linux.do) 社区对项目的推广与反馈。

## 开源协议

NoteBoard 遵循 **[GPL-3.0-only](LICENSE)** 开源许可协议，仅适用 GNU GPL 第 3 版。完整许可条款见根目录的 [LICENSE](LICENSE) 文件。

## Star 走势

[![Star 走势图](./assets/star-history.svg)](https://github.com/CrazyFigure/NoteBoard/stargazers)
