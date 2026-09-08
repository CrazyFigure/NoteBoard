// NoteBoard 🔴 J2 visual 模式不可变快照暂存（docs/启动性能与低内存根治计划.md §J2）
//
// 🔴 设计（J 节要求）：
//   1. 输入热路径只捕获不可变 ProseMirror 文档根引用（O(1)，不 getJSON/toString，
//      不创建另一个编辑器）；快照对应确定 revision。
//   2. 序列化（全文工作）按**历史组**为最小单位延迟执行：同一历史组只保留最新末端
//      快照；新组开始时立即物化前一组末端（跨组节点全部保留——不因合并丢组）；
//      undo/redo/save/switch-mode 等读取入口经 documentHistory 的物化钩子立即物化。
//   3. 物化读取暂存的 doc 快照（纯适配器 serializeMarkdownFromDoc），
//      绝不改读"此刻的 editor.state.doc"。
//   4. dirty 快速路径：有暂存（未物化变化）即视为受保护（保守标脏），
//      物化时与基线精确比较重算——"改回原文"最终清脏，不出现关闭漏保。
// 🔴 R3-01/R3-03 修正：
//   5. 暂存带**稳定的组身份**（groupId）：同组后续事务只替换组末 doc/Text、
//      revision 与末端选区，绝不覆盖"是否新组"与组起点（C01：第二组首事务的
//      isNewGroup=true 不会被第二笔同组输入的 false 抹掉）。
//   6. 暂存捕获**会话代际**：物化前校验会话未失效——同路径关闭重开后，旧 pending
//      不再绕过会话屏障写回新会话（C03）。
//   7. 物化失败（序列化异常）**不丢 pending**：保留待物化快照并抛出，导航/保存
//      调用方据此中止（R3-01 步骤 3——不得先 delete 再 catch 继续导航）。

import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import {
  serializeMarkdownFromDoc,
  serializeMarkdown,
  normalizeEol,
  getBaseline,
  type MarkdownManagerLike,
} from './serialize';
import { recordDocumentChange, type DocumentHistorySelection } from '../history/documentHistory';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { getMdTipTapEditor } from './editorInstances';
// 🔴 R3-03：pending 与会话代际绑定（物化前校验会话未失效）
import { getSessionGeneration } from '../session/documentSession';

/** 暂存的 visual 快照（组内合并：同组多次输入只保留最新 doc 引用） */
interface PendingVisualSnapshot {
  /** 🔴 R3-01：稳定组身份（首个暂存生成；同组后续事务保留不变） */
  groupId: number;
  /** 不可变 ProseMirror 文档根引用（捕获时刻的定值） */
  doc: ProsemirrorNode;
  /** 捕获时（组末事务）的内容版本 */
  revision: number;
  /** 与编辑器共享的 MarkdownManager（兼容配置；序列化纯适配器使用） */
  manager: MarkdownManagerLike | null;
  /** 与编辑器共享的 schema（nodeFromJSON 语义校验用） */
  schema: { nodeFromJSON(json: unknown): { eq(other: unknown): boolean } } | null;
  /** 🔴 R3-01：本组相对已提交历史是否新组（同组后续事务不覆盖） */
  isNewGroup: boolean;
  /** 本组首事务的 beforeSelection（组起点，撤销本组时回到真实修改处；同组不覆盖） */
  groupStartBefore?: DocumentHistorySelection;
  /** 组末（最新事务）的选区 */
  selection?: DocumentHistorySelection;
  /** 🔴 R3-03：暂存捕获时的会话代际（物化前校验） */
  sessionGeneration: number;
}

/** docKey → 暂存快照 */
const pendingByDoc = new Map<string, PendingVisualSnapshot>();

/** 组身份序号（全局单调；每次"无先前暂存的新输入"生成） */
let nextGroupId = 0;

/** 是否存在未物化暂存（dirty 待核对判定用） */
export function hasPendingVisualSnapshot(docKey: string): boolean {
  return pendingByDoc.has(docKey);
}

/**
 * 🔴 J2 热路径：暂存一次输入的不可变快照（O(1) 引用捕获，零全文工作）。
 * 同组多次输入合并（只保留最新 doc）；**组身份、是否新组与组起点保持首事务值**
 * （R3-01：同组后续事务不得覆盖）。调用方负责在新组开始时先物化上一组。
 */
export function stagePendingVisualSnapshot(
  docKey: string,
  snapshot: {
    doc: ProsemirrorNode;
    revision: number;
    manager: MarkdownManagerLike | null;
    schema: PendingVisualSnapshot['schema'];
    isNewGroup: boolean;
    groupStartBefore?: DocumentHistorySelection;
    selection?: DocumentHistorySelection;
  },
): void {
  const previous = pendingByDoc.get(docKey);
  pendingByDoc.set(docKey, {
    ...snapshot,
    // 🔴 R3-01：组身份与"是否新组"保持稳定——只有首事务的值生效
    groupId: previous ? previous.groupId : ++nextGroupId,
    isNewGroup: previous ? previous.isNewGroup : snapshot.isNewGroup,
    groupStartBefore: previous?.groupStartBefore ?? snapshot.groupStartBefore,
    // 🔴 R3-03：会话代际取当前值（首次暂存捕获；同会话内不变）
    sessionGeneration: previous ? previous.sessionGeneration : getSessionGeneration(docKey),
  });
}

/**
 * 🔴 J2：物化暂存快照——序列化（纯适配器，读暂存 doc）+ 记录历史组末端 +
 * 更新 store 镜像与精确脏态。幂等（无暂存返回 null）。
 * 🔴 R3-03：会话代际失效（同路径已重开）→ 不产生任何副作用，返回 null（丢弃）。
 * 🔴 R3-01：序列化失败 → **保留 pending** 并抛出（调用方中止依赖它的导航/保存）。
 */
export function flushPendingVisualSnapshot(docKey: string): string | null {
  const pending = pendingByDoc.get(docKey);
  if (!pending) return null;
  // 🔴 R3-03：会话屏障——旧会话的 pending 不得写回同路径新会话（先校验再动手）
  if (getSessionGeneration(docKey) !== pending.sessionGeneration) {
    pendingByDoc.delete(docKey);
    return null;
  }

  // 🔴 J2：序列化读取暂存的不可变 doc 快照（不是此刻的 editor.state.doc）；
  //    无纯适配器配置（测试替身/扩展未装配）时降级读当前编辑器实例（旧语义）
  let content: string;
  if (pending.manager && pending.schema) {
    // 🔴 R3-01：序列化异常向上抛出（调用方中止）——pending 尚未消费（保留待重试）
    content = serializeMarkdownFromDoc(pending.manager, pending.schema, pending.doc);
  } else {
    const editor = getMdTipTapEditor(docKey);
    if (!editor) return null;
    content = serializeMarkdown(editor);
  }

  // 成功才消费 pending（副作用与消费原子）
  pendingByDoc.delete(docKey);

  // 历史组末端提交（startsNewGroup 取稳定组属性；同组重算末端语义不变）
  recordDocumentChange(docKey, content, {
    mode: 'visual',
    startsNewGroup: pending.isNewGroup,
    beforeSelection: pending.groupStartBefore,
    selection: pending.selection,
  });

  // store 镜像 + 精确脏态（flush-and-compare；改回原文最终清脏）
  const baseline =
    getBaseline(docKey).getBaseline()
    ?? useDocumentStore.getState().getDocument(docKey)?.baselineContent
    ?? '';
  const isDirty = normalizeEol(content) !== normalizeEol(baseline);
  useDocumentStore.getState().setContent(docKey, content);
  useWindowStore.getState().setTabDirty(docKey, isDirty);
  return content;
}

/** 丢弃暂存（文档关闭/身份迁移——不再需要物化） */
export function discardPendingVisualSnapshot(docKey: string): void {
  pendingByDoc.delete(docKey);
}

// ── 🔴 J2 source 模式（CodeMirror）快照 ──
//
// CM 的 doc 是不可变 Text（rope）；每键 toString() 是 O(n) 全文工作。
// 与 visual 同规则：热路径只暂存 Text 引用，序列化（toString）按历史组延迟执行。
// R3-01/R3-03 的组身份/会话代际/失败保留规则与 visual 相同。

import type { Text as CodeMirrorText } from '@codemirror/state';

/** source 模式暂存快照（组内合并：同组多次输入只保留最新 Text 引用） */
interface PendingSourceSnapshot {
  /** 🔴 R3-01：稳定组身份 */
  groupId: number;
  text: CodeMirrorText;
  revision: number;
  /** 🔴 R3-01：本组相对已提交历史是否新组（同组后续事务不覆盖） */
  isNewGroup: boolean;
  groupStartBefore?: DocumentHistorySelection;
  selection?: DocumentHistorySelection;
  /** 🔴 R3-03：暂存捕获时的会话代际（物化前校验） */
  sessionGeneration: number;
}

const pendingSourceByDoc = new Map<string, PendingSourceSnapshot>();

/** source 模式是否存在未物化暂存 */
export function hasPendingSourceSnapshot(docKey: string): boolean {
  return pendingSourceByDoc.has(docKey);
}

/** 🔴 R4-01/D03：该文档是否存在任一模式的未物化暂存（热切换保活判定——跳过全文 flush 的前提是零未确认输入） */
export function hasPendingSnapshot(docKey: string): boolean {
  return pendingByDoc.has(docKey) || pendingSourceByDoc.has(docKey);
}

/** 🔴 J2 source 热路径：暂存不可变 Text 引用（O(1)；组身份/新组/组起点保持首事务值） */
export function stagePendingSourceSnapshot(
  docKey: string,
  snapshot: {
    text: CodeMirrorText;
    revision: number;
    isNewGroup: boolean;
    groupStartBefore?: DocumentHistorySelection;
    selection?: DocumentHistorySelection;
  },
): void {
  const previous = pendingSourceByDoc.get(docKey);
  pendingSourceByDoc.set(docKey, {
    ...snapshot,
    groupId: previous ? previous.groupId : ++nextGroupId,
    isNewGroup: previous ? previous.isNewGroup : snapshot.isNewGroup,
    groupStartBefore: previous?.groupStartBefore ?? snapshot.groupStartBefore,
    sessionGeneration: previous ? previous.sessionGeneration : getSessionGeneration(docKey),
  });
}

/**
 * 🔴 J2 source：物化暂存快照（toString + 历史组末端 + 镜像 + 精确脏态）；幂等。
 * 🔴 R3-03：会话代际失效 → 无副作用丢弃（旧 pending 不写新会话）。
 */
export function flushPendingSourceSnapshot(docKey: string): string | null {
  const pending = pendingSourceByDoc.get(docKey);
  if (!pending) return null;
  // 🔴 R3-03：会话屏障（C03）
  if (getSessionGeneration(docKey) !== pending.sessionGeneration) {
    pendingSourceByDoc.delete(docKey);
    return null;
  }

  // CM Text 为不可变结构，toString 是对捕获快照的全量读取（不依赖活视图）
  const content = pending.text.toString();
  pendingSourceByDoc.delete(docKey);

  recordDocumentChange(docKey, content, {
    mode: 'source',
    startsNewGroup: pending.isNewGroup,
    beforeSelection: pending.groupStartBefore,
    selection: pending.selection,
  });

  const baseline =
    getBaseline(docKey).getBaseline()
    ?? useDocumentStore.getState().getDocument(docKey)?.baselineContent
    ?? '';
  const isDirty = normalizeEol(content) !== normalizeEol(baseline);
  useDocumentStore.getState().setContent(docKey, content);
  useWindowStore.getState().setTabDirty(docKey, isDirty);
  return content;
}

/** 丢弃 source 暂存（文档关闭/身份迁移） */
export function discardPendingSourceSnapshot(docKey: string): void {
  pendingSourceByDoc.delete(docKey);
}
