// NoteBoard 思维导图主编辑器 (Mindmap Editor)
// 幕布式双模切换 (大纲编辑模式 ⇄ 思维导图展示模式) + XMind 导入导出 + 文件级统一撤销/重做
// 详见 docs/09-开发路线图.md

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ListTree,
  Network,
  Download,
  Upload,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  FileText,
} from 'lucide-react';
import type { MindNode, MindmapLayout } from './mindmapTypes';
import {
  parseMindmapDocument,
  parseMindmapDocumentMeta,
  serializeMindmapDocument,
  exportToXmindZip,
  importFromXmindZip,
  mindNodeToMarkdown,
  DEFAULT_MINDMAP_LAYOUT,
  DEFAULT_MINDMAP_THEME,
} from './mindmapConverter';
import { getMindmapTheme } from './mindmapTheme';
import { MindmapStyleControls } from './MindmapStyleControls';
import { OutlinerEditor } from './OutlinerEditor';
import { MindmapRenderer } from './MindmapRenderer';
import { Tooltip } from '../../components/Tooltip';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { exportBlobWithDialog } from '../export/chartExport';
import {
  initializeDocumentHistory,
  registerDocumentHistoryAdapter,
  recordDocumentChange,
  undoDocumentHistory,
  redoDocumentHistory,
  markDocumentHistoryModeBoundary,
} from '../history/documentHistory';
// 🔴 S12：回收接入——能力注册表（flush/canSuspend/视图捕获）与挂载恢复
import {
  registerEditorCapabilities,
  getDocumentRevision,
  bumpDocumentRevision,
} from '../../core/editor/editorRegistry';
import { submitCapturedContent } from '../session/documentSession';
import { takeViewState } from '../session/editorSuspension';
import { perfMarkEditorInstanceReady } from '../../core/perf/editorReadyMark';
import type { EditorCapabilities } from '../../core/editor/editorTypes';

interface MindmapEditorProps {
  docKey: string;
}

type ViewMode = 'outliner' | 'mindmap';

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
  // 文档级外观：布局 + 配色主题（持久化在文档 JSON 元信息中）
  const [layout, setLayout] = useState<MindmapLayout>(
    () => parseMindmapDocumentMeta(doc?.content ?? '').layout ?? DEFAULT_MINDMAP_LAYOUT,
  );
  const [themeId, setThemeId] = useState<string>(
    () => parseMindmapDocumentMeta(doc?.content ?? '').theme ?? DEFAULT_MINDMAP_THEME,
  );
  const theme = getMindmapTheme(themeId);
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

  // 注册统一文档历史快照应用器
  useEffect(() => {
    const initialContent = doc?.content ?? '';
    initializeDocumentHistory(docKey, initialContent, 'mindmap');

    const unregister = registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry) => {
        const parsed = parseMindmapDocument(entry.content);
        setRootNode(parsed);
        // 布局与配色随内容一起回滚，避免外观状态与文档不一致
        const meta = parseMindmapDocumentMeta(entry.content);
        setLayout(meta.layout);
        setThemeId(meta.theme);
        setContent(docKey, entry.content);
        setDirty(docKey, true);
        setTabDirty(docKey, true);
      },
    });

    // 🔴 S12：重挂载（回收后）恢复查看模式与缩放（一次性消费）
    const restored = takeViewState(docKey) as
      | { kind: 'mindmap'; viewMode: ViewMode; zoom: number }
      | null;
    if (restored?.kind === 'mindmap') {
      setViewMode(restored.viewMode);
      setZoom(restored.zoom);
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
      }),
    };
    // 🔴 N10.2：思维导图实例就绪终点（能力注册完成；requestId 与打开请求对齐）
    perfMarkEditorInstanceReady(docKey, instanceId);
    return registerEditorCapabilities(capabilities);
  }, [docKey]);

  // 当外部文档切换或重新加载时同步状态（含布局与配色元信息）
  useEffect(() => {
    if (doc?.content != null) {
      const parsed = parseMindmapDocument(doc.content);
      setRootNode(parsed);
      const meta = parseMindmapDocumentMeta(doc.content);
      setLayout(meta.layout);
      setThemeId(meta.theme);
    }
  }, [docKey]);

  // 统一的文档落盘：序列化节点树 + 外观元信息，同步 store / 脏标记 / 历史
  const persistDocument = useCallback(
    (newRoot: MindNode, nextLayout: MindmapLayout, nextTheme: string) => {
      // 🔴 S12：真实修改推进内容版本（会话屏障校验用）
      bumpDocumentRevision(docKey);
      const serialized = serializeMindmapDocument(newRoot, {
        layout: nextLayout,
        theme: nextTheme,
      });
      setContent(docKey, serialized);
      setDirty(docKey, true);
      setTabDirty(docKey, true);
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
      setRootNode(newRoot);
      persistDocument(newRoot, layoutRef.current, themeIdRef.current);
    },
    [persistDocument],
  );

  // 切换布局 / 配色主题并即时持久化
  const handleStyleChange = useCallback(
    (next: { layout?: MindmapLayout; theme?: string }) => {
      const nextLayout = next.layout ?? layoutRef.current;
      const nextTheme = next.theme ?? themeIdRef.current;
      setLayout(nextLayout);
      setThemeId(nextTheme);
      persistDocument(rootNodeRef.current, nextLayout, nextTheme);
    },
    [persistDocument],
  );

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
      const baseName = rootNode.text?.trim() || '思维导图';
      const defaultFilename = `${baseName}.xmind`;
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
      const baseName = rootNode.text?.trim() || '大纲';
      const defaultFilename = `${baseName}.md`;
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

  // 导入 .xmind 文件
  const handleImportXmind = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const buffer = reader.result as ArrayBuffer;
        const importedRoot = await importFromXmindZip(buffer);
        handleRootChange(importedRoot);
        showToast('成功导入 XMind 思维导图');
      } catch (err) {
        console.error('导入 XMind 失败:', err);
        showToast('导入 XMind 失败，文件格式可能不支持');
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = ''; // 重置 file input
  };

  return (
    <div
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
        {/* 左侧：幕布式双模切换胶囊 */}
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
            <Tooltip content="思维导图展示模式" side="bottom" sideOffset={4}>
              <button
                type="button"
                onClick={() => handleSwitchViewMode('mindmap')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: viewMode === 'mindmap' ? 600 : 400,
                  background: viewMode === 'mindmap' ? 'var(--toolbar-active, rgba(59, 130, 246, 0.12))' : 'transparent',
                  color: viewMode === 'mindmap' ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-muted, #64748b)',
                  transition: 'all 0.15s ease',
                }}
              >
                <Network size={14} />
                <span>思维导图</span>
              </button>
            </Tooltip>
            <Tooltip content="幕布式大纲编辑模式" side="bottom" sideOffset={4}>
              <button
                type="button"
                onClick={() => handleSwitchViewMode('outliner')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 10px',
                  borderRadius: 4,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: viewMode === 'outliner' ? 600 : 400,
                  background: viewMode === 'outliner' ? 'var(--toolbar-active, rgba(59, 130, 246, 0.12))' : 'transparent',
                  color: viewMode === 'outliner' ? 'var(--editor-accent, #3b82f6)' : 'var(--editor-text-muted, #64748b)',
                  transition: 'all 0.15s ease',
                }}
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
                  onClick={() => setZoom((z) => Math.max(0.2, z - 0.15))}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--editor-border)',
                    borderRadius: 4,
                    padding: '3px 6px',
                    cursor: 'pointer',
                  }}
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
                  onClick={() => setZoom((z) => Math.min(3, z + 0.15))}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--editor-border)',
                    borderRadius: 4,
                    padding: '3px 6px',
                    cursor: 'pointer',
                  }}
                >
                  <ZoomIn size={13} />
                </button>
              </Tooltip>
              <Tooltip content="复位 100%" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  onClick={() => setZoom(1)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--editor-border)',
                    borderRadius: 4,
                    padding: '3px 6px',
                    cursor: 'pointer',
                  }}
                >
                  <RotateCcw size={13} />
                </button>
              </Tooltip>
            </div>
          )}

          {/* 布局与配色主题切换（仅导图模式） */}
          {viewMode === 'mindmap' && (
            <MindmapStyleControls
              layout={layout}
              themeId={themeId}
              onLayoutChange={(nextLayout) => handleStyleChange({ layout: nextLayout })}
              onThemeChange={(nextTheme) => handleStyleChange({ theme: nextTheme })}
            />
          )}

          {/* 导入 XMind 隐藏 input */}
          <Tooltip content="导入 .xmind 文件" side="bottom" sideOffset={4}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px',
                borderRadius: 5,
                border: '1px solid var(--editor-border, #e2e8f0)',
                background: 'var(--editor-bg, #ffffff)',
                color: 'var(--editor-text, #1e293b)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <Upload size={13} />
              <span>导入 XMind</span>
              <input
                type="file"
                accept=".xmind"
                style={{ display: 'none' }}
                onChange={handleImportXmind}
              />
            </label>
          </Tooltip>

          {/* 导出 Markdown */}
          <Tooltip content="导出为 Markdown 大纲文本" side="bottom" sideOffset={4}>
            <button
              type="button"
              onClick={handleExportMarkdown}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px',
                borderRadius: 5,
                border: '1px solid var(--editor-border, #e2e8f0)',
                background: 'var(--editor-bg, #ffffff)',
                color: 'var(--editor-text, #1e293b)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <FileText size={13} />
              <span>导出 Markdown</span>
            </button>
          </Tooltip>

          {/* 导出 XMind */}
          <Tooltip content="导出为 .xmind 文件" side="bottom" sideOffset={4}>
            <button
              type="button"
              onClick={handleExportXmind}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 10px',
                borderRadius: 5,
                border: 'none',
                background: 'var(--editor-accent, #3b82f6)',
                color: '#ffffff',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <Download size={13} />
              <span>导出 XMind</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* 主视图区域 */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {viewMode === 'mindmap' ? (
          <MindmapRenderer
            root={rootNode}
            onChange={handleRootChange}
            zoom={zoom}
            onZoomChange={setZoom}
            layout={layout}
            theme={theme}
          />
        ) : (
          <OutlinerEditor
            root={rootNode}
            onChange={handleRootChange}
          />
        )}
      </div>
    </div>
  );
}
