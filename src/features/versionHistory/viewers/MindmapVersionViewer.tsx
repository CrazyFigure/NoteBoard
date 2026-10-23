// NoteBoard 文档历史记录：思维导图可视化差异查看
// 用正式的导图渲染器只读呈现「合并树」：新增节点绿色描边、修改琥珀色、移动蓝色虚线、
// 删除的节点以半透明删除线挂回原位置。编辑、拖拽与选中在外层捕获阶段拦截，平移缩放与折叠照常可用。
// 解析失败（例如 Markdown 大纲格式的旧文件）时回退源码对比。

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { MindmapRenderer } from '../../mindmap/MindmapRenderer';
import { parseMindmapDocument, parseMindmapDocumentMeta, DEFAULT_MINDMAP_LAYOUT, DEFAULT_MINDMAP_THEME } from '../../mindmap/mindmapConverter';
import { getMindmapTheme } from '../../mindmap/mindmapTheme';
import { clampNodeMaxWidth } from '../../mindmap/mindmapTextMeasure';
import type { MindNode } from '../../mindmap/mindmapTypes';
import type { MindmapSearchHighlight } from '../../mindmap/mindmapSearch';
import { useSettingsStore } from '../../../stores/settingsStore';
import { diffMindmaps, type MindDiffChange } from '../diff/mindmapDiff';
import type { VersionViewerProps } from './viewerTypes';

const TextVersionViewer = lazy(() => import('./TextVersionViewer'));

const KIND_LABEL: Record<string, string> = { ins: '新增', del: '删除', mod: '修改', moved: '移动' };

/** 当前改动的说明文字 */
function describe(change: MindDiffChange): string {
  if (change.kind === 'mod' && change.oldText !== undefined && change.oldText !== change.text) {
    return `修改：${change.oldText} → ${change.text}`;
  }
  return `${KIND_LABEL[change.kind]}：${change.oldText ?? change.text}`;
}

function parseSafe(text: string): MindNode | null {
  try {
    return text.trim().startsWith('{') ? parseMindmapDocument(text) : null;
  } catch {
    return null;
  }
}

export default function MindmapVersionViewer(props: VersionViewerProps) {
  const { base, target, showChanges, onChangeInfo, navigatorRef } = props;
  const parsed = useMemo(() => {
    const b = parseSafe(target);
    const a = base === null ? null : parseSafe(base);
    if (!b || (base !== null && !a)) return null;
    return { target: b, diff: diffMindmaps(a, b) };
  }, [base, target]);
  const meta = useMemo(() => parseMindmapDocumentMeta(target), [target]);
  const theme = getMindmapTheme(meta.theme ?? DEFAULT_MINDMAP_THEME);
  const maxNodeWidth = clampNodeMaxWidth(useSettingsStore((s) => s.settings.editor.mindmapNodeMaxWidth));
  const textAlign = useSettingsStore((s) => s.settings.editor.mindmapTextAlign) === 'center' ? 'center' : 'left';
  const imageFit = useSettingsStore((s) => s.settings.editor.mindmapImageFit) === 'fill' ? 'fill' : 'original';

  // 查看用的本地树：折叠 / 展开只影响查看，不写回文档
  const shown = parsed ? (showChanges ? parsed.diff.root : parsed.target) : null;
  const [root, setRoot] = useState<MindNode | null>(shown);
  useEffect(() => setRoot(shown), [shown]);
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState<MindmapSearchHighlight>({ ranges: new Map(), currentId: null, focusSeq: 0 });
  const indexRef = useRef(-1);
  const changes = parsed && showChanges ? parsed.diff.changes : [];
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const onChangeInfoRef = useRef(onChangeInfo);
  onChangeInfoRef.current = onChangeInfo;

  const focusChange = (index: number) => {
    const change = changesRef.current[index];
    if (!change) return;
    indexRef.current = index;
    setFocus((f) => ({ ranges: new Map(), currentId: change.id, focusSeq: f.focusSeq + 1 }));
    onChangeInfoRef.current({ count: changesRef.current.length, index });
  };

  // 版本或开关变化：定位到第一处改动
  useEffect(() => {
    indexRef.current = -1;
    if (changes.length > 0) {
      // 等新树完成布局后再平移
      const timer = window.setTimeout(() => focusChange(0), 60);
      return () => window.clearTimeout(timer);
    }
    setFocus((f) => ({ ranges: new Map(), currentId: null, focusSeq: f.focusSeq }));
    onChangeInfoRef.current({ count: 0, index: -1 });
    return undefined;
  }, [parsed, showChanges]);

  useEffect(() => {
    if (!parsed) return;
    navigatorRef.current = {
      next: () => focusChange(Math.min(changesRef.current.length - 1, indexRef.current + 1)),
      prev: () => focusChange(Math.max(0, indexRef.current - 1)),
    };
    return () => {
      navigatorRef.current = null;
    };
  }, [parsed, navigatorRef]);

  if (!parsed || !root) {
    return (
      <>
        <div className="nb-vh-banner">无法按导图呈现，显示源码对比</div>
        <Suspense fallback={null}>
          <TextVersionViewer {...props} />
        </Suspense>
      </>
    );
  }

  const current = indexRef.current >= 0 ? changes[indexRef.current] : undefined;
  /** 只读：节点上的编辑、拖拽与选中在捕获阶段拦截（画布空白处仍可平移） */
  const onNode = (e: React.SyntheticEvent) => {
    const el = e.target as HTMLElement;
    // 折叠按钮放行，便于查看大图
    if (el.closest('.nb-mindmap-node') && !el.closest('[aria-label*="子分支"]')) e.stopPropagation();
  };

  return (
    <div
      className="nb-vh-mindmap"
      data-changes={showChanges ? 'on' : 'off'}
      onPointerDownCapture={onNode}
      onClickCapture={onNode}
      onDoubleClickCapture={(e) => e.stopPropagation()}
      onContextMenuCapture={(e) => e.preventDefault()}
    >
      <MindmapRenderer
        root={root}
        onChange={setRoot}
        zoom={zoom}
        onZoomChange={setZoom}
        layout={meta.layout ?? DEFAULT_MINDMAP_LAYOUT}
        theme={theme}
        edgeStyle={meta.edgeStyle ?? theme.edgeStyle}
        maxNodeWidth={maxNodeWidth}
        defaultTextAlign={textAlign}
        defaultImageFit={imageFit}
        searchHighlight={focus}
        diffMarks={showChanges ? parsed.diff.marks : undefined}
      />
      {current && <div className="nb-vh-caption">{describe(current)}</div>}
    </div>
  );
}
