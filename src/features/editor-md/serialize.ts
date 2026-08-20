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
/**
 * 执行整篇内容同步，但永远不写入编辑器内核的局部历史。
 * 用户可见的撤销/重做由文件级统一时间线负责，初始化和模式同步都不允许伪造编辑步骤。
 */
function replaceEditorContent(
  editor: Editor,
  replace: ReturnType<Editor['chain']>,
): void {
  // 文件初始化、历史导航和模式同步属于程序行为，不允许污染用户的局部撤销栈
  replace
    .command(({ tr }) => {
      tr.setMeta('addToHistory', false);
      return true;
    })
    .run();
}

export function parseMarkdown(
  editor: Editor,
  markdown: string,
): void {
  if (markdown.trim() === '') {
    // 空内容同样必须显式控制历史，否则初次打开空文件后可能出现伪撤销步骤
    replaceEditorContent(
      editor,
      editor.chain().clearContent(false),
    );
    return;
  }
  try {
    replaceEditorContent(
      editor,
      editor.chain().setContent(markdown, {
        contentType: 'markdown',
        parseOptions: {
          // 保持原有格式
          preserveWhitespace: 'full',
        },
      }),
    );
  } catch (err) {
    console.error('[NoteBoard] Markdown 解析出现容错，执行安全降级加载:', err);
    try {
      replaceEditorContent(
        editor,
        editor.chain().setContent(
          {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: markdown }],
              },
            ],
          },
          { contentType: 'json' },
        ),
      );
    } catch {
      replaceEditorContent(
        editor,
        editor.chain().clearContent(false),
      );
    }
  }
}

// ── 换行符规整工具 ──

/**
 * 规范化文本换行符（将 CRLF 转换为 LF）
 * 用于跨平台/跨编辑器引擎进行语义级无害内容比对，避免因换行符差异误标脏
 */
export function normalizeEol(text: string | null | undefined): string {
  if (text == null) return '';
  return text.replace(/\r\n/g, '\n');
}

/**
 * 判断源码文本是否真的不同于当前可视化文档。
 * 返回 false 时调用方必须跳过整篇 setContent，否则即使事务不入栈也会重映射并破坏已有撤销/重做历史。
 */
export function hasMarkdownContentChanged(editor: Editor, markdown: string): boolean {
  return normalizeEol(markdown) !== normalizeEol(serializeMarkdown(editor));
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

  /** 判断当前内容是否与基线一致（不脏，支持自动规整行尾符） */
  isClean(currentContent: string): boolean {
    if (this.baseline === null) return false;
    // 统一规整换行符后进行内容比对，防止 Windows CRLF 导致假脏态
    return normalizeEol(currentContent) === normalizeEol(this.baseline);
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
