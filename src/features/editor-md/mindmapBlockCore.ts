// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store、mindmap 运行时或原生 API。
import { Node, mergeAttributes } from '@tiptap/core';
import { diagramFenceMarkdown } from './markdownFence';

/** 嵌入节点视图组件的选项 */
export interface MindmapBlockOptions {
  /** 所属文档 key（用于对接文档级历史与导图内相对文件链接解析） */
  docKey: string;
}

/** MindmapBlock 的共享文档与 Markdown 规则；节点视图及交互由主线程扩展补充。 */
export const MindmapBlockCore = Node.create<MindmapBlockOptions>({
  name: 'mindmapBlock',
  // Markdown 往返：序列化为 ```mindmap 围栏，打开时同语言围栏还原为导图预览块
  ...diagramFenceMarkdown('mindmapBlock', 'mindmap'),
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,
  addOptions() {
    return {
      docKey: '',
    };
  },
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
      { tag: 'div[data-mindmap]' },
      { tag: 'pre[data-language="mindmap"]' },
    ];
  },
  /** 沿用共享 HTML 输出结构，供主线程剪贴板和导出使用。 */
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-mindmap': '' })];
  },
});
