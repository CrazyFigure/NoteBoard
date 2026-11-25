// 通过可视化编辑器的真实按键和事务验证插入菜单匹配，覆盖段内换行与中文触发符。
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { SuggestionPluginKey } from '@tiptap/suggestion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { buildCoreExtensions } from '../../src/features/editor-md/extensions/core';
import { slashSuggestion } from '../../src/features/editor-md/slashCommand';

describe('可视化编辑器的插入菜单', () => {
  let editor: Editor;

  beforeEach(() => {
    // 直接挂载生产环境的菜单和回车扩展，省去与匹配无关的界面插件。
    const extensions = buildExtensions('slash-command-test')
      .filter(({ name }) => name === 'slashCommand' || name === 'nbEnterKeyBehavior');
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [...buildCoreExtensions(), ...extensions],
      editorProps: { handleScrollToSelection: () => true },
    });
  });

  afterEach(() => editor.destroy());

  /** 用与浏览器输入相同的文档事务更新正文和光标。 */
  function typeText(text: string) {
    editor.view.dispatch(editor.state.tr.insertText(text));
  }

  /** 交给实际编辑器处理换行和关闭菜单的按键。 */
  function pressKey(key: 'Enter' | 'Escape') {
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  it.each(['/', '、'])('段首输入 %s 打开菜单，搜索范围保留实际触发符，Esc 关闭后保留原文', (trigger) => {
    typeText(trigger);
    expect(SuggestionPluginKey.getState(editor.state)).toMatchObject({ active: true, query: '' });

    typeText('h2');
    expect(SuggestionPluginKey.getState(editor.state)).toMatchObject({
      active: true,
      range: { from: 1, to: 4 },
      query: 'h2',
      text: `${trigger}h2`,
    });

    pressKey('Escape');
    expect(SuggestionPluginKey.getState(editor.state)?.active).toBe(false);
    expect(editor.state.doc.textContent).toBe(`${trigger}h2`);
  });

  it.each(['/', '、'])('正文按一次 Enter 后输入 %s 仍能打开菜单，匹配范围跳过换行', (trigger) => {
    typeText('正文');
    pressKey('Enter');
    typeText(trigger);

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe(`正文\n${trigger}`);
    expect(SuggestionPluginKey.getState(editor.state)).toMatchObject({
      active: true,
      range: { from: 4, to: 5 },
      query: '',
    });

    pressKey('Escape');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe(`正文\n${trigger}`);
  });

  it.each(['/', '、'])('确认续行中的 %sh2 才换段，原正文保留且一次撤销复原', (trigger) => {
    typeText('正文');
    pressKey('Enter');
    typeText(`${trigger}h2`);
    const suggestion = SuggestionPluginKey.getState(editor.state);
    expect(suggestion?.active).toBe(true);
    const before = editor.state.doc;

    // 将输入和确认分成两个撤销组，验证确认产生的换段与格式转换一起撤销。
    editor.view.dispatch(closeHistory(editor.state.tr));
    slashSuggestion.command({
      editor,
      range: suggestion.range,
      props: {
        id: 'heading2', label: '二级标题', description: '', icon: null,
        action: (target, range) => target.chain().deleteRange(range).setNode('heading', { level: 2 }).run(),
      },
    });

    // 标题成为文末块时，编辑器还会按原规则补一个辅助输入段落。
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');
    expect(editor.state.doc.child(0).textContent).toBe('正文');
    expect(editor.state.doc.child(1).type.name).toBe('heading');
    expect(editor.state.doc.child(1).attrs.level).toBe(2);
    expect(editor.state.doc.child(1).textContent).toBe('');
    expect(editor.state.doc.child(2).attrs.sourceTrailingPlaceholder).toBe(true);

    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it.each(['/', '、'])('行内直接输入 %s 保留正文用途，空格后可用于打开菜单', (trigger) => {
    typeText(`甲${trigger}乙`);
    expect(SuggestionPluginKey.getState(editor.state)?.active).toBe(false);

    typeText(` ${trigger}`);
    expect(SuggestionPluginKey.getState(editor.state)).toMatchObject({ active: true, query: '' });
  });
});
