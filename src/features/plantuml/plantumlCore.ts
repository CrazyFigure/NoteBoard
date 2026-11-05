// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
import { Node, mergeAttributes } from '@tiptap/core';
import { diagramFenceMarkdown } from '../editor-md/markdownFence';

/** PlantUmlBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const PlantUmlBlockCore = Node.create({
  name: 'plantumlBlock',
  // Markdown 序列化为 ```plantuml 围栏；打开时不自动转换为远程渲染预览，保持普通代码块
  ...diagramFenceMarkdown('plantumlBlock', 'plantuml'),
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,
  /** 文档属性与默认值由两端共用，避免重新装载时生成不同结构。 */
  addAttributes() {
    return {
      code: {
        default: '',
      },
    };
  },
  /** 保留既有 HTML 识别规则；只有主线程导入 HTML 时才读取 DOM。 */
  parseHTML() {
    return [
      { tag: 'div[data-plantuml]' },
      { tag: 'pre[data-language="plantuml"]' },
      { tag: 'pre[data-language="uml"]' },
      { tag: 'pre[data-language="puml"]' },
    ];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-plantuml': '' })];
  }
});
