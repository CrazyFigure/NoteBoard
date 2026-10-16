// NoteBoard 粘贴格式检测测试：纯文本粘贴后识别 Markdown / HTML，并可转换为格式

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import type { EditorView } from '@tiptap/pm/view';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { getMarkdownManager, parseMarkdown, serializeMarkdown, serializeMarkdownFromDoc } from '../../src/features/editor-md/serialize';
import {
  createConvertSlice,
  createConvertTransaction,
  createDismissTransaction,
  detectPastedFormat,
  getPastedTextRange,
  isHtmlSource,
  isRangeAlreadyFormatted,
  pasteFormatKey,
  type PasteConvertMode,
} from '../../src/features/editor-md/pasteFormatDetect';

const editor = new Editor({
  element: null,
  extensions: buildExtensions('paste-format-test', { pasteFormatDetect: true }),
  content: '',
});

afterAll(() => {
  editor.destroy();
});

// jsdom 中未挂载的编辑器不装载插件、完整挂载又依赖布局 API：
// 直接用本插件 + 历史插件构造 EditorState，按 prosemirror-view 的粘贴流程驱动
const pastePlugin = editor.extensionManager.plugins.find((plugin) => plugin.spec.key === pasteFormatKey)!;

/** 由 Markdown 创建带粘贴插件的状态，光标放在 pos（默认文末） */
function createState(markdown: string, pos?: number): EditorState {
  parseMarkdown(editor, markdown);
  const doc = editor.state.doc;
  const state = EditorState.create({ schema: editor.schema, doc, plugins: [pastePlugin, history()] });
  const selection = TextSelection.near(doc.resolve(pos ?? doc.content.size), pos === undefined ? -1 : 1);
  return state.apply(state.tr.setSelection(selection));
}

/** 构造粘贴事件：只提供 handlePaste 读取的剪贴板数据 */
function pasteEvent(text: string, html = ''): ClipboardEvent {
  return {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : '') },
    preventDefault() {},
  } as unknown as ClipboardEvent;
}

/**
 * 模拟 ProseMirror 的纯文本粘贴：与 prosemirror-view 的 doPaste 一致，
 * 按行拆成段落切片，先走 handlePaste，再应用带 uiEvent 的替换事务。
 */
function pastePlain(state: EditorState, text: string, html = ''): EditorState {
  const { schema } = state;
  const paragraphs = text.split(/(?:\r\n?|\n)+/).map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null));
  const slice = new Slice(Fragment.from(paragraphs), 1, 1);
  const fakeView = { state } as unknown as EditorView;
  const handled = pastePlugin.props.handlePaste!.call(pastePlugin, fakeView, pasteEvent(text, html), slice);
  expect(handled).toBe(false);
  return state.apply(state.tr.replaceSelection(slice).setMeta('paste', true).setMeta('uiEvent', 'paste'));
}

/** 按当前编辑器配置序列化任意状态的文档 */
function serializeState(state: EditorState): string {
  return serializeMarkdownFromDoc(getMarkdownManager(editor)!, editor.schema, state.doc);
}

/** 执行撤销命令并返回新状态 */
function undoState(state: EditorState): EditorState {
  let next = state;
  undo(state, (tr: Transaction) => {
    next = state.apply(tr);
  });
  return next;
}

describe('格式检测', () => {
  it.each([
    ['标题', '# 标题\n\n正文', 'markdown'],
    ['列表', '- 一\n- 二', 'markdown'],
    ['表格', '| a | b |\n| --- | --- |\n| 1 | 2 |', 'markdown'],
    ['粗体', '这是 **重点** 内容', 'markdown'],
    ['纯 HTML', '<p align="center">\n  <b>标题</b>\n</p>', 'html'],
    ['Markdown 夹 HTML', '# 标题\n\n<div align="center">居中</div>\n\n- 项', 'mixed'],
  ])('%s', (_name, text, kind) => {
    expect(detectPastedFormat(editor, text)?.kind).toBe(kind);
  });

  it.each([
    ['普通中文段落', '今天天气不错。\n\n明天继续。'],
    ['单个网址', 'https://example.com/path'],
    ['转义的星号', '\\*不是粗体\\*'],
  ])('%s 不提示', (_name, text) => {
    expect(detectPastedFormat(editor, text)).toBeNull();
  });
});

describe('粘贴范围跟踪', () => {
  it('纯文本粘贴后记录范围，选区变化保留，下一次修改清除', () => {
    let state = pastePlain(createState(''), '# 标题\n- 项');
    const range = getPastedTextRange(state);
    expect(range?.text).toBe('# 标题\n- 项');
    expect(state.doc.textBetween(range!.from, range!.to, '\n')).toBe('# 标题\n- 项');

    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    expect(getPastedTextRange(state)).toBe(range);

    state = state.apply(state.tr.insertText('x'));
    expect(getPastedTextRange(state)).toBeNull();
  });

  it('粘贴后追加的事务只映射范围', () => {
    let state = pastePlain(createState(''), '**粗**');
    const range = getPastedTextRange(state)!;
    // 模拟其它插件在 appendTransaction 中于文档开头插入内容
    state = state.apply(state.tr.insert(0, state.schema.nodes.paragraph.create()).setMeta('appendedTransaction', state.tr));
    const mapped = getPastedTextRange(state)!;
    expect(mapped.from).toBe(range.from + 2);
    expect(state.doc.textBetween(mapped.from, mapped.to)).toBe('**粗**');
  });

  it('主动关闭清除范围且不修改文档', () => {
    const pasted = pastePlain(createState(''), '**粗体**');
    const state = pasted.apply(createDismissTransaction(pasted));
    expect(getPastedTextRange(state)).toBeNull();
    expect(state.doc.eq(pasted.doc)).toBe(true);
  });

  it('代码块内粘贴不记录', () => {
    const state = pastePlain(createState('```\ncode\n```', 3), '# 标题');
    expect(getPastedTextRange(state)).toBeNull();
  });

  it('编辑器内部复制的内容不记录', () => {
    const state = pastePlain(createState(''), '# 标题', '<p data-pm-slice="1 1 []"># 标题</p>');
    expect(getPastedTextRange(state)).toBeNull();
  });
});

/** 按指定方式转换当前粘贴范围 */
function convert(state: EditorState, mode: PasteConvertMode): EditorState {
  const range = getPastedTextRange(state)!;
  const slice = createConvertSlice(editor, state, range, mode)!;
  return state.apply(createConvertTransaction(state, range, slice)!);
}

// 网页源码片段：缩进很深、含空行与注释、属性值跨行（按 Markdown 解析会被拆成代码块与零散 HTML）
const WEB_SOURCE = [
  '<div class="result c-container" data-click="{&quot;p1&quot;:6}">',
  '            <div class="cosc-card"><div class="',
  '                        title-box_6uu5k',
  '                    "><h3 class="cosc-title"><a href="https://example.com/a" target="_blank"><span><!--s-text-->什么是<em>EdgeEver</em>?<!--/s-text--></span></a></h3></div>',
  '',
  '',
  '        <div class="summary"><span>8天前</span><span>开源的 AI 知识库</span></div>',
  '        <script>alert(1)</script>',
  '    </div></div>',
].join('\n');

describe('HTML 源码', () => {
  it('网页源码识别为整段 HTML，提供 HTML 块与转为正文两种方式', () => {
    expect(detectPastedFormat(editor, WEB_SOURCE)).toEqual({ kind: 'html', modes: ['htmlBlock', 'richText'] });
  });

  it('标签之外有 Markdown 块语法时仍按 Markdown 处理', () => {
    expect(isHtmlSource('<div align="center">\n\n# 标题\n\n</div>')).toBe(false);
    expect(detectPastedFormat(editor, '<div align="center">\n\n# 标题\n\n</div>')?.modes).toEqual(['markdown']);
  });

  it('转为正文：像网页复制一样解析，脚本与注释被丢弃', () => {
    const converted = convert(pastePlain(createState(''), WEB_SOURCE), 'richText');
    const markdown = serializeState(converted);
    expect(markdown).toContain('### [什么是*EdgeEver*?](https://example.com/a)');
    expect(markdown).toContain('8天前');
    expect(markdown).not.toContain('alert');
    expect(markdown).not.toContain('s-text');
  });

  it('HTML 块：去掉空行后整段成为一个 HTML 块，重新打开仍是一个块', () => {
    const converted = convert(pastePlain(createState(''), WEB_SOURCE), 'htmlBlock');
    const blocks: string[] = [];
    converted.doc.forEach((node) => blocks.push(node.type.name));
    expect(blocks.filter((type) => type === 'rawHtmlBlock')).toHaveLength(1);

    const markdown = serializeState(converted);
    parseMarkdown(editor, markdown);
    const reopened: string[] = [];
    editor.state.doc.forEach((node) => reopened.push(node.type.name));
    expect(reopened).toEqual(['rawHtmlBlock']);
  });
});

describe('转换', () => {
  it('空段落中粘贴的 Markdown 转换为块结构，撤销回到纯文本', () => {
    const text = '# 标题\n\n- 一\n- 二\n\n<p align="center">居中</p>';
    const pasted = pastePlain(createState(''), text);
    expect(detectPastedFormat(editor, text)?.modes).toEqual(['markdown']);
    const converted = convert(pasted, 'markdown');
    expect(getPastedTextRange(converted)).toBeNull();
    expect(serializeState(converted)).toBe('# 标题\n\n- 一\n- 二\n\n<p align="center">居中</p>');

    const reverted = undoState(converted);
    expect(reverted.doc.eq(pasted.doc)).toBe(true);
  });

  it('段落中间粘贴的行内格式就地转换', () => {
    const converted = convert(pastePlain(createState('前后', 2), '**粗**'), 'markdown');
    expect(serializeState(converted)).toBe('前**粗**后');
  });
});

describe('已格式化判定', () => {
  it('粘贴规则已转换成相同结果时视为已格式化', () => {
    const pasted = pastePlain(createState('前后', 2), '**粗**');
    const range = getPastedTextRange(pasted)!;
    expect(isRangeAlreadyFormatted(editor, pasted, range, 'markdown')).toBe(false);
    // 模拟粘贴规则：把 **粗** 就地替换为带粗体的“粗”
    const bold = pasted.schema.marks.bold.create();
    const ruled = pasted.apply(
      pasted.tr.replaceWith(range.from, range.to, pasted.schema.text('粗', [bold])).setMeta('appendedTransaction', pasted.tr),
    );
    expect(isRangeAlreadyFormatted(editor, ruled, getPastedTextRange(ruled)!, 'markdown')).toBe(true);
  });
});

describe('空 HTML 块', () => {
  it('序列化时忽略，不写出多余空行，也不影响冗余转义清理', () => {
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    editor.commands.setContent({ type: 'doc', content: [paragraph('前'), paragraph('后 *')] });
    const expected = serializeMarkdown(editor);
    editor.commands.setContent({
      type: 'doc',
      content: [paragraph('前'), { type: 'rawHtmlBlock', attrs: { raw: '' } }, paragraph('后 *')],
    });
    expect(serializeMarkdown(editor)).toBe(expected);
    expect(expected).toBe('前\n\n后 *');
  });
});
