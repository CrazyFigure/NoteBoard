# ADR-006：窗口与 Tab 模型

**状态**：✅ 已定
**日期**：2026-08-17

---

## 背景

需求原文有两条关于窗口的要求：

1. 「可以多开窗口，就像记事本一样」
2. 「也可以在一个窗口中拖动 tab 合并到其他窗口中」

第 2 条在实现难度上是整个项目的**最高峰**。调研结论：

### Tauri 侧：官方明确不做

- **跨窗口 HTML5 DnD 传数据不可行。** wry rustdoc 明确说明；[tauri#15138](https://github.com/tauri-apps/tauri/issues/15138) 请求 hybrid 模式被 **closed as not planned**；[tauri#9976](https://github.com/tauri-apps/tauri/issues/9976) 核心成员 amrbashir 表态「not very trivial」
- 唯一可行路径：`tauri-plugin-drag-as-window`（CrabNebula 维护）的「临时文件 + 魔法前缀 + 目标窗口原生 drop 事件」链路，配合 Rust 侧 `cursor_position()` 轮询 + Win32 `WindowFromPoint` 做 z-order 命中测试
- 该插件 npm 侧 **落后 crate 一个 patch 且停更在 2025-02**，`-drag-as-window` 下载量仅 6.1k（低采用度，需自维护准备）
- `drag` crate 自己的文档承认：Windows 混合 DPI 下光标位置「there's **no trivial solution**」

### Electron 侧：官方也承认做不到

- [electron#47854](https://github.com/electron/electron/issues/47854)（2025-07，OPEN，零维护者回复）开篇原文：「Modern browsers such as Chrome allow users to drag tabs out of the main window... **In Electron, replicating this behavior is currently not possible using native APIs.**」
- 该 issue 列出的现行 workaround 的三个缺陷（作者原话）：**Non-performant** / **Incompatible with OS-native behaviors** like window snapping, drag previews, aero shake / **Complex** to implement and maintain

### 生态的失败率

| 项目 | 结果 |
|---|---|
| **Beaker Browser** | issue 由维护者 pfrazee 亲自提出（2016-09），至今 OPEN、零关联 PR，仓库 2022-12 归档 |
| **Wexond** | 「Ability to drag tab out of window」（2019-11），至今 OPEN、零评论零 PR，仓库 2023-06 归档 |
| **electron-tabs**（716★） | **仓库已 archived**，只支持同窗口重排。作者原话：「This is not a feature right now.」 |
| GitHub 检索 | `electron + tabs + tear-off` → **total 0** |

`<webview>` 曾在 2016 年通过 `guestinstance` 属性真的能跨窗口搬 tab，2018 年因迁移 OOPIF 被移除，[electron#14120](https://github.com/electron/electron/issues/14120) 原文：「the guest WebContents is **bound to a web frame forever**... This is a design decision made from Chromium's side that **we can not work around**.」

### 连 VSCode 都没做到

微软有专职团队、握有 Electron 上游话语权、用的是最有利的同进程 `window.open()` 架构，做了两年（1.85 至今）仍然：

- [vscode#199953](https://github.com/microsoft/vscode/issues/199953)（OPEN，Backlog，`help wanted`）：拖 editor 到桌面时「the cursor indicates 'not allowed'」
- [vscode#283423](https://github.com/microsoft/vscode/issues/283423)（OPEN regression）：「Ctrl+drag to copy editor tab between windows **no longer works in 1.107.0**」，因 Electron 39 升级而回归

**工作量估计**：Tauri 路线 4–7 周（无先例可抄），且「抛光到 Chrome 手感」+ 数月且微软至今没做到。

## 决策

**放弃跨窗口拖拽 tab（FR-613 废弃）。改为右键菜单「在新窗口中打开」（FR-606）。**

窗口模型定为：

### 1. 单实例，多窗口

- **单实例**：`tauri-plugin-single-instance` **必须第一个注册**。第二个进程通过 `CreateMutexW` 检测 + `SendMessageW(WM_COPYDATA)` 把 argv 转发给第一个实例后 `exit(0)`
- **多窗口**：同一进程内多个 `WebviewWindow`，label 格式 `nb-main` / `nb-{seq}`，seq 单调递增永不复用
- **两者不冲突**：单实例是进程级互斥（`CreateMutexW`），对窗口数量零限制。这两件事经常被混淆

### 2. Tab 迁移走「右键 → 在新窗口中打开」

语义：把该 tab **移动**到一个新窗口（原窗口关闭该 tab），未保存内容随之迁移不丢失。

实现走**拉取式交接**（详见 [领域模型](../03-领域模型.md) §2.6）：

```
源窗口 ──► Rust 暂存 WindowIntent::AdoptDocuments{含未保存内容}
              │
              ├─ std::thread::spawn(建窗)   🔴 必须切线程，否则 Windows 死锁
              │
新窗口挂载 ──► invoke('window_ready') 取走意图 ──► 恢复内容与 ViewState
              │
源窗口收到确认 ──► 才移除本地 tab
```

**不变式 I-10**：源窗口必须等 Rust 确认交接完成才移除本地 tab。建窗失败或 3s 超时 → Rust 回滚 registry 归属 → 源窗口保持原状 + 提示错误。**在此期间文档在源窗口仍完整可编辑。**

### 3. 同窗口内 tab 拖拽排序保留（FR-604）

这是**完全不同**的一件事，难度极低。**必须用 dnd-kit（PointerSensor）**，理由见 [ADR-014](ADR-014-拖放机制取舍.md)：dnd-kit 的 `dataTransfer` 与 `setDragImage` 引用计数均为 **0**，不走 HTML5 DnD，因此不受 `dragDropEnabled` 影响。

**禁止**用 `react-dnd` 的 `HTML5Backend`。

### 4. 双击文件在已有窗口新开 tab（FR-111）

不新开窗口。选择「最后活跃的窗口」（`last_active_at` 最大者）并置前。与 Win11 记事本行为一致。

### 5. 跨窗口唯一性（FR-608）

同一文件在所有窗口中最多打开一次。打开已在别处打开的文件 → 聚焦那个窗口的那个 tab。由 Rust 侧 `registry` 裁决（前端无法跨窗口判断）。

## 被否方案

### 自研跨窗口拖拽（Tauri 路线）

否决：4–7 周、无先例、依赖一个低采用度且 npm 侧停更的第三方插件、Windows 混合 DPI 下坐标对齐被插件作者本人承认无平凡解。**投入产出比在整个项目里最差的一项。**

### 换 Electron 以获得跨窗口拖拽

否决：见 [ADR-001](ADR-001-桌面框架选型.md)。Electron 官方亲口说「currently not possible using native APIs」，两个知名 Electron 浏览器项目在这件事上立项失败并归档。**不存在「选 Electron 就能省掉这块工作」的选项。**

### 拖出 tab 生成新窗口（tear-off），但不支持合并到已有窗口

否决：tear-off 的技术难点（松手检测、光标位置、ghost 预览）与合并几乎完全重叠，省不了多少工作量，却仍要引入全套原生拖拽链路。

### 每次双击文件都开新窗口

否决：批量双击会堆一屏窗口。旧版记事本/Notepad++ 的行为，Win11 记事本已经改掉了。

## 代价

1. **失去了一个流畅的交互。** 拖拽比右键菜单直观。这是本项目为可行性付出的最明显代价。
2. **右键菜单的语义是「移动」而非「拖到哪里就去哪里」。** 用户无法把 tab 合并进一个**已存在**的窗口——只能新建窗口。
   - 若将来需要，可以低成本补一个折中：右键菜单里列出所有已打开的窗口，「移动到 → 窗口 2 / 窗口 3」。这个用现有的拉取式交接机制就能实现，**不需要任何原生拖拽能力**，约 1 天工作量。已记入 [路线图](../09-开发路线图.md) 的可选增强。
3. 需要向用户解释「怎么把 tab 弄到另一个窗口」——靠右键菜单的可发现性。

## 什么情况下该重新考虑

- Tauri 官方实现了跨窗口 DnD 数据传递（目前 closed as not planned，不乐观）
- 用户强烈反馈右键菜单不够用，且愿意接受 4–7 周的开发投入
- 先做「移动到 → 已打开的窗口 N」这个折中方案（成本低得多），再评估是否还需要拖拽
