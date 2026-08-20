// NoteBoard 思维导图与大纲数据契约
// 统一节点树结构 + XMind Zen / 2020+ 数据契约定义
// 详见 docs/09-开发路线图.md

export interface MindNode {
  id: string;
  text: string;
  note?: string;
  isExpanded?: boolean;
  color?: string;
  children: MindNode[];
}

export interface MindmapDocumentData {
  version: number;
  root: MindNode;
  theme?: string;
  layout?: 'right' | 'balanced';
}

/** XMind content.json 数据结构 */
export interface XMindTopic {
  id: string;
  title: string;
  note?: { plain: { content: string } };
  children?: {
    attached?: XMindTopic[];
  };
  style?: Record<string, unknown>;
}

export interface XMindSheet {
  id: string;
  title: string;
  rootTopic: XMindTopic;
}

export type XMindContentJson = XMindSheet[];
