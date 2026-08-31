// NoteBoard Draw.io 深度集成编辑器
// 基于 Diagrams.net Embed 协议 + postMessage 双向通信 + 主题联动与自动保存 + Ctrl+S 统一保存
// 详见 docs/09-开发路线图.md

import React, { useState, useEffect, useRef } from 'react';
import { Download, FileCode, RefreshCw, WifiOff } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { saveDocument } from '../editor-code/orchestration/saveDocument';
import { buildExportFileName, exportBlobWithDialog } from '../export/chartExport';

interface DrawioEditorProps {
  docKey: string;
}

const DEFAULT_DRAWIO_XML = `<mxfile host="NoteBoard" modified="${new Date().toISOString()}" agent="NoteBoard" version="0.1.3" etag="noteboard">
  <diagram id="diagram_1" name="第 1 页">
    <mxGraphModel dx="1000" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" background="none" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="开始绘图" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="340" y="240" width="120" height="60" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

export function DrawioEditor({ docKey }: DrawioEditorProps) {
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setDirty = useDocumentStore((s) => s.setDirty);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 初始化默认内容（若为空）
  useEffect(() => {
    if (!doc?.content?.trim()) {
      setContent(docKey, DEFAULT_DRAWIO_XML);
    }
  }, [docKey, doc?.content, setContent]);

  // 获取当前主题
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  // 构建 Diagrams.net 嵌入 URL（添加 saveAndExit=0&noSaveBtn=1&noExitBtn=1 隐藏内置保存与退出按钮）
  const embedUrl = `https://embed.diagrams.net/?embed=1&ui=min&spin=1&proto=json&libraries=1&saveAndExit=0&noSaveBtn=1&noExitBtn=1${isDark ? '&dark=1' : '&dark=0'}`;

  // 监听 Draw.io postMessage 事件
  useEffect(() => {
    let timeoutTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (!isLoaded) {
        setLoadError('加载 Diagrams.net 引擎耗时较长，请检查网络或点击重新加载');
      }
    }, 15000);

    const handleMessage = async (e: MessageEvent) => {
      // 过滤非目标 iframe 消息
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) {
        return;
      }

      try {
        const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!msg || typeof msg !== 'object') return;

        // 1. 处理配置请求 (若服务端发送 configure)
        if (msg.event === 'configure') {
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({
              action: 'configure',
              config: {},
            }),
            '*',
          );
        }

        // 2. Draw.io 初始化就绪事件
        if (msg.event === 'init') {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          setIsLoaded(true);
          setLoadError(null);
          const xml = doc?.content?.trim() ? doc.content : DEFAULT_DRAWIO_XML;
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({
              action: 'load',
              autosave: 1,
              xml,
            }),
            '*',
          );
        }

        // 3. 自动保存与手动保存事件
        if (msg.event === 'autosave' || msg.event === 'save') {
          if (msg.xml) {
            setContent(docKey, msg.xml);
            setDirty(docKey, true);
            setTabDirty(docKey, true);
          }
          if (msg.event === 'save') {
            await saveDocument(docKey);
            showToast('Draw.io 图表已保存');
          }
        }

        // 4. 导出事件
        if (msg.event === 'export') {
          if (msg.format === 'xml' && msg.data) {
            setContent(docKey, msg.data);
          } else if (msg.data && msg.format !== 'xml') {
            const format = msg.format === 'svg' ? 'svg' : 'png';
            let blob: Blob;
            if (typeof msg.data === 'string' && msg.data.startsWith('data:')) {
              const resp = await fetch(msg.data);
              blob = await resp.blob();
            } else if (typeof msg.data === 'string' && format === 'svg') {
              blob = new Blob([msg.data], { type: 'image/svg+xml;charset=utf-8' });
            } else {
              blob = new Blob([msg.data], { type: 'image/png' });
            }

            const baseName = buildExportFileName(doc?.displayName, 'drawio');
            const defaultFilename = `${baseName}.${format}`;
            const filters =
              format === 'svg'
                ? [
                    { name: 'SVG 矢量图 (*.svg)', extensions: ['svg'] },
                    { name: '全部文件 (*.*)', extensions: ['*'] },
                  ]
                : [
                    { name: 'PNG 图片 (*.png)', extensions: ['png'] },
                    { name: '全部文件 (*.*)', extensions: ['*'] },
                  ];

            // 唤起系统原生保存文件对话框
            const saved = await exportBlobWithDialog(blob, defaultFilename, filters);
            if (saved) {
              showToast(`绘图已成功导出为 ${format.toUpperCase()}`, 'success');
            }
          }
        }
      } catch (err) {
        console.error('解析 Draw.io 消息失败:', err);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      window.removeEventListener('message', handleMessage);
    };
  }, [docKey, doc?.content, doc?.displayName, setContent, setDirty, setTabDirty, isLoaded]);

  // 触发导出请求 (SVG 或 PNG)
  const handleRequestExport = (format: 'png' | 'svg') => {
    if (!iframeRef.current?.contentWindow) return;

    iframeRef.current.contentWindow.postMessage(
      JSON.stringify({
        action: 'export',
        format,
      }),
      '*',
    );
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--editor-bg, #ffffff)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* 顶部操作条 */}
      <div
        style={{
          height: 36,
          minHeight: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          background: 'var(--editor-surface, #f8fafc)',
          fontSize: 12,
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <FileCode size={15} color="var(--editor-accent, #3b82f6)" />
          <span>Draw.io 绘图编辑器</span>
          {!isLoaded && !loadError && (
            <span style={{ fontSize: 11, color: 'var(--editor-text-muted)', fontWeight: 400 }}>
              加载引擎中
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* 导出 SVG 按钮 */}
          <button
            type="button"
            onClick={() => handleRequestExport('svg')}
            title="导出为 SVG 矢量图"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid var(--editor-border, #e2e8f0)',
              background: 'var(--editor-bg, #ffffff)',
              color: 'var(--editor-text, #1e293b)',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            <Download size={12} />
            <span>导出 SVG</span>
          </button>
          {/* 导出 PNG 按钮 */}
          <button
            type="button"
            onClick={() => handleRequestExport('png')}
            title="导出为 PNG 图片"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid var(--editor-border, #e2e8f0)',
              background: 'var(--editor-bg, #ffffff)',
              color: 'var(--editor-text, #1e293b)',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            <Download size={12} />
            <span>导出 PNG</span>
          </button>
        </div>
      </div>

      {/* Draw.io iframe 嵌入容器 */}
      <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%' }}>
        <iframe
          ref={iframeRef}
          src={embedUrl}
          title="Draw.io Editor"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          onError={() => setLoadError('无法加载 Draw.io 绘图引擎，请检查网络连接')}
        />

        {/* 离线/异常提示 */}
        {loadError && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--editor-bg, #ffffff)',
              color: 'var(--editor-text, #1e293b)',
              padding: 24,
              gap: 12,
              zIndex: 10,
            }}
          >
            <WifiOff size={40} color="var(--editor-text-muted, #94a3b8)" />
            <span style={{ fontSize: 14, fontWeight: 500 }}>{loadError}</span>
            <button
              type="button"
              onClick={() => {
                setLoadError(null);
                setIsLoaded(false);
                if (iframeRef.current) {
                  iframeRef.current.src = embedUrl;
                }
              }}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                background: 'var(--editor-accent, #3b82f6)',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <RefreshCw size={14} />
              <span>重新连接</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
