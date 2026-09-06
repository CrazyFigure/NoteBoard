// NoteBoard 编辑器能力契约（core 层轻量类型定义）
// 🔴 依赖红线（docs/启动性能与低内存根治计划.md §D）：
//    本文件与 editorRegistry.ts 只允许依赖轻量类型/工具，
//    禁止 import React、TipTap、CodeMirror、任何 Editor 组件及其 CSS；
//    也不得出现 EditorView/Editor 等内核类型的逃逸（含 any 透传）。

/** flush 的调用场景；编辑器侧按场景区分必须精确等待的工作（如 Drawio 需真实回包） */
export type FlushReason = 'save' | 'stage' | 'switch-mode' | 'evict' | 'transfer' | 'close';

/**
 * flush 捕获的快照（判别联合，docs §D：图片/只读查看能力标记不可写，
 * 不为满足接口伪造空字符串 flush）。
 * content 是捕获时刻的定值；不得返回仍会被原编辑器继续修改的可变对象。
 */
export type CapturedContent =
  /** 可写文本编辑文档：content 为权威文本 */
  | {
      docKey: string;
      instanceId: string;
      /** 捕获时的内容版本（同一 docKey 单调递增；编辑器重挂载不重置） */
      revision: number;
      content: string;
    }
  /** 只读/非文本查看（如图片）：无正文快照，仅有视图状态 */
  | {
      docKey: string;
      instanceId: string;
      revision: number;
      content: null;
      readonly: true;
    };

/** 文本搜索/替换选项（语义与现有搜索栏一致） */
export interface TextSearchOptions {
  searchText: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

/** 搜索匹配统计 */
export interface MatchStats {
  matchIndex: number;
  matchCount: number;
}

/** 替换操作结果 */
export interface ReplaceOutcome extends MatchStats {
  success: boolean;
  replacedCount: number;
  error?: string;
}

/**
 * 文本搜索能力组：由编辑器侧实现并注册，屏蔽 CodeMirror / TipTap 内核差异。
 * 搜索栏与快捷键只依赖本接口，不接触任何内核实例。
 */
export interface SearchCapabilities {
  search(options: TextSearchOptions): MatchStats;
  findNext(options: TextSearchOptions): MatchStats;
  findPrev(options: TextSearchOptions): MatchStats;
  replace(options: TextSearchOptions): ReplaceOutcome;
  replaceAll(options: TextSearchOptions): ReplaceOutcome;
}

/**
 * 代码操作能力组：JSON 展开/压缩/校验、大小写转换、XML 格式化。
 * 由 code 编辑器与 Markdown 源码模式提供；scope 默认 'all'。
 */
export interface CodeOpsCapabilities {
  expandJson(options?: { scope?: 'all' | 'selection'; tabSize?: number }): void;
  minifyJson(scope?: 'all' | 'selection'): void;
  validateJson(scope?: 'all' | 'selection'): void;
  transformCase(mode: 'upper' | 'lower' | 'title'): void;
  formatXml(scope?: 'all' | 'selection'): void;
}

/**
 * 编辑器实例能力：每个挂载中的编辑器注册一份，实例卸载后随之失效。
 * 注册表按键（docKey）查询；实例以 instanceId 代际区分，
 * 旧实例的 disposer 无权删除同 key 的新实例。
 */
export interface EditorCapabilities {
  docKey: string;
  instanceId: string;
  /** 当前内容版本号（每次真实内容修改递增；撤销/重做的内容变化同样递增） */
  getRevision(): number;
  /**
   * 统一异步 flush 屏障：捕获某个确切 revision 的权威内容快照。
   * 可以异步等待（如 iframe 回包），但不得以滞后镜像假装成功；
   * 实例已无法产出权威内容时返回 null，由调用方保留镜像或中止操作。
   */
  flush(reason: FlushReason): Promise<CapturedContent | null>;
  focus(): void;
  getSelectedText(): string;
  /** 是否可安全回收渲染实例（S11 起逐类型验证接入；未验证类型必须返回 false） */
  canSuspend(): boolean;
  /**
   * 捕获视图状态（S11 回收流程；同步读取内核状态，不含正文）。
   * 返回类型见 editorTypes 底部的判别联合；不可恢复的类型返回 undefined。
   */
  captureViewState?(): unknown;
  /** 文本搜索能力组（可编辑文本类编辑器提供） */
  readonly search?: SearchCapabilities;
  /** 代码操作能力组（code 编辑器与 Markdown 源码模式提供） */
  readonly codeOps?: CodeOpsCapabilities;
}

/**
 * 按编辑器类型区分的视图状态快照（判别联合）。
 * S03 只定义类型骨架；实际捕获与恢复由 S11/S12 逐类型实现。
 */
export type EditorViewState =
  | { kind: 'code'; selection: { anchor: number; head: number } | null; scrollTop: number; foldedRanges: unknown[] }
  | { kind: 'markdown'; selection: { anchor: number; head: number } | null; scrollTop: number; mode: 'visual' | 'source' }
  | { kind: 'board'; viewport: unknown | null }
  | { kind: 'bitable'; activeCell: unknown | null; scroll: unknown | null }
  /** 🔴 S12：思维导图视图状态（查看模式与缩放；内容在 store） */
  | { kind: 'mindmap'; viewMode: 'outliner' | 'mindmap'; zoom: number };
