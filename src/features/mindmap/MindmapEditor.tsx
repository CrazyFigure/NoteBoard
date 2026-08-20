// NoteBoard 思维导图主编辑器 (Mindmap Editor)
// 幕布式双模切换 (大纲编辑模式 ⇄ 思维导图展示模式) + XMind 导入导出 + 文件级统一撤销/重做
// 详见 docs/09-开发路线图.md

import React, { useState, useEffect, useCallback } from 'react';
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
import type { MindNode } from './mindmapTypes';
import {
  parseMindmapDocument,
  serializeMindmapDocument,
  exportToXmindZip,
  importFromXmindZip,
  mindNodeToMarkdown,
} from './mindmapConverter';
import { OutlinerEditor } from './OutlinerEditor';
import { MindmapRenderer } from './MindmapRenderer';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import {
  initializeDocumentHistory,
  registerDocumentHistoryAdapter,
  recordDocumentChange,
  undoDocumentHistory,
  redoDocumentHistory,
  markDocumentHistoryModeBoundary,
} from '../history/documentHistory';

interface MindmapEditorProps {
  docKey: string;
}

type ViewMode = 'outliner' | 'mindmap';

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

  // 注册统一文档历史快照应用器
  useEffect(() => {
    const initialContent = doc?.content ?? '';
    initializeDocumentHistory(docKey, initialContent, 'mindmap');

    const unregister = registerDocumentHistoryAdapter(docKey, {
      applyEntry: (entry) => {
        const parsed = parseMindmapDocument(entry.content);
        setRootNode(parsed);
        setContent(docKey, entry.content);
        setDirty(docKey, true);
        setTabDirty(docKey, true);
      },
    });

    return unregister;
  }, [docKey]);

  // 当外部文档切换或重新加载时同步状态
  useEffect(() => {
    if (doc?.content != null) {
      const parsed = parseMindmapDocument(doc.content);
      setRootNode(parsed);
    }
  }, [docKey]);

  // 节点树更新时同步到 DocumentStore、脏标记并记录文件级历史
  const handleRootChange = useCallback(
    (newRoot: MindNode) => {
      setRootNode(newRoot);
      const serialized = serializeMindmapDocument(newRoot);
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

  // 导出为 .xmind 文件
  const handleExportXmind = async () => {
    try {
      const blob = await exportToXmindZip(rootNode);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${rootNode.text || '思维导图'}.xmind`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('成功导出为 XMind 文件');
    } catch (err) {
      console.error('导出 XMind 失败:', err);
      showToast('导出 XMind 失败');
    }
  };

  // 导出为 Markdown 大纲
  const handleExportMarkdown = () => {
    const md = mindNodeToMarkdown(rootNode);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rootNode.text || '大纲'}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('成功导出为 Markdown 大纲');
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
            <button
              type="button"
              onClick={() => handleSwitchViewMode('mindmap')}
              title="思维导图展示模式"
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
            <button
              type="button"
              onClick={() => handleSwitchViewMode('outliner')}
              title="幕布式大纲编辑模式"
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
          </div>
        </div>

        {/* 右侧：缩放控制与 XMind 导入导出 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {viewMode === 'mindmap' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 6 }}>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.2, z - 0.15))}
                title="缩小画布"
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
              <span style={{ fontSize: 11, minWidth: 42, textAlign: 'center' }}>
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3, z + 0.15))}
                title="放大画布"
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
              <button
                type="button"
                onClick={() => setZoom(1)}
                title="复位 100%"
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
            </div>
          )}

          {/* 导入 XMind 隐藏 input */}
          <label
            title="导入 .xmind 文件"
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

          {/* 导出 Markdown */}
          <button
            type="button"
            onClick={handleExportMarkdown}
            title="导出为 Markdown 大纲文本"
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

          {/* 导出 XMind */}
          <button
            type="button"
            onClick={handleExportXmind}
            title="导出为 .xmind 文件"
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
