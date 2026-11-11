// NoteBoard 关系图谱数据 Hook
// 侧栏局部图与全屏图谱共用：随仓库根、索引重建与已打开文档的编辑（防抖）自动刷新。

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useDocumentStore } from '../../stores/documentStore';
import { showToast } from '../../stores/toastStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { collectLinkGraph, linkGraphRootOf, type GraphNode, type LinkGraph } from './linkGraph';
import { getNoteIndexVersion, invalidateNoteIndex, subscribeNoteIndex } from './noteIndex';
import { openNotePath } from './wikiLinkNavigation';

/** 打开图谱中的节点；未创建的笔记与正文中的双链一致，只提示不擅自新建 */
export async function openGraphNode(node: GraphNode): Promise<boolean> {
  if (!node.path) {
    showToast(`未找到「${node.name}」，可能尚未同步到本机`, 'warning');
    return false;
  }
  try {
    return await openNotePath(node.path);
  } catch (error) {
    console.error('[linkGraph] 打开笔记失败:', error);
    showToast(`无法打开「${node.name}」`, 'error');
    return false;
  }
}

/** 已打开文档编辑后的刷新防抖（与反向链接一致） */
const CONTENT_REFRESH_DELAY_MS = 1500;

export interface LinkGraphState {
  /** 仓库根；为 null 表示没有可用的工作区 */
  root: string | null;
  /** 完整图谱；首次扫描完成前为 null */
  graph: LinkGraph | null;
  loading: boolean;
  /** 重建索引并重新收集 */
  refresh: () => void;
}

export function useLinkGraph(anchorPath: string | null): LinkGraphState {
  // 资源管理器根变化时重新计算仓库根
  const explorerRoot = useExplorerStore((state) => state.root);
  const indexVersion = useSyncExternalStore(subscribeNoteIndex, getNoteIndexVersion);
  const root = linkGraphRootOf(anchorPath);
  void explorerRoot;
  const [result, setResult] = useState<{ root: string; graph: LinkGraph } | null>(null);
  const [loading, setLoading] = useState(false);
  const [contentTick, setContentTick] = useState(0);

  // 已打开文档的内容变化（编辑、保存）后防抖刷新：新增或删除的链接需要反映出来
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useDocumentStore.subscribe((next, previous) => {
      if (next.documents === previous.documents) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setContentTick((tick) => tick + 1), CONTENT_REFRESH_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!root) return;
    const controller = new AbortController();
    setLoading(true);
    collectLinkGraph(root, controller.signal)
      .then((graph) => {
        if (!controller.signal.aborted && graph) setResult({ root, graph });
      })
      .catch((error) => {
        console.error('[linkGraph] 收集关系图谱失败:', error);
        if (!controller.signal.aborted) setResult({ root, graph: { nodes: [], edges: [], truncated: false } });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [root, indexVersion, contentTick]);

  const refresh = useCallback(() => {
    // 重建索引（有变化才会通知）的同时立即重新收集一次
    invalidateNoteIndex();
    setContentTick((tick) => tick + 1);
  }, []);

  // 切换到其它仓库时不显示上一个仓库的图
  const graph = result && root && result.root === root ? result.graph : null;
  return { root, graph, loading, refresh };
}
