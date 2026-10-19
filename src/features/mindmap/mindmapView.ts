// 大导图首次折叠只创建显示用的浅副本，不标脏，也不替换文件的权威节点树。
import type { MindNode } from './mindmapTypes';
import { walkMindNodes } from './mindmapTree';

/** 用户确认的首次折叠阈值；恰好 500 个节点仍沿用文件已有展开状态。 */
export const INITIAL_COLLAPSE_NODE_THRESHOLD = 500;

/** 超过阈值时仅显示根和一级分支；未显示的全部内容仍保留在节点树中。 */
export function createInitialMindmapView(root: MindNode): MindNode {
  let count = 0;
  for (const _node of walkMindNodes(root)) {
    count += 1;
    if (count > INITIAL_COLLAPSE_NODE_THRESHOLD) {
      return {
        ...root,
        isExpanded: true,
        children: root.children.map((child) => child.children.length > 0 ? { ...child, isExpanded: false } : child),
      };
    }
  }
  return root;
}
