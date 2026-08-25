<div align="center">
  <img src="logo.png" alt="NoteBoard" width="120" />

  # NoteBoard

  **Windows 桌面笔记 + 画板软件**

  像记事本一样随手打开任意文本文件，像 Typora 一样写 Markdown，像白板一样画图。

  [![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
  ![Platform](https://img.shields.io/badge/platform-Windows%2010%2B-lightgrey.svg)
  ![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB.svg)
</div>

---

## 概览

NoteBoard 是一款轻量、现代化的 Windows 桌面应用，兼具文本笔记、代码查看编辑与白板绘图能力。

- **Markdown 笔记**：TipTap 富文本所见即所得与源码编辑模式无缝切换，支持 KaTeX 数学公式、Mermaid 与 PlantUML 图表、GitHub Alerts 提示块、斜杠命令快捷插入、块级拖拽重排与大纲导航。
- **思维导图与大纲**：支持思维导图可视化呈现与结构化大纲节点编辑，满足思路梳理与层级拆解需求。
- **代码与配置编辑**：基于 CodeMirror 6 引擎，支持 `.txt`、`.sql`、`.json`、`.yaml`、`.yml`、`.xml` 等常见语言的语法高亮、语法校验、代码折叠与格式化。
- **自由手绘与图表**：内置 Excalidraw 手绘风白板与 Draw.io 集成，支持原生画板绘制、快速连线与图形导出。
- **图片预览查看**：内置图片查看器，支持常见格式图片的直接预览、缩放与自适应显示。

坚持轻量与文件优先原则：无强制工作区绑定、无强制云端同步。双击文件直接打开，即开即写。

## 核心特性

| 特性 | 说明 |
|---|---|
| **文件优先** | 双击即开、右键“用 NoteBoard 打开”、文件拖拽入窗口直接查看或编辑。 |
| **多窗口与标签页** | 支持多窗口独立并行，标签页可自由拆分并在新窗口中打开。 |
| **智能目录联动** | 左侧资源管理器动态跟随当前激活标签页的所在目录，切换标签自动切换目录视图。 |
| **双侧灵活收起** | 编辑区左右两侧均配备悬浮折叠控件，可一键展开或收起资源目录与文档大纲。 |
| **草稿与暂存** | 支持临时笔记快速记录与未命名草稿自动暂存，保护内容不丢失。 |
| **精心调色主题** | 提供 `晨光`、`琥珀` 与 `墨夜` 三套主题，代码块配色均经过 WCAG AA 对比度优化，支持跟随系统明暗切换。 |
| **排版自由调节** | 字体族、字号、行高及内容最大宽度均支持个性化调整；JetBrains Mono 与 Maple Mono 作为可选应用字体包按需下载一次，后续更新复用且不会安装到 Windows。 |
| **智能保存策略** | Markdown 与画板支持自动保存；代码及配置文件支持手动保存、未保存状态标记与关闭防护拦截。 |
| **高性能大文档优化** | 具备分段虚拟滚动、视口懒渲染、阈值回落与 Worker 分段解析机制，平稳处理长篇文档。 |

## 技术栈

Tauri v2 · React 19 · TypeScript · Vite · Tailwind CSS v4 · Zustand · TipTap 3 · CodeMirror 6 · Excalidraw · Mermaid · KaTeX

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

## 开源协议

NoteBoard 遵循 **GPL-3.0-only** 开源许可协议。

## Star 走势

[![Star 走势图](./assets/star-history.svg)](https://github.com/CrazyFigure/NoteBoard/stargazers)
