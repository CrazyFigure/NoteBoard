// Markdown 源码模式普通方括号装饰回归测试

import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { markdownPlainBracketExtension } from '../../src/features/editor-md/sourcePlainBracket';
import { nbSyntaxHighlighting } from '../../src/features/editor-code/highlightStyle';

/** 创建带真实 DOM 的 Markdown 源码编辑器，验证最终渲染类名而非仅验证解析树。 */
function createSourceView(content: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        bracketMatching(),
        markdownPlainBracketExtension,
        nbSyntaxHighlighting,
      ],
    }),
  });
}

describe('Markdown 源码模式普通方括号显示', () => {
  it('裸方括号添加普通正文装饰', () => {
    const view = createSourceView('composition [kəmpəˈzɪʃn]');

    const plainBracket = view.dom.querySelector('.nb-md-plain-bracket');
    expect(plainBracket?.textContent).toBe('[kəmpəˈzɪʃn]');

    // 光标停在开方括号后时，匹配括号装饰必须位于普通正文范围内，确保主题可取消方框。
    view.dispatch({ selection: { anchor: 'composition ['.length } });
    const matchedBrackets = [...view.dom.querySelectorAll('.cm-matchingBracket')];
    expect(matchedBrackets).toHaveLength(2);
    expect(matchedBrackets.every((bracket) => bracket.closest('.nb-md-plain-bracket'))).toBe(true);

    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  });

  it('行内链接、引用链接与图片不添加普通正文装饰', () => {
    const view = createSourceView([
      '[标题](https://example.com)',
      '[标题][引用]',
      '![图片](image.png)',
    ].join('\n'));

    expect(view.dom.querySelector('.nb-md-plain-bracket')).toBeNull();
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  });
});
