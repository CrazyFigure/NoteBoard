# 第三方声明与致谢

NoteBoard 采用 **GPL-3.0-only**。本文件列出所有第三方来源及其协议。

> ⚠️ `LICENSE` 文件必须是 **GPL-3.0 的逐字原文**（674 行），从 https://www.gnu.org/licenses/gpl-3.0.txt 获取。
> 见 [开发路线图](docs/09-开发路线图.md) 任务 0.1。

---

## 1. 直接参考并移植代码的项目

### codexu/note-gen

| | |
|---|---|
| 仓库 | https://github.com/codexu/note-gen |
| 协议 | **GNU General Public License v3.0（GPL-3.0-only）**，纯 GPLv3，无 classpath exception |
| 版权 | Copyright (C) 2025 codexu, https://notegen.top/ |
| 参考范围 | 编辑区实现：TipTap + CodeMirror 双模式架构、自研 KaTeX / Mermaid 节点、大纲、四层大文档性能机制、视口懒渲染与 viewport lowlight 插件 |

**NoteBoard 选择 GPL-3.0 正是为了能够合法复用 note-gen 的代码。** 详见 [ADR-002](docs/05-ADR/ADR-002-开源协议与代码复用边界.md)。

移植纪律（强制，CI 检查）：

1. 每个移植文件顶部必须有来源注释块（原始路径、协议、原始版权、改动摘要）
2. 格式：
   ```
   /*
    * 移植自 codexu/note-gen（GPL-3.0-only）
    * 原始路径：src/app/core/main/editor/markdown/<file>
    * 原始版权：Copyright (C) 2025 codexu, https://notegen.top/
    * 改动摘要：<具体改了什么>
    */
   ```
3. 这不只是礼节 —— 它是将来若要移除 GPL 约束时唯一的净室重写清单依据

**明确未移植**：AI 补全 / 建议 / diff 预览、`sync/` 同步模块、SQLite 层、工作区模型、`store.json` 全局单例 tab 状态、appDataDir 硬编码资产目录。

### KoniKee/TMD_Type-Markdown

| | |
|---|---|
| 仓库 | https://github.com/KoniKee/TMD_Type-Markdown |
| 协议 | **MIT** |
| 参考范围 | `晨光`(chen-guang) / `琥珀`(hu-po) / `墨夜`(mo-ye) 三套主题的配色与 CSS 变量体系 |

MIT 单向兼容 GPL，可并入本项目，需保留 MIT 版权声明。

NoteBoard 在其基础上做了 16 处修改（对比度合规、语义修正、琥珀暖调语法高亮自研等），逐条列于 [主题与设计规范 §10](docs/06-主题与设计规范.md)。

---

## 2. 运行时依赖

### 桌面框架

| 包 | 协议 |
|---|---|
| Tauri（`tauri`, `tauri-build`, `@tauri-apps/api`, `@tauri-apps/cli`） | MIT **或** Apache-2.0（双许可，本项目取 MIT） |
| `tauri-plugin-fs` / `-dialog` / `-opener` / `-os` / `-single-instance` / `-window-state` | MIT 或 Apache-2.0 |
| wry / tao（Tauri 底层） | Apache-2.0 |

### 前端框架与工具

| 包 | 协议 |
|---|---|
| React / React DOM | MIT |
| TypeScript | Apache-2.0 |
| Vite | MIT |
| Tailwind CSS | MIT |
| Zustand | MIT |
| mitt | MIT |
| Radix UI（`radix-ui`） | MIT |
| shadcn/ui（代码复制入库，非依赖） | MIT |
| Lucide（`lucide-react`） | ISC |
| react-resizable-panels | MIT |
| dnd-kit（`@dnd-kit/core` / `-sortable` / `-modifiers`） | MIT |

### 编辑器

| 包 | 协议 |
|---|---|
| TipTap（`@tiptap/*`） | MIT |
| ProseMirror（经 `@tiptap/pm`） | MIT |
| `@sereneinserenade/tiptap-search-and-replace` | MIT |
| CodeMirror 6（`@codemirror/*`、`@lezer/*`） | MIT |

### 渲染

| 包 | 协议 |
|---|---|
| Excalidraw（`@excalidraw/excalidraw`） | MIT |
| KaTeX | MIT |
| Mermaid | MIT |
| lowlight | MIT |
| highlight.js | **BSD-3-Clause** |
| markdown-it | MIT |
| `@tanstack/react-virtual` | MIT |

### Rust crate

| crate | 协议 |
|---|---|
| serde / serde_json | MIT 或 Apache-2.0 |
| encoding_rs | Apache-2.0 或 MIT（含 `COPYRIGHT` 中的 Unicode 数据条款） |
| chardetng | Apache-2.0 或 MIT |
| notify / notify-debouncer-full | CC0-1.0 / MIT |
| trash | MIT |
| font-kit | MIT 或 Apache-2.0 |
| tempfile | MIT 或 Apache-2.0 |
| dunce | CC0-1.0 或 MIT-0 或 Apache-2.0 |

---

## 3. 协议兼容性结论

**无冲突。** 逐条核对：

| 情形 | 结论 |
|---|---|
| GPL-3.0 ← MIT / ISC / BSD-3-Clause / CC0 / MIT-0 | ✅ 单向兼容，可并入，保留原声明即可 |
| GPL-3.0 ← Apache-2.0 | ✅ GPLv3 明确兼容 Apache-2.0 的专利条款 |
| GPL-3.0 ← GPL-3.0-only（note-gen） | ✅ 同协议 |
| 双许可（Tauri、多数 Rust crate） | ✅ 取 MIT 分支即可，完全无虑 |

---

## 4. 维护

本文件的第 2 节应由 `license-checker`（npm）与 `cargo-license`（Rust）自动生成后人工校对；第 1、3 节手工维护。

生成命令见 [开发路线图](docs/09-开发路线图.md) 任务 14.9。

**新增依赖时必须检查协议**：出现 AGPL、SSPL、专有协议、或任何与 GPL-3.0 不兼容的协议时，**不得引入**。
