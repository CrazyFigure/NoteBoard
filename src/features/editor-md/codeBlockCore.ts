// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import CodeBlock from '@tiptap/extension-code-block';
import { PREVIEW_FENCE_LANGUAGES, fenceLanguageOf, isBlockCodeToken, renderFencedCode, sourceFenceOf } from './markdownFence';

/** CodeBlockView 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const CodeBlockViewCore = CodeBlock.extend({
  /** 保留核心默认选项，界面功能由主线程扩展补充。 */
  addOptions() {
    const parent = (this.parent?.() ?? {}) as Record<string, unknown>;
    return {
      ...parent,
      lowlight: null,
    } as unknown as ReturnType<NonNullable<typeof this.parent>>;
  },

  // sourceFence：原文的开围栏（``` / ```` / ~~~），仅用于序列化时沿用原写法，不参与渲染
  addAttributes() {
    return {
      ...this.parent?.(),
      sourceFence: {
        default: null,
        rendered: false,
      },
    };
  },

  // 解析：Mermaid / Infographic 围栏交给对应预览块节点（返回空数组即让出 token），其余照常生成代码块
  parseMarkdown: (token, helpers) => {
    if (!isBlockCodeToken(token)) return [];
    if (PREVIEW_FENCE_LANGUAGES[fenceLanguageOf(token)]) return [];
    return helpers.createNode(
      'codeBlock',
      { language: token.lang || null, sourceFence: sourceFenceOf(token) },
      token.text ? [helpers.createTextNode(token.text)] : [],
    );
  },

  // 序列化：优先沿用原文围栏；内容会提前闭合它时，围栏长度随行首最长反引号串自适应
  renderMarkdown: (node, helpers) => {
    const language = (node.attrs?.language as string | null) || '';
    const code = node.content ? helpers.renderChildren(node.content) : '';
    return renderFencedCode(language, code, node.attrs?.sourceFence as string | null | undefined);
  }
});
