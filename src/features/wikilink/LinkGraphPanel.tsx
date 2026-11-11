// NoteBoard 关系图谱面板（局部图）
// 与大纲、反向链接共用侧栏（桌面）/ 底部面板（移动端）：以当前笔记为中心展开 1~2 层链接关系，
// 点击节点打开对应笔记，右上角可展开为全屏的全局图谱。

import { useMemo, useState } from 'react';
import { Maximize2, RefreshCw } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { useWindowStore } from '../../stores/windowStore';
import { graphNodeIdOf, localSubgraph } from './linkGraph';
import { useLinkGraphStore } from './linkGraphStore';
import { LinkGraphView } from './LinkGraphView';
import { openGraphNode, useLinkGraph } from './useLinkGraph';

type Depth = 1 | 2;

/** 本次运行中最后选择的展开层数 */
let lastDepth: Depth = 1;

export function LinkGraphPanel() {
  const activePath = useWindowStore((state) => (state.activeKey ? state.getTab(state.activeKey)?.path ?? null : null));
  const { graph, loading, refresh } = useLinkGraph(activePath);
  const [depth, setDepthState] = useState<Depth>(lastDepth);
  const showOverlay = useLinkGraphStore((state) => state.show);
  const focusId = activePath ? graphNodeIdOf(activePath) : null;

  const local = useMemo(() => (graph && focusId ? localSubgraph(graph, focusId, depth) : null), [graph, focusId, depth]);
  const setDepth = (next: Depth) => {
    lastDepth = next;
    setDepthState(next);
  };

  if (!activePath) {
    return <div className="nb-backlinks-empty">文档保存后可查看关系图谱</div>;
  }

  const linkedCount = local ? local.nodes.length - 1 : 0;

  return (
    <div className="nb-graph-panel">
      <div className="nb-backlinks-toolbar">
        <span className="nb-graph-panel-status">{local === null ? '正在扫描…' : `关联 ${Math.max(0, linkedCount)} 篇`}</span>
        <div className="nb-graph-panel-actions">
          <div className="nb-graph-segment" role="radiogroup" aria-label="展开层数" data-sheet-keep="">
            {([1, 2] as const).map((value) => (
              <Tooltip key={value} content={value === 1 ? '只显示直接链接' : '再展开一层'}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={depth === value}
                  className={`nb-graph-segment-item${depth === value ? ' is-active' : ''}`}
                  onClick={() => setDepth(value)}
                >
                  {value} 层
                </button>
              </Tooltip>
            ))}
          </div>
          <Tooltip content="重新扫描">
            <button
              type="button"
              className={`nb-backlinks-refresh${loading ? ' is-loading' : ''}`}
              aria-label="重新扫描"
              data-sheet-keep=""
              onClick={refresh}
            >
              <RefreshCw size={12} />
            </button>
          </Tooltip>
          {/* 不带 data-sheet-keep：移动端点击后收起底部面板，露出全屏图谱 */}
          <Tooltip content="全局图谱">
            <button type="button" className="nb-backlinks-refresh" aria-label="全局图谱" onClick={() => showOverlay('global')}>
              <Maximize2 size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="nb-graph-panel-body">
        {local && local.nodes.length > 0 && (
          <LinkGraphView graph={local} focusId={focusId} variant="panel" onOpenNode={(node) => void openGraphNode(node)} />
        )}
        {local && linkedCount <= 0 && (
          <div className="nb-graph-hint">
            暂无关联笔记<br />
            输入 [[ 即可链接其它笔记
          </div>
        )}
      </div>
    </div>
  );
}
