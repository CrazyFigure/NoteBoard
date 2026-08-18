// NoteBoard Markdown 序列化
// @tiptap/markdown 入/出 + 基线管理（不变式 I-13/I-14）
// 详见 docs/09-开发路线图.md 7.5
//
// 不变式 I-13: 打开文件后，序列化的结果必须等于磁盘原文（否则"什么都没做就变脏"）
// 不变式 I-14: 打开 → 切 visual → 切 source → tab 不出现脏圆点

import type { Editor } from '@tiptap/core';

// ── 序列化器 ──

/**
 * 从 TipTap 编辑器序列化为 Markdown 文本
 *
 * @tiptap/markdown 扩展会把 getMarkdown 方法注入到 Editor 实例上
 * （通过 declare module '@tiptap/core' 的 interface Editor 增强）。
 * 注意：不是 editor.storage.markdown.getMarkdown——storage.markdown 是
 * { manager: MarkdownManager }，没有 getMarkdown 字段。原代码访问
 * storage.markdown.getMarkdown 永远是 undefined，导致静默回退到
 * editor.getText()，丢失所有 markdown 语法。
 *
 * 如果 editor.getMarkdown 不存在，说明 @tiptap/markdown 扩展未装配——
 * 这是配置错误，明确报错避免静默退化成纯文本导致格式丢失。
 */
export function serializeMarkdown(editor: Editor): string {
  const getMarkdown = (editor as unknown as { getMarkdown?: () => string }).getMarkdown;
  if (typeof getMarkdown === 'function') {
    return getMarkdown.call(editor);
  }
  console.error(
    '[NoteBoard] @tiptap/markdown 扩展未注册，无法序列化为 Markdown。' +
      '请检查 src/features/editor-md/extensions/index.ts 的 buildExtensions()。',
  );
  return editor.getText();
}

/**
 * 将 Markdown 文本解析为 TipTap 内容
 * 用于 source 模式切回 visual 模式，或打开文件时加载初始内容
 *
 * 必须显式声明 contentType: 'markdown'，否则 TipTap 默认按 JSON
 * 解析，前置 #、-、``` 等不会触发对应节点，导致 heading 列表等失效。
 *
 * 空内容守卫：空白 markdown（新建文档初始态）必须走 clearContent。
 * @tiptap/markdown 的 parse('') 返回 {type:'doc',content:[]}，
 * 而 doc schema 要求 block+（至少一个块节点），直接 setContent 会抛
 * RangeError: Invalid content for node doc —— 在组件挂载路径上
 * 会炸掉 React 渲染（整窗白屏）。
 */
export function parseMarkdown(editor: Editor, markdown: string): void {
  if (markdown.trim() === '') {
    // 清空文档，不触发 onUpdate（与 setContent 默认行为一致）
    editor.commands.clearContent(false);
    return;
  }
  editor.commands.setContent(markdown, {
    contentType: 'markdown',
    parseOptions: {
      // 保持原有格式
      preserveWhitespace: 'full',
    },
  });
}

// ── 基线管理 ──

/**
 * 基线内容：打开文件时的原始 Markdown 文本
 * 用于判断"切模式后内容是否变了"
 *
 * 关键流程：
 * 1. 打开文件 → baseline = 文件内容
 * 2. 切 visual → editor 从 markdown 解析
 * 3. 编辑 → onUpdate 触发
 * 4. 切 source → serializeMarkdown(editor) → 如果 === baseline，不标脏
 * 5. 切回 visual → 从 source 文本重新解析
 *
 * 不变式 I-14 的保障：
 * 打开 → visual → source → serialize → 如果 === baseline → 不脏
 */
export class BaselineManager {
  private baseline: string | null = null;
  private docKey: string;

  constructor(docKey: string) {
    this.docKey = docKey;
  }

  /** 设置基线（打开文件或保存后） */
  setBaseline(content: string): void {
    this.baseline = content;
  }

  /** 获取基线 */
  getBaseline(): string | null {
    return this.baseline;
  }

  /** 判断当前内容是否与基线一致（不脏） */
  isClean(currentContent: string): boolean {
    if (this.baseline === null) return false;
    return currentContent === this.baseline;
  }

  /** 更新基线（保存成功后调用） */
  updateBaseline(content: string): void {
    this.baseline = content;
  }

  /** 清除基线 */
  clear(): void {
    this.baseline = null;
  }
}

// ── 全局基线管理器实例 ──

const baselines = new Map<string, BaselineManager>();

/** 获取或创建文档的基线管理器 */
export function getBaseline(docKey: string): BaselineManager {
  let mgr = baselines.get(docKey);
  if (!mgr) {
    mgr = new BaselineManager(docKey);
    baselines.set(docKey, mgr);
  }
  return mgr;
}

/** 删除文档的基线管理器 */
export function removeBaseline(docKey: string): void {
  baselines.delete(docKey);
}

// ── 往返保真测试辅助 ──

/**
 * 测试用：解析 markdown → 序列化 → 比较
 * 用于 gate:7 往返保真测试
 */
export function roundtripMarkdown(
  editor: Editor,
  markdown: string,
): { input: string; output: string; isIdentical: boolean } {
  // 1. 解析 markdown 到编辑器
  parseMarkdown(editor, markdown);

  // 2. 序列化回 markdown
  const output = serializeMarkdown(editor);

  // 3. 比较
  return {
    input: markdown,
    output,
    isIdentical: markdown === output,
  };
}
