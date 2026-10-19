// NoteBoard 思维导图文本搜索与替换
// 在节点树的标题文本上实现统一搜索能力（SearchCapabilities），供全局悬浮搜索栏调用。
// 匹配覆盖整棵树（含折叠分支），按前序遍历顺序（自上而下）排列；跳转到折叠分支内的
// 匹配项时自动展开其祖先节点。高亮与定位由编辑器经 onHighlight 回调交给视图渲染。

import type { MindNode } from './mindmapTypes';
import type { MatchStats, ReplaceOutcome, SearchCapabilities, TextSearchOptions } from '../../core/editor/editorTypes';
import { buildSearchRegExp } from '../search/searchController';
import { adjustMarksForTextChange } from './mindmapRichText';
import { cloneMindmapTree, updateMindmapNode, walkMindNodes } from './mindmapTree';

/** 单个匹配项：节点 + 标题文本内区间 + 节点前序序号（用于定位"上一个/下一个"） */
export interface MindmapMatch {
  nodeId: string;
  order: number;
  from: number;
  to: number;
}

/** 视图高亮状态 */
export interface MindmapSearchHighlight {
  /** 节点 → 其标题内的匹配区间 */
  ranges: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
  /** 当前匹配项所在节点（无当前项为 null） */
  currentId: string | null;
  /** 定位序号：每次显式跳转递增，视图据此把当前节点滚动/平移到可视区中央 */
  focusSeq: number;
}

export const EMPTY_MINDMAP_SEARCH_HIGHLIGHT: MindmapSearchHighlight = {
  ranges: new Map(),
  currentId: null,
  focusSeq: 0,
};

/** 收集全部匹配项（前序遍历；空匹配跳过） */
export function findMindmapMatches(root: MindNode, regex: RegExp): MindmapMatch[] {
  const matches: MindmapMatch[] = [];
  let order = 0;
  for (const node of walkMindNodes(root)) {
    const nodeOrder = order++;
    const text = node.text ?? '';
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        // 零宽匹配（如 ^、\b）不计入，并前进一位防止死循环
        regex.lastIndex += 1;
        continue;
      }
      matches.push({ nodeId: node.id, order: nodeOrder, from: m.index, to: m.index + m[0].length });
    }
  }
  return matches;
}

/** 比较两个匹配位置的先后（节点序号优先，其次文本偏移） */
function comparePosition(a: { order: number; from: number }, b: { order: number; from: number }): number {
  return a.order !== b.order ? a.order - b.order : a.from - b.from;
}

/**
 * 仅沿目标路径复制节点并改写目标节点（其余子树共享引用）。
 * 目标不存在时返回原树。
 */
function updateNodeById(root: MindNode, nodeId: string, update: (node: MindNode) => MindNode): MindNode {
  return updateMindmapNode(root, nodeId, update);
}

/** 展开目标节点的所有折叠祖先；无需展开时返回原树 */
export function expandMindmapAncestors(root: MindNode, nodeId: string): MindNode {
  return updateMindmapNode(root, nodeId, (node) => node, true);
}

/** 计算单个匹配片段的替换文本（正则模式支持 $1 / $& 等引用，普通模式按字面插入） */
function computeReplacement(matched: string, options: TextSearchOptions): string {
  if (!options.isRegex) return options.replaceText;
  const single = buildSearchRegExp(options, false);
  return single ? matched.replace(single, options.replaceText) : options.replaceText;
}

/** 编辑器侧宿主：读取/提交节点树并接收高亮状态 */
export interface MindmapSearchHost {
  getRoot: () => MindNode;
  /** 提交新树（进入文档历史并持久化；调用后 getRoot 须立即返回新树） */
  commitRoot: (root: MindNode) => void;
  onHighlight: (highlight: MindmapSearchHighlight) => void;
}

/** 构造思维导图搜索能力 */
export function createMindmapSearchCapabilities(host: MindmapSearchHost): SearchCapabilities {
  // 当前匹配项（相当于文本编辑器中的选区）；树变化后按位置重新对齐
  let current: { nodeId: string; order: number; from: number; to: number } | null = null;
  let focusSeq = 0;

  const emptyStats: MatchStats = { matchIndex: 0, matchCount: 0 };

  /** 计算匹配项；正则非法时返回 error */
  const collect = (options: TextSearchOptions): { matches: MindmapMatch[]; error?: string } => {
    try {
      const regex = buildSearchRegExp(options, true);
      return { matches: regex ? findMindmapMatches(host.getRoot(), regex) : [] };
    } catch {
      return { matches: [], error: '正则表达式格式错误' };
    }
  };

  /** 当前项在列表中的序号（-1 表示当前项已不是匹配项） */
  const currentIndex = (matches: MindmapMatch[]): number =>
    current
      ? matches.findIndex((m) => m.nodeId === current!.nodeId && m.from === current!.from && m.to === current!.to)
      : -1;

  /** 推送高亮（focus=true 时请求视图把当前节点移到可视区中央） */
  const publish = (matches: MindmapMatch[], index: number, focus: boolean) => {
    const ranges = new Map<string, Array<readonly [number, number]>>();
    for (const m of matches) {
      const list = ranges.get(m.nodeId);
      if (list) list.push([m.from, m.to]);
      else ranges.set(m.nodeId, [[m.from, m.to]]);
    }
    if (focus) focusSeq += 1;
    host.onHighlight({ ranges, currentId: index >= 0 ? matches[index].nodeId : null, focusSeq });
  };

  /** 跳转到指定序号：展开折叠祖先、记录当前项并请求定位 */
  const goTo = (matches: MindmapMatch[], index: number): MatchStats => {
    const target = matches[index];
    current = { ...target };
    const root = host.getRoot();
    const expanded = expandMindmapAncestors(root, target.nodeId);
    if (expanded !== root) host.commitRoot(expanded);
    publish(matches, index, true);
    return { matchIndex: index + 1, matchCount: matches.length };
  };

  /** 当前位置之后（next）/ 之前（prev）的匹配序号，越界回绕 */
  const pickIndex = (matches: MindmapMatch[], direction: 'next' | 'prev'): number => {
    if (!current) return direction === 'next' ? 0 : matches.length - 1;
    if (direction === 'next') {
      const i = matches.findIndex((m) => comparePosition(m, current!) > 0);
      return i === -1 ? 0 : i;
    }
    for (let i = matches.length - 1; i >= 0; i--) {
      if (comparePosition(matches[i], current) < 0) return i;
    }
    return matches.length - 1;
  };

  const navigate = (options: TextSearchOptions, pick: (matches: MindmapMatch[]) => number): MatchStats => {
    const { matches } = collect(options);
    if (matches.length === 0) {
      publish(matches, -1, false);
      return emptyStats;
    }
    return goTo(matches, pick(matches));
  };

  return {
    // 仅刷新高亮与计数，不跳转（与文本编辑器语义一致）
    search: (options) => {
      if (!options.searchText) current = null;
      const { matches } = collect(options);
      const index = currentIndex(matches);
      publish(matches, index, false);
      return matches.length ? { matchIndex: index + 1, matchCount: matches.length } : emptyStats;
    },
    findNext: (options) => navigate(options, (m) => pickIndex(m, 'next')),
    findPrev: (options) => navigate(options, (m) => pickIndex(m, 'prev')),
    findFirst: (options) => navigate(options, () => 0),
    findLast: (options) => navigate(options, (m) => m.length - 1),
    replace: (options): ReplaceOutcome => {
      const { matches, error } = collect(options);
      if (error) return { success: false, replacedCount: 0, ...emptyStats, error };
      if (matches.length === 0) return { success: false, replacedCount: 0, ...emptyStats };
      // 当前项仍是匹配项则替换它，否则替换当前位置之后的下一个
      const selected = currentIndex(matches);
      const target = matches[selected !== -1 ? selected : pickIndex(matches, 'next')];
      let insertedLength = 0;
      const next = updateNodeById(host.getRoot(), target.nodeId, (node) => {
        const text = node.text ?? '';
        const insert = computeReplacement(text.slice(target.from, target.to), options);
        insertedLength = insert.length;
        const nextText = text.slice(0, target.from) + insert + text.slice(target.to);
        // 富文本格式随文字平移，替换进来的文字继承原位置的格式
        return { ...node, text: nextText, marks: adjustMarksForTextChange(text, nextText, node.marks) };
      });
      host.commitRoot(next);
      // 光标落在替换文本之后（-0.5 使紧随其后的匹配项严格位于其后，且不回头匹配替换文本自身），
      // 再定位到下一个匹配项，便于连续替换
      const caret = target.from + insertedLength - 0.5;
      current = { nodeId: target.nodeId, order: target.order, from: caret, to: caret };
      const after = collect(options).matches;
      if (after.length === 0) {
        current = null;
        publish(after, -1, false);
        return { success: true, replacedCount: 1, ...emptyStats };
      }
      return { success: true, replacedCount: 1, ...goTo(after, pickIndex(after, 'next')) };
    },
    replaceAll: (options): ReplaceOutcome => {
      const { matches, error } = collect(options);
      if (error) return { success: false, replacedCount: 0, ...emptyStats, error };
      if (matches.length === 0) return { success: false, replacedCount: 0, ...emptyStats };
      // 同节点内从后往前替换，避免偏移错位；一次提交成单条历史记录
      const next = cloneMindmapTree(host.getRoot());
      const byNode = new Map<string, MindmapMatch[]>();
      for (const m of matches) {
        const list = byNode.get(m.nodeId);
        if (list) list.push(m);
        else byNode.set(m.nodeId, [m]);
      }
      // 所有匹配节点只走一遍，避免每个节点替换都重新扫描并复制整棵树。
      for (const node of walkMindNodes(next)) {
        const list = byNode.get(node.id);
        if (list) {
          let text = node.text ?? '';
          let marks = node.marks;
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            const nextText = text.slice(0, m.from) + computeReplacement(text.slice(m.from, m.to), options) + text.slice(m.to);
            // 逐处平移格式，保证多处替换之间的格式区间各自正确
            marks = adjustMarksForTextChange(text, nextText, marks);
            text = nextText;
          }
          node.text = text;
          node.marks = marks;
        }
      }
      host.commitRoot(next);
      current = null;
      const after = collect(options).matches;
      publish(after, -1, false);
      return { success: true, replacedCount: matches.length, matchIndex: 0, matchCount: after.length };
    },
  };
}
