// NoteBoard 思维导图主编辑器 (Mindmap Editor)
// 双模切换 (导图模式 ⇄ 大纲模式) + XMind 导入导出 + 文件级统一撤销/重做
// 详见 docs/09-开发路线图.md

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ListTree,
  Network,
  Download,
  Upload,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  FileText,
  ChevronDown,
  Image as ImageIcon,
  MoveHorizontal,
  Undo2,
  Redo2,
  Braces,
  SquareDashed,
  Spline,
} from 'lucide-react';
import type {
  MindNode,
  MindmapLayout,
  MindmapEdgeStyle,
  MindmapImageFit,
  MindmapTextAlign,
} from './mindmapTypes';
import {
  parseMindmapDocument,
  parseMindmapDocumentMeta,
  serializeMindmapDocument,
  exportToXmindZip,
  markdownToMindNode,
  mindNodeToMarkdown,
  DEFAULT_MINDMAP_LAYOUT,
  DEFAULT_MINDMAP_THEME,
} from './mindmapConverter';
import { getMindmapTheme } from './mindmapTheme';
import { Dropdown, DropdownItem, MindmapStyleControls } from './MindmapStyleControls';
import { exportMindmapImageBlob, type MindmapImageFormat } from './mindmapImageExport';
import { clampNodeMaxWidth, FALLBACK_FONT_FAMILY } from './mindmapTextMeasure';
import { useSettingsStore } from '../../stores/settingsStore';
import { OutlinerEditor } from './OutlinerEditor';
import { MindmapRenderer, type MindmapRendererHandle, type MindmapSelectionInfo } from './MindmapRenderer';
import { createInitialMindmapView } from './mindmapView';
import { cloneMindmapTree, getMindmapTreeStats, walkMindNodes } from './mindmapTree';
import { confirmMindmapImport, requestMindmapChoice } from './MindmapImportDialog';
import { getSessionGeneration } from '../session/documentSession';
import { Tooltip } from '../../components/Tooltip';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { buildExportFileName, exportBlobWithDialog } from '../export/chartExport';
import {
  initializeDocumentHistory,
  registerDocumentHistoryAdapter,
  recordDocumentChange,
  undoDocumentHistory,
  redoDocumentHistory,
  useDocumentHistory,
  markDocumentHistoryModeBoundary,
} from '../history/documentHistory';
// 🔴 S12：回收接入——能力注册表（flush/canSuspend/视图捕获）与挂载恢复
import {
  registerEditorCapabilities,
  getDocumentRevision,
  bumpDocumentRevision,
} from '../../core/editor/editorRegistry';
import { scheduleAutoSave, submitCapturedContent } from '../session/documentSession';
import { takeViewState } from '../session/editorSuspension';
import { perfMarkEditorInstanceReady } from '../../core/perf/editorReadyMark';
import type { EditorCapabilities } from '../../core/editor/editorTypes';
import {
  createMindmapSearchCapabilities,
  EMPTY_MINDMAP_SEARCH_HIGHLIGHT,
  type MindmapSearchHighlight,
} from './mindmapSearch';

interface MindmapEditorProps {
  docKey: string;
}

type ViewMode = 'outliner' | 'mindmap';

/** 树中是否存在手动拉伸过宽度的节点 */
function hasCustomNodeWidth(node: MindNode): boolean {
  for (const current of walkMindNodes(node)) if (typeof current.width === 'number') return true;
  return false;
}

/** 返回移除所有手动宽度后的新树（不修改原树） */
function clearNodeWidths(node: MindNode): MindNode {
  const cloned = cloneMindmapTree(node);
  for (const current of walkMindNodes(cloned)) delete current.width;
  return cloned;
}

/** TipTap 无关的实例代际序号：同 docKey 重挂载递增（注册表删除保护） */
let nextMindmapInstanceId = 0;

export function MindmapEditor({ docKey }: MindmapEditorProps) {
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setDirty = useDocumentStore((s) => s.setDirty);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);

  const [viewMode, setViewMode] = useState<ViewMode>('mindmap');
  const [zoom, setZoom] = useState<number>(1);
  const [rootNode, setRootNode] = useState<MindNode>(() => {
    return parseMindmapDocument(doc?.content ?? '');
  });
  // 自动折叠仅作用于显示副本；保存/暂存仍读取 rootNode，打开本身不产生文件修改。
  const [autoCollapse, setAutoCollapse] = useState(true);
  const autoCollapseRef = useRef(autoCollapse);
  autoCollapseRef.current = autoCollapse;
  const initializedDocKeyRef = useRef(docKey);
  const displayedRoot = useMemo(() => autoCollapse ? createInitialMindmapView(rootNode) : rootNode, [rootNode, autoCollapse]);
  const displayedRootRef = useRef(displayedRoot);
  displayedRootRef.current = displayedRoot;
  // 文档级外观：布局 + 配色主题（持久化在文档 JSON 元信息中）
  const [layout, setLayout] = useState<MindmapLayout>(
    () => parseMindmapDocumentMeta(doc?.content ?? '').layout ?? DEFAULT_MINDMAP_LAYOUT,
  );
  const [themeId, setThemeId] = useState<string>(
    () => parseMindmapDocumentMeta(doc?.content ?? '').theme ?? DEFAULT_MINDMAP_THEME,
  );
  // 文档显式选择的连线样式；undefined 时跟随配色主题
  const [edgeStyle, setEdgeStyle] = useState<MindmapEdgeStyle | undefined>(
    () => parseMindmapDocumentMeta(doc?.content ?? '').edgeStyle,
  );
  const theme = getMindmapTheme(themeId);
  const resolvedEdgeStyle = edgeStyle ?? theme.edgeStyle;
  // 节点最大宽度设置：未手动拉伸的节点随设置实时重新排版
  const maxNodeWidth = clampNodeMaxWidth(
    useSettingsStore((s) => s.settings.editor.mindmapNodeMaxWidth),
  );
  // 节点未单独设置时的标题对齐与图片显示方式（设置项）
  const defaultTextAlign: MindmapTextAlign =
    useSettingsStore((s) => s.settings.editor.mindmapTextAlign) === 'center' ? 'center' : 'left';
  const defaultImageFit: MindmapImageFit =
    useSettingsStore((s) => s.settings.editor.mindmapImageFit) === 'fill' ? 'fill' : 'original';
  const rootElRef = useRef<HTMLDivElement>(null);
  // 导出默认文件名：已保存的文档用文件名，未保存的新文档统一叫「思维导图」
  const exportBaseName = docKey.startsWith('untitled:')
    ? '思维导图'
    : buildExportFileName(doc?.displayName, '思维导图');
  // 撤销 / 重做可用状态（画布左下角按钮）
  const { canUndo, canRedo } = useDocumentHistory(docKey);
  const [exportOpen, setExportOpen] = useState(false);
  // 画布命令句柄与当前选中节点（顶部「概要 / 外框 / 联系线」按钮使用）
  const rendererRef = useRef<MindmapRendererHandle>(null);
  const [selection, setSelection] = useState<MindmapSelectionInfo>({ nodeIds: [], includesRoot: false });
  // 概要 / 外框需选中非中心主题的节点；联系线需恰好选中一个节点
  const canAddRange = selection.nodeIds.length > 0 && !selection.includesRoot;
  const canConnect = selection.nodeIds.length === 1;
  /** 顶部插入按钮：条件不满足时提示怎么选，而不是静默无反应 */
  const runInsert = (enabled: boolean, hint: string, action: () => void) => {
    if (!enabled) {
      showToast(hint, 'info');
      return;
    }
    action();
  };
  // 🔴 S12：最新状态引用（capabilities flush/captureViewState 同步读取，不依赖渲染闭包）
  const rootNodeRef = useRef<MindNode>(rootNode);
  rootNodeRef.current = rootNode;
  const viewModeRef = useRef<ViewMode>(viewMode);
  viewModeRef.current = viewMode;
  const zoomRef = useRef<number>(zoom);
  zoomRef.current = zoom;
  const layoutRef = useRef<MindmapLayout>(layout);
  layoutRef.current = layout;
  const themeIdRef = useRef<string>(themeId);
  themeIdRef.current = themeId;
  const edgeStyleRef = useRef<MindmapEdgeStyle | undefined>(edgeStyle);
  edgeStyleRef.current = edgeStyle;
  // 全局搜索栏的匹配高亮（导图与大纲两种视图共用）
  const [searchHighlight, setSearchHighlight] = useState<MindmapSearchHighlight>(EMPTY_MINDMAP_SEARCH_HIGHLIGHT);
  // 搜索替换提交新树走与手动编辑相同的落盘/历史链路（函数在下方定义，经 ref 读取最新版本）
  const handleRootChangeRef = useRef<(newRoot: MindNode) => void>(() => {});

  // 注册统一文档历史快照应用器
  useEffect(() => {
    const initialContent = doc?.content ?? '';
    initializeDocumentHistory(docKey, initialContent, 'mindmap');

    const unregister = registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry) => {
        const parsed = parseMindmapDocument(entry.content);
        setRootNode(parsed);
        // 撤销/重做属于显式导航，应准确还原历史中的展开状态。
        setAutoCollapse(false);
        // 布局与配色随内容一起回滚，避免外观状态与文档不一致
        const meta = parseMindmapDocumentMeta(entry.content);
        setLayout(meta.layout);
        setThemeId(meta.theme);
        setEdgeStyle(meta.edgeStyle);
        setContent(docKey, entry.content);
        setDirty(docKey, true);
        setTabDirty(docKey, true);
        scheduleAutoSave(docKey);
      },
    });

    // 🔴 S12：重挂载（回收后）恢复查看模式与缩放（一次性消费）
    const restored = takeViewState(docKey) as
      | { kind: 'mindmap'; viewMode: ViewMode; zoom: number; autoCollapse?: boolean }
      | null;
    if (restored?.kind === 'mindmap') {
      setViewMode(restored.viewMode);
      setZoom(restored.zoom);
      setAutoCollapse(restored.autoCollapse ?? true);
    }

    return unregister;
  }, [docKey]);

  // 🔴 S12：注册能力对象（回收调度/保存/暂存统一走 core 注册表）
  useEffect(() => {
    const instanceId = `mindmap-${(nextMindmapInstanceId += 1)}`;
    const capabilities: EditorCapabilities = {
      docKey,
      instanceId,
      getRevision: () => getDocumentRevision(docKey),
      flush: async () => {
        // 内容权威已在 store（handleRootChange 同步 setContent）；序列化 rootNode 兜底对齐
        const content = serializeMindmapDocument(rootNodeRef.current, {
          layout: layoutRef.current,
          theme: themeIdRef.current,
          edgeStyle: edgeStyleRef.current,
        });
        submitCapturedContent(docKey, { instanceId, revision: getDocumentRevision(docKey), content });
        return { docKey, instanceId, revision: getDocumentRevision(docKey), content };
      },
      focus: () => {
        // 思维导图无独立键盘焦点入口，焦点由画布/大纲自身接管
      },
      getSelectedText: () => '',
      // 🔴 S12：每次交互同步提交 store（内容不依赖实例存活）——可回收；
      //    统一历史在 documentHistory（按 docKey，重挂载不清）
      canSuspend: () => true,
      captureViewState: () => ({
        kind: 'mindmap' as const,
        viewMode: viewModeRef.current,
        zoom: zoomRef.current,
        autoCollapse: autoCollapseRef.current,
      }),
      // 节点标题文本搜索替换（Ctrl+F / Ctrl+H 打开全局搜索栏）
      search: createMindmapSearchCapabilities({
        getRoot: () => displayedRootRef.current,
        commitRoot: (newRoot) => {
          // 同步更新引用：同一次搜索操作内紧随的匹配计算需读到新树
          rootNodeRef.current = newRoot;
          handleRootChangeRef.current(newRoot);
        },
        onHighlight: setSearchHighlight,
      }),
    };
    // 🔴 N10.2：思维导图实例就绪终点（能力注册完成；requestId 与打开请求对齐）
    perfMarkEditorInstanceReady(docKey, instanceId);
    return registerEditorCapabilities(capabilities);
  }, [docKey]);

  // 当外部文档切换或重新加载时同步状态（含布局与配色元信息）
  useEffect(() => {
    // 首次正文已在 useState 中读取，不能二次解析并覆盖刚恢复的显示状态。
    if (initializedDocKeyRef.current === docKey) return;
    initializedDocKeyRef.current = docKey;
    if (doc?.content != null) {
      const parsed = parseMindmapDocument(doc.content);
      setRootNode(parsed);
      setAutoCollapse(true);
      const meta = parseMindmapDocumentMeta(doc.content);
      setLayout(meta.layout);
      setThemeId(meta.theme);
      setEdgeStyle(meta.edgeStyle);
    }
  }, [docKey]);

  // 统一的文档落盘：序列化节点树 + 外观元信息，同步 store / 脏标记 / 历史
  const persistDocument = useCallback(
    (
      newRoot: MindNode,
      nextLayout: MindmapLayout,
      nextTheme: string,
      nextEdgeStyle: MindmapEdgeStyle | undefined,
    ) => {
      // 🔴 S12：真实修改推进内容版本（会话屏障校验用）
      bumpDocumentRevision(docKey);
      const serialized = serializeMindmapDocument(newRoot, {
        layout: nextLayout,
        theme: nextTheme,
        edgeStyle: nextEdgeStyle,
      });
      setContent(docKey, serialized);
      setDirty(docKey, true);
      setTabDirty(docKey, true);
      // auto 策略下停止编辑 800ms 后自动写盘
      scheduleAutoSave(docKey);
      recordDocumentChange(docKey, serialized, {
        mode: 'mindmap',
        startsNewGroup: true,
      });
    },
    [docKey, setContent, setDirty, setTabDirty],
  );

  // 节点树更新时同步到 DocumentStore、脏标记并记录文件级历史
  const handleRootChange = useCallback(
    (newRoot: MindNode) => {
      // 用户实际修改或展开后，把当前显示状态提交为正文；首次自动折叠本身不走这里。
      setAutoCollapse(false);
      autoCollapseRef.current = false;
      rootNodeRef.current = newRoot;
      displayedRootRef.current = newRoot;
      setRootNode(newRoot);
      persistDocument(newRoot, layoutRef.current, themeIdRef.current, edgeStyleRef.current);
    },
    [persistDocument],
  );
  handleRootChangeRef.current = handleRootChange;

  // 切换布局 / 配色主题 / 连线样式并即时持久化（edgeStyle 传 null 表示改回跟随主题）
  const handleStyleChange = useCallback(
    (next: { layout?: MindmapLayout; theme?: string; edgeStyle?: MindmapEdgeStyle | null }) => {
      const nextLayout = next.layout ?? layoutRef.current;
      const nextTheme = next.theme ?? themeIdRef.current;
      const nextEdgeStyle =
        next.edgeStyle === undefined ? edgeStyleRef.current : next.edgeStyle ?? undefined;
      setLayout(nextLayout);
      setThemeId(nextTheme);
      setEdgeStyle(nextEdgeStyle);
      setAutoCollapse(false);
      setRootNode(displayedRootRef.current);
      autoCollapseRef.current = false;
      rootNodeRef.current = displayedRootRef.current;
      persistDocument(displayedRootRef.current, nextLayout, nextTheme, nextEdgeStyle);
    },
    [persistDocument],
  );

  // 重置整个文档的节点宽度为设置值（一个撤销步）
  const hasCustomWidths = hasCustomNodeWidth(rootNode);
  const handleResetAllWidths = () => {
    if (!hasCustomNodeWidth(rootNodeRef.current)) return;
    handleRootChange(clearNodeWidths(displayedRootRef.current));
    showToast('已重置全部节点宽度', 'success');
  };

  // 切换查看模式（不记录新历史节点）
  const handleSwitchViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    markDocumentHistoryModeBoundary(docKey);
  };

  // 全局撤销/重做快捷键 (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 避免在普通文本框输入时拦截默认行为（除非在非输入区域或大纲整树操作）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          e.preventDefault();
          redoDocumentHistory(docKey);
        } else {
          e.preventDefault();
          undoDocumentHistory(docKey);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoDocumentHistory(docKey);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [docKey]);

  // 导出为 .xmind 文件（弹系统另存为对话框）
  const handleExportXmind = async () => {
    try {
      const blob = await exportToXmindZip(rootNode);
      const defaultFilename = `${exportBaseName}.xmind`;
      const filters = [
        { name: 'XMind 思维导图 (*.xmind)', extensions: ['xmind'] },
        { name: '全部文件 (*.*)', extensions: ['*'] },
      ];
      // 唤起原生对话框保存文件
      const saved = await exportBlobWithDialog(blob, defaultFilename, filters);
      if (saved) {
        showToast('成功导出为 XMind 文件', 'success');
      }
    } catch (err) {
      console.error('导出 XMind 失败:', err);
      showToast('导出 XMind 失败', 'error');
    }
  };

  // 导出为 Markdown 大纲（弹系统另存为对话框）
  const handleExportMarkdown = async () => {
    try {
      const md = mindNodeToMarkdown(rootNode);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const defaultFilename = `${exportBaseName}.md`;
      const filters = [
        { name: 'Markdown 大纲 (*.md)', extensions: ['md'] },
        { name: '全部文件 (*.*)', extensions: ['*'] },
      ];
      // 唤起原生对话框保存文件
      const saved = await exportBlobWithDialog(blob, defaultFilename, filters);
      if (saved) {
        showToast('成功导出为 Markdown 大纲', 'success');
      }
    } catch (err) {
      console.error('导出 Markdown 失败:', err);
      showToast('导出 Markdown 失败', 'error');
    }
  };

  // 导出为 PNG / JPG 图片：按当前布局与配色独立排版绘制，内容自动居中
  const handleExportImage = async (format: MindmapImageFormat) => {
    try {
      const scope = await requestMindmapChoice('选择图片导出范围', [
        { value: 'current', label: '按当前展开／折叠状态导出' },
        { value: 'all', label: '临时展开全部节点后导出' },
      ], '导出图片');
      if (scope === null) return;
      // 图片范围独立于视口裁剪；临时展开副本，不改变文件正文与当前画布状态。
      const imageRoot = scope === 'all' ? cloneMindmapTree(rootNodeRef.current) : displayedRootRef.current;
      if (scope === 'all') for (const node of walkMindNodes(imageRoot)) node.isExpanded = true;
      const fontFamily =
        (rootElRef.current && window.getComputedStyle(rootElRef.current).fontFamily) ||
        FALLBACK_FONT_FAMILY;
      const blob = await exportMindmapImageBlob({
        root: imageRoot,
        layout,
        theme,
        edgeStyle: resolvedEdgeStyle,
        maxNodeWidth,
        defaultTextAlign,
        defaultImageFit,
        fontFamily,
        format,
      });
      const extension = format === 'jpeg' ? 'jpg' : 'png';
      const filters = [
        format === 'jpeg'
          ? { name: 'JPG 图片 (*.jpg)', extensions: ['jpg', 'jpeg'] }
          : { name: 'PNG 图片 (*.png)', extensions: ['png'] },
        { name: '全部文件 (*.*)', extensions: ['*'] },
      ];
      const saved = await exportBlobWithDialog(blob, `${exportBaseName}.${extension}`, filters);
      if (saved) {
        showToast(`成功导出为 ${extension.toUpperCase()} 图片`, 'success');
      }
    } catch (err) {
      console.error('导出图片失败:', err);
      showToast('导出图片失败', 'error');
    }
  };

  // 导入 .xmind 或 Markdown 大纲文件（替换当前导图，可撤销）
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // 重置 file input，允许重复导入同一文件
    const isXmind = /\.xmind$/i.test(file.name);
    const generation = getSessionGeneration(docKey);
    if (!isXmind && file.size > 20 * 1024 * 1024
      && !await confirmMindmapImport(['Markdown 正文超过 20 MB，继续解析可能耗时较长并占用较多内存'])) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const importedRoot = isXmind
          ? await (await import('./xmindImportFlow')).importXmindWithDialogs(reader.result as ArrayBuffer)
          : markdownToMindNode(String(reader.result ?? ''));
        if (!importedRoot) return;
        if (!isXmind) {
          const stats = getMindmapTreeStats(importedRoot);
          const risks: string[] = [];
          if (stats.nodeCount > 50_000) risks.push(`节点数为 ${stats.nodeCount}，超过 50,000 个，继续可能耗时较长`);
          if (stats.maxDepth > 500) risks.push(`层级深度为 ${stats.maxDepth}，超过 500 层，继续可能耗时较长`);
          if (!await confirmMindmapImport(risks)) return;
        }
        // 对话框期间关闭或重开同一路径时，旧导入结果不得回写新会话。
        if (!useDocumentStore.getState().hasDocument(docKey) || getSessionGeneration(docKey) !== generation) return;
        handleRootChange(importedRoot);
        setAutoCollapse(true);
        showToast(isXmind ? '成功导入 XMind 思维导图' : '成功导入 Markdown 大纲');
      } catch (err) {
        console.error('导入失败:', err);
        showToast(err instanceof Error ? err.message : '导入失败，文件格式可能不支持', 'error');
      }
    };
    reader.onerror = () => showToast('读取导入文件失败', 'error');
    if (isXmind) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  return (
    <div
      ref={rootElRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--editor-bg, #ffffff)',
        overflow: 'hidden',
      }}
    >
      {/* 顶部工具栏：模式切换 + 导入导出 + 缩放 */}
      <div
        className="nb-editor-topbar"
        style={{
          height: 40,
          minHeight: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 14px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          background: 'var(--editor-surface, #f8fafc)',
          userSelect: 'none',
          fontSize: 12,
        }}
      >
        {/* 左侧：导图 / 大纲双模切换胶囊 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--editor-bg, #ffffff)',
              borderRadius: 6,
              padding: 2,
              border: '1px solid var(--editor-border, #e2e8f0)',
              boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03)',
            }}
          >
            {/* 导图模式：以图形化思维导图查看与编辑 */}
            <Tooltip content="以思维导图形式查看与编辑" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-pill-btn"
                data-active={viewMode === 'mindmap'}
                onClick={() => handleSwitchViewMode('mindmap')}
              >
                <Network size={14} />
                <span>导图模式</span>
              </button>
            </Tooltip>
            {/* 大纲模式：以层级列表快速编辑 */}
            <Tooltip content="以层级大纲形式快速编辑" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-pill-btn"
                data-active={viewMode === 'outliner'}
                onClick={() => handleSwitchViewMode('outliner')}
              >
                <ListTree size={14} />
                <span>大纲模式</span>
              </button>
            </Tooltip>
          </div>
        </div>

        {/* 右侧：缩放控制与 XMind 导入导出 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {viewMode === 'mindmap' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 6 }}>
              <Tooltip content="缩小画布" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-editor-icon-btn"
                  onClick={() => setZoom((z) => Math.max(0.2, z - 0.15))}
                  aria-label="缩小画布"
                >
                  <ZoomOut size={13} />
                </button>
              </Tooltip>
              <span style={{ fontSize: 11, minWidth: 42, textAlign: 'center' }}>
                {Math.round(zoom * 100)}%
              </span>
              <Tooltip content="放大画布" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-editor-icon-btn"
                  onClick={() => setZoom((z) => Math.min(3, z + 0.15))}
                  aria-label="放大画布"
                >
                  <ZoomIn size={13} />
                </button>
              </Tooltip>
              <Tooltip content="复位 100%" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-editor-icon-btn"
                  onClick={() => setZoom(1)}
                  aria-label="复位 100%"
                >
                  <RotateCcw size={13} />
                </button>
              </Tooltip>
              {/* 重置全部节点宽度：恢复为设置中的默认宽度 */}
              <Tooltip
                content={hasCustomWidths ? '重置全部节点宽度' : '没有手动调整过宽度的节点'}
                side="bottom"
                sideOffset={4}
              >
                <button
                  type="button"
                  className="nb-editor-icon-btn"
                  onClick={handleResetAllWidths}
                  disabled={!hasCustomWidths}
                  aria-label="重置全部节点宽度"
                  style={{ opacity: hasCustomWidths ? 1 : 0.4, cursor: hasCustomWidths ? 'pointer' : 'default' }}
                >
                  <MoveHorizontal size={13} />
                </button>
              </Tooltip>
            </div>
          )}

          {/* 插入概要 / 外框 / 联系线（仅导图模式，作用于选中的节点） */}
          {viewMode === 'mindmap' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Tooltip content="为选中节点添加概要（Shift / Ctrl 多选同级节点可跨多个）" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-editor-toolbar-btn"
                  aria-disabled={!canAddRange}
                  style={{ opacity: canAddRange ? 1 : 0.5 }}
                  onClick={() => runInsert(canAddRange, '先选中一个或多个同级节点（中心主题除外）', () => rendererRef.current?.addSummary())}
                >
                  <Braces size={13} />
                  <span>概要</span>
                </button>
              </Tooltip>
              <Tooltip content="为选中节点添加外框（Shift / Ctrl 多选同级节点可跨多个）" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-editor-toolbar-btn"
                  aria-disabled={!canAddRange}
                  style={{ opacity: canAddRange ? 1 : 0.5 }}
                  onClick={() => runInsert(canAddRange, '先选中一个或多个同级节点（中心主题除外）', () => rendererRef.current?.addBoundary())}
                >
                  <SquareDashed size={13} />
                  <span>外框</span>
                </button>
              </Tooltip>
              <Tooltip content="从选中节点拉一条联系线，再点击目标节点" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-editor-toolbar-btn"
                  aria-disabled={!canConnect}
                  style={{ opacity: canConnect ? 1 : 0.5 }}
                  onClick={() => runInsert(canConnect, '先选中一个起点节点', () => rendererRef.current?.startConnect())}
                >
                  <Spline size={13} />
                  <span>联系线</span>
                </button>
              </Tooltip>
            </div>
          )}

          {/* 布局、连线样式与配色主题切换（仅导图模式） */}
          {viewMode === 'mindmap' && (
            <MindmapStyleControls
              layout={layout}
              themeId={themeId}
              edgeStyle={edgeStyle}
              onLayoutChange={(nextLayout) => handleStyleChange({ layout: nextLayout })}
              onThemeChange={(nextTheme) => handleStyleChange({ theme: nextTheme })}
              onEdgeStyleChange={(nextEdgeStyle) => handleStyleChange({ edgeStyle: nextEdgeStyle ?? null })}
            />
          )}

          {/* 导入：XMind 或 Markdown 大纲 */}
          <Tooltip content="导入 XMind 或 Markdown 文件" side="bottom" sideOffset={4}>
            <label className="nb-editor-toolbar-btn">
              <Upload size={13} />
              <span>导入</span>
              <input
                type="file"
                accept=".xmind,.md,.markdown"
                style={{ display: 'none' }}
                onChange={handleImportFile}
              />
            </label>
          </Tooltip>

          {/* 导出：XMind / Markdown / PNG / JPG */}
          <Dropdown
            open={exportOpen}
            onOpenChange={setExportOpen}
            menuStyle={{ minWidth: 180 }}
            trigger={
              <Tooltip content="导出为其他格式" side="bottom" sideOffset={4}>
                <span className="nb-editor-primary-btn" role="button" aria-haspopup="menu" aria-expanded={exportOpen}>
                  <Download size={13} />
                  <span>导出</span>
                  <ChevronDown size={12} style={{ opacity: 0.85 }} />
                </span>
              </Tooltip>
            }
          >
            <DropdownItem
              onClick={() => {
                setExportOpen(false);
                void handleExportXmind();
              }}
            >
              <Network size={14} />
              <span style={{ flex: 1 }}>XMind</span>
              <span style={{ fontSize: 11, opacity: 0.55 }}>.xmind</span>
            </DropdownItem>
            <DropdownItem
              onClick={() => {
                setExportOpen(false);
                void handleExportMarkdown();
              }}
            >
              <FileText size={14} />
              <span style={{ flex: 1 }}>Markdown</span>
              <span style={{ fontSize: 11, opacity: 0.55 }}>.md</span>
            </DropdownItem>
            <div style={{ height: 1, margin: '4px 6px', background: 'var(--editor-border, #e2e8f0)' }} />
            <DropdownItem
              onClick={() => {
                setExportOpen(false);
                void handleExportImage('png');
              }}
            >
              <ImageIcon size={14} />
              <span style={{ flex: 1 }}>PNG 图片</span>
              <span style={{ fontSize: 11, opacity: 0.55 }}>.png</span>
            </DropdownItem>
            <DropdownItem
              onClick={() => {
                setExportOpen(false);
                void handleExportImage('jpeg');
              }}
            >
              <ImageIcon size={14} />
              <span style={{ flex: 1 }}>JPG 图片</span>
              <span style={{ fontSize: 11, opacity: 0.55 }}>.jpg</span>
            </DropdownItem>
          </Dropdown>
        </div>
      </div>

      {/* 主视图区域 */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {viewMode === 'mindmap' ? (
          <MindmapRenderer
            ref={rendererRef}
            onSelectionChange={setSelection}
            root={displayedRoot}
            onChange={handleRootChange}
            zoom={zoom}
            onZoomChange={setZoom}
            layout={layout}
            theme={theme}
            edgeStyle={resolvedEdgeStyle}
            maxNodeWidth={maxNodeWidth}
            defaultTextAlign={defaultTextAlign}
            defaultImageFit={defaultImageFit}
            searchHighlight={searchHighlight}
          />
        ) : (
          <OutlinerEditor
            root={displayedRoot}
            onChange={handleRootChange}
            searchHighlight={searchHighlight}
          />
        )}

        {/* 导图模式左下角：撤销 / 重做 */}
        {viewMode === 'mindmap' && (
          <div className="nb-mindmap-history-bar">
            <Tooltip content="撤销" shortcut="Ctrl+Z" side="top" sideOffset={6}>
              <button
                type="button"
                className="nb-mindmap-history-btn"
                aria-label="撤销"
                disabled={!canUndo}
                onClick={() => undoDocumentHistory(docKey)}
              >
                <Undo2 size={15} />
              </button>
            </Tooltip>
            <Tooltip content="重做" shortcut="Ctrl+Y" side="top" sideOffset={6}>
              <button
                type="button"
                className="nb-mindmap-history-btn"
                aria-label="重做"
                disabled={!canRedo}
                onClick={() => redoDocumentHistory(docKey)}
              >
                <Redo2 size={15} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}
