// NoteBoard 全屏关系图谱
// 展示整个仓库的笔记链接关系，也可切换为以当前笔记为中心的局部图；
// 可隐藏孤立笔记与未创建的笔记，点击节点打开笔记并收起图谱。桌面为居中大面板，移动端铺满全屏。

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Waypoints, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { IS_MOBILE_UI } from '../../core/platform';
import { useBackDismiss } from '../../mobile/components';
import { useWindowStore } from '../../stores/windowStore';
import { filterLinkGraph, graphNodeIdOf, localSubgraph, type GraphNode } from './linkGraph';
import { useLinkGraphStore } from './linkGraphStore';
import { LinkGraphView } from './LinkGraphView';
import { openGraphNode, useLinkGraph } from './useLinkGraph';

type Scope = 'global' | 'local';

/** 本次运行中最后使用的显示选项 */
const lastOptions = { depth: 2, orphans: true, unresolved: true };

export function LinkGraphOverlay() {
  const close = useLinkGraphStore((state) => state.close);
  const initialScope = useLinkGraphStore((state) => state.initialScope);
  const activePath = useWindowStore((state) => (state.activeKey ? state.getTab(state.activeKey)?.path ?? null : null));
  const { root, graph, loading, refresh } = useLinkGraph(activePath);
  const focusId = activePath ? graphNodeIdOf(activePath) : null;
  const focusInGraph = Boolean(graph && focusId && graph.nodes.some((node) => node.id === focusId));

  const [scope, setScope] = useState<Scope>(initialScope);
  const [depth, setDepth] = useState(lastOptions.depth);
  const [orphans, setOrphans] = useState(lastOptions.orphans);
  const [unresolved, setUnresolved] = useState(lastOptions.unresolved);
  useEffect(() => {
    Object.assign(lastOptions, { depth, orphans, unresolved });
  }, [depth, orphans, unresolved]);

  // 当前笔记不在图中（未保存、不是 Markdown）时只能看全部
  const effectiveScope: Scope = scope === 'local' && focusInGraph ? 'local' : 'global';

  const visible = useMemo(() => {
    if (!graph) return null;
    const base = effectiveScope === 'local' && focusId ? localSubgraph(graph, focusId, depth) : graph;
    return filterLinkGraph(base, { orphans, unresolved, focusId });
  }, [graph, effectiveScope, focusId, depth, orphans, unresolved]);

  useBackDismiss(IS_MOBILE_UI, close);

  // Esc 关闭（移动端由返回键处理）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const openNode = (node: GraphNode) => {
    void openGraphNode(node).then((opened) => {
      if (opened) close();
    });
  };

  const noteCount = visible?.nodes.filter((node) => node.kind !== 'unresolved').length ?? 0;
  const status = !root
    ? '打开文件夹后可查看笔记关系'
    : visible === null
      ? '正在扫描笔记…'
      : `${noteCount} 篇笔记 · ${visible.edges.length} 条链接${visible.truncated ? ' · 笔记过多，仅显示部分' : ''}`;

  return createPortal(
    <div
      className="nb-prompt-overlay nb-graph-overlay"
      onMouseDown={(event) => {
        // 点击遮罩空白处关闭
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="nb-graph-dialog" role="dialog" aria-modal="true" aria-label="关系图谱">
        <div className="nb-graph-head">
          <div className="nb-prompt-icon nb-graph-icon">
            <Waypoints size={17} />
          </div>
          <div className="nb-graph-heading">
            <div className="nb-prompt-title">关系图谱</div>
            <div className="nb-graph-status">{status}</div>
          </div>
          <Tooltip content="重新扫描">
            <button
              type="button"
              className={`nb-prompt-close nb-graph-refresh${loading ? ' is-loading' : ''}`}
              aria-label="重新扫描"
              onClick={refresh}
            >
              <RefreshCw size={15} />
            </button>
          </Tooltip>
          <Tooltip content="关闭">
            <button type="button" className="nb-prompt-close" aria-label="关闭" onClick={close}>
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="nb-graph-options">
          <div className="nb-graph-segment" role="radiogroup" aria-label="显示范围">
            <button
              type="button"
              role="radio"
              aria-checked={effectiveScope === 'global'}
              className={`nb-graph-segment-item${effectiveScope === 'global' ? ' is-active' : ''}`}
              onClick={() => setScope('global')}
            >
              全部笔记
            </button>
            <Tooltip content={focusInGraph ? '以当前笔记为中心' : '当前文档不是已保存的笔记'}>
              <button
                type="button"
                role="radio"
                aria-checked={effectiveScope === 'local'}
                aria-disabled={!focusInGraph}
                className={`nb-graph-segment-item${effectiveScope === 'local' ? ' is-active' : ''}${focusInGraph ? '' : ' is-disabled'}`}
                onClick={() => {
                  if (focusInGraph) setScope('local');
                }}
              >
                当前笔记
              </button>
            </Tooltip>
          </div>
          {effectiveScope === 'local' && (
            <div className="nb-graph-segment" role="radiogroup" aria-label="展开层数">
              {[1, 2, 3].map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={depth === value}
                  className={`nb-graph-segment-item${depth === value ? ' is-active' : ''}`}
                  onClick={() => setDepth(value)}
                >
                  {value} 层
                </button>
              ))}
            </div>
          )}
          <Tooltip content="没有任何链接的笔记">
            <button
              type="button"
              aria-pressed={orphans}
              className={`nb-graph-chip${orphans ? ' is-active' : ''}`}
              onClick={() => setOrphans((value) => !value)}
            >
              孤立笔记
            </button>
          </Tooltip>
          <Tooltip content="链接了但还不存在的笔记">
            <button
              type="button"
              aria-pressed={unresolved}
              className={`nb-graph-chip${unresolved ? ' is-active' : ''}`}
              onClick={() => setUnresolved((value) => !value)}
            >
              未创建
            </button>
          </Tooltip>
        </div>

        <div className="nb-graph-body">
          {visible && visible.nodes.length > 0 && (
            <LinkGraphView graph={visible} focusId={focusId} variant="full" onOpenNode={openNode} />
          )}
          {root && visible && visible.nodes.length === 0 && (
            <div className="nb-graph-hint">
              还没有 Markdown 笔记<br />
              在笔记中输入 [[ 即可链接其它笔记
            </div>
          )}
          {/* 图例 */}
          {visible && visible.nodes.length > 0 && (
            <div className="nb-graph-legend" aria-hidden="true">
              {focusInGraph && <span><i className="is-focus" />当前笔记</span>}
              <span><i className="is-note" />笔记</span>
              {visible.nodes.some((node) => node.kind === 'file') && <span><i className="is-file" />附件</span>}
              {visible.nodes.some((node) => node.kind === 'unresolved') && <span><i className="is-unresolved" />未创建</span>}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
