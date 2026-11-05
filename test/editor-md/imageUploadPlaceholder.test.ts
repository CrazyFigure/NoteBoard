// NoteBoard 图片插入占位：粘贴 / 拖入图片保存期间立即显示预览与加载动画，完成后原位替换为图片
// 回归：粘贴图片后要等保存完成才出现，期间没有任何反馈，用户分不清是程序没反应还是没按到键

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EnhancedImageBlockCore } from '../../src/features/editor-md/imageCore';
import {
  ImageUploadPlaceholder,
  beginImageInsertion,
  imageUploadPlaceholderKey,
} from '../../src/features/editor-md/imageUploadPlaceholder';

/** 最小文档节点（项目未直接依赖 @tiptap/extension-document） */
const Document = Node.create({ name: 'doc', topNode: true, content: 'block+' });

let editor: Editor;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text, EnhancedImageBlockCore, ImageUploadPlaceholder],
    content: '<p>前文</p><p>后文</p>',
  });
  // 光标放在「前文」之后
  editor.commands.setTextSelection(3);
});

afterEach(() => {
  editor.destroy();
  host.remove();
});

/** 当前占位装饰的位置列表 */
function placeholders(): number[] {
  return (imageUploadPlaceholderKey.getState(editor.state)?.find() ?? []).map((decoration) => decoration.from);
}

function imageSources(): string[] {
  const sources: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') sources.push(String(node.attrs.src));
  });
  return sources;
}

describe('图片插入占位', () => {
  it('开始插入时立即显示占位与加载提示，但不修改文档', () => {
    const before = editor.state.doc;
    beginImageInsertion(editor, 'blob:preview');
    expect(placeholders()).toEqual([3]);
    expect(editor.state.doc.eq(before)).toBe(true);
    const widget = host.querySelector('.nb-image-uploading');
    expect(widget).not.toBeNull();
    expect(widget?.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
    expect(widget?.textContent).toContain('正在插入图片');
  });

  it('保存完成后在占位处插入图片并移除占位', () => {
    const insertion = beginImageInsertion(editor, null);
    insertion.commit({ src: './img/a.png', alt: 'a' });
    expect(placeholders()).toEqual([]);
    expect(imageSources()).toEqual(['./img/a.png']);
    expect(host.querySelector('.nb-image-uploading')).toBeNull();
  });

  it('插入后光标落到图片下方的段落，继续输入不会替换掉图片', () => {
    const insertion = beginImageInsertion(editor, null);
    insertion.commit({ src: './img/a.png' });
    const { selection } = editor.state;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.textContent).toBe('后文');
    editor.commands.insertContent('继续');
    expect(imageSources()).toEqual(['./img/a.png']);
  });

  it('图片位于文末时在其后新建空段落放置光标', () => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const insertion = beginImageInsertion(editor, null);
    insertion.commit({ src: './img/a.png' });
    const { doc, selection } = editor.state;
    expect(doc.lastChild?.type.name).toBe('paragraph');
    expect(doc.lastChild?.textContent).toBe('');
    expect(selection.$from.parent).toBe(doc.lastChild);
  });

  it('保存期间光标移到别处时不打扰用户：插入后选区保持原位', () => {
    const insertion = beginImageInsertion(editor, null);
    // 用户把光标移到「后文」中间继续编辑（5 为「后文」起点）
    editor.commands.setTextSelection(6);
    insertion.commit({ src: './img/a.png' });
    expect(imageSources()).toEqual(['./img/a.png']);
    expect(editor.state.selection.$from.parent.textContent).toBe('后文');
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });

  it('保存期间在占位之前输入，占位随之移动，图片仍插在原处', () => {
    const insertion = beginImageInsertion(editor, null);
    editor.commands.insertContentAt(1, '新增');
    expect(placeholders()).toEqual([5]);
    insertion.commit({ src: './img/a.png' });
    expect(editor.getText({ blockSeparator: '|' })).toBe('新增前文||后文');
    expect(imageSources()).toEqual(['./img/a.png']);
  });

  it('占位所在内容被删除时放弃插入', () => {
    const insertion = beginImageInsertion(editor, null);
    // 删除第一段（占位所在段落）
    editor.commands.deleteRange({ from: 0, to: 4 });
    expect(placeholders()).toEqual([]);
    insertion.commit({ src: './img/a.png' });
    expect(imageSources()).toEqual([]);
  });

  it('插入失败时移除占位，文档保持不变', () => {
    const before = editor.state.doc;
    const insertion = beginImageInsertion(editor, null);
    insertion.cancel();
    expect(placeholders()).toEqual([]);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it('有选中内容时先替换选区（与直接插入图片一致）', () => {
    editor.commands.setTextSelection({ from: 1, to: 3 });
    const insertion = beginImageInsertion(editor, null);
    expect(editor.getText({ blockSeparator: '|' })).toBe('|后文');
    insertion.commit({ src: './img/a.png' });
    expect(imageSources()).toEqual(['./img/a.png']);
  });
});
