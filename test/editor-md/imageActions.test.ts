// NoteBoard Markdown 图片右键菜单相关逻辑
// 1. 重命名图片文件：文件名拆分 / 校验、地址中文件名替换（保留目录写法与百分号编码）、同步文档内所有引用
// 2. 右键图片不再把图片选为整块（原先底板盖住图片，且右键菜单误判为「选中文本」弹出文字格式菜单）

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown } from '../../src/features/editor-md/serialize';
import {
  replaceSrcFileName,
  splitFileName,
  updateImageSources,
  validateFileStem,
} from '../../src/features/editor-md/imageActions';

const editor = new Editor({ element: null, extensions: buildExtensions('image-actions-test'), content: '' });

afterAll(() => {
  editor.destroy();
});

/** 文档中所有图片的地址（按出现顺序） */
function imageSources(): string[] {
  const sources: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') sources.push(String(node.attrs.src));
  });
  return sources;
}

describe('splitFileName', () => {
  it('拆分主名与扩展名', () => {
    expect(splitFileName('shot.png')).toEqual({ stem: 'shot', ext: '.png' });
    expect(splitFileName('a.b.c.jpeg')).toEqual({ stem: 'a.b.c', ext: '.jpeg' });
  });

  it('没有扩展名或以点开头的隐藏文件不拆分', () => {
    expect(splitFileName('README')).toEqual({ stem: 'README', ext: '' });
    expect(splitFileName('.gitignore')).toEqual({ stem: '.gitignore', ext: '' });
  });
});

describe('validateFileStem', () => {
  it('合法名称通过', () => {
    expect(validateFileStem('架构图 v2')).toBeNull();
    expect(validateFileStem('  首尾空白会被去掉  ')).toBeNull();
  });

  it('拒绝空名称、Windows 保留字符、控制字符与结尾的点', () => {
    expect(validateFileStem('   ')).not.toBeNull();
    expect(validateFileStem('a/b')).not.toBeNull();
    expect(validateFileStem('a:b')).not.toBeNull();
    expect(validateFileStem('a\u0001b')).not.toBeNull();
    expect(validateFileStem('name.')).not.toBeNull();
  });
});

describe('replaceSrcFileName', () => {
  it('保留原有目录写法', () => {
    expect(replaceSrcFileName('./img/1730000_shot.png', '架构图.png')).toBe('./img/架构图.png');
    expect(replaceSrcFileName('../assets/a.png', 'b.png')).toBe('../assets/b.png');
    expect(replaceSrcFileName('C:\\docs\\img\\a.png', 'b.png')).toBe('C:\\docs\\img\\b.png');
    expect(replaceSrcFileName('a.png', 'b.png')).toBe('b.png');
  });

  it('原文件名经过百分号编码时新名称同样编码', () => {
    expect(replaceSrcFileName('img/my%20shot.png', 'new name.png')).toBe('img/new%20name.png');
  });

  it('新名称含 % 时编码，避免按地址解码后指向别的文件', () => {
    expect(replaceSrcFileName('img/a.png', '50%.png')).toBe('img/50%25.png');
  });
});

describe('updateImageSources', () => {
  it('同一事务更新文档中引用同一图片的全部节点（含调整过尺寸的 <img>）', () => {
    parseMarkdown(editor, '![a](./img/a.png)\n\n![b](./img/b.png)\n\n<img src="./img/a.png" width="50%">');
    expect(imageSources()).toEqual(['./img/a.png', './img/b.png', './img/a.png']);
    const count = updateImageSources(editor, './img/a.png', './img/c.png');
    expect(count).toBe(2);
    expect(imageSources()).toEqual(['./img/c.png', './img/b.png', './img/c.png']);
  });

  it('没有匹配的图片时不派发事务', () => {
    const before = editor.state.doc;
    expect(updateImageSources(editor, './img/none.png', './img/x.png')).toBe(0);
    expect(editor.state.doc).toBe(before);
  });
});

describe('右键图片不选中整块', () => {
  const plugin = editor.extensionManager.plugins.find((item) =>
    (item as Plugin & { key: string }).key.startsWith('nbImageContextClick'),
  );
  const mousedown = plugin?.props.handleDOMEvents?.mousedown as
    | ((view: EditorView, event: MouseEvent) => boolean)
    | undefined;

  // 模拟编辑器 DOM：图片节点视图与普通段落
  const dom = document.createElement('div');
  dom.innerHTML = '<p>正文</p><div data-nb-image-view=""><img alt="" /></div>';
  const view = { dom } as unknown as EditorView;
  const image = dom.querySelector('img')!;
  const paragraph = dom.querySelector('p')!;

  function press(target: Element, init: MouseEventInit): MouseEvent {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, 'target', { value: target });
    return event;
  }

  it('图片扩展注册了右键拦截插件', () => {
    expect(mousedown).toBeTypeOf('function');
  });

  it('右键图片时跳过 ProseMirror 的点击选中并阻止默认行为', () => {
    const event = press(image, { button: 2 });
    expect(mousedown!(view, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('左键图片、右键正文仍按原有逻辑处理', () => {
    expect(mousedown!(view, press(image, { button: 0 }))).toBe(false);
    expect(mousedown!(view, press(paragraph, { button: 2 }))).toBe(false);
  });

  it('不属于当前编辑器的图片视图不拦截（嵌套编辑器各管各的）', () => {
    const outside = document.createElement('div');
    outside.innerHTML = '<div data-nb-image-view=""><img alt="" /></div>';
    expect(mousedown!(view, press(outside.querySelector('img')!, { button: 2 }))).toBe(false);
  });
});
