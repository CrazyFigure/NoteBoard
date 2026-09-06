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
import { Tooltip } from '../../components/Tooltip';
// 🔴 S12：回收接入——能力注册表（flush 经导出回包确认）与内容版本
import {
  registerEditorCapabilities,
  getDocumentRevision,
  bumpDocumentRevision,
} from '../../core/editor/editorRegistry';
import { submitCapturedContent } from '../session/documentSession';
import type { EditorCapabilities, FlushReason } from '../../core/editor/editorTypes';
import { perfMarkEditorInstanceReady } from '../../core/perf/editorReadyMark';

interface DrawioEditorProps {
  docKey: string;
}

/** 🔴 S12：实例代际序号（同 docKey 重挂载递增；注册表删除保护） */
let nextDrawioInstanceId = 0;

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
  // 🔴 S12：能力对象（canSuspend/flush 回包判断）需要的同步镜像
  const isLoadedRef = useRef(false);
  const loadErrorRef = useRef<string | null>(null);
  /** 🔴 S12：flush 的导出请求在途句柄（同 iframe 串行——drawio 回包无原生请求 ID） */
  const pendingExportRef = useRef<{
    resolve: (xml: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;
  /** 🔴 N10.2：当前实例代际的镜像（init 事件处的就绪标记读取，不依赖渲染闭包） */
  const drawioInstanceIdRef = useRef<string>('drawio-0');

  /**
   * 🔴 S12：向 iframe 发起 xml 导出请求并等待回包（串行 + 3 秒超时）。
   * 收到对应 format==='xml' 的 export 回包即确认引擎当前权威 XML——
   * flush 据此确认"恢复能力"（挂载重新 load 该 XML 即完整恢复）；
   * 超时/引擎未就绪返回 null（调用方不回收/保留镜像）。
   */
  const requestExportXml = (): Promise<string | null> => {
    const win = iframeRef.current?.contentWindow ?? null;
    if (!isLoadedRef.current || !win) return Promise.resolve(null);
    // 串行：已在途的导出请求不重复发起（回包无请求 ID，无法区分）
    if (pendingExportRef.current) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingExportRef.current = null;
        resolve(null);
      }, 3000);
      pendingExportRef.current = {
        timer,
        resolve: (xml) => {
          clearTimeout(timer);
          pendingExportRef.current = null;
          resolve(xml);
        },
      };
      win.postMessage(JSON.stringify({ action: 'export', format: 'xml' }), '*');
    });
  };

  // 🔴 S12：注册能力对象（回收调度/保存/暂存统一走 core 注册表）
  useEffect(() => {
    const instanceId = `drawio-${(nextDrawioInstanceId += 1)}`;
    drawioInstanceIdRef.current = instanceId;
    const capabilities: EditorCapabilities = {
      docKey,
      instanceId,
      getRevision: () => getDocumentRevision(docKey),
      flush: async (reason: FlushReason) => {
        const key = docKeyRef.current;
        const current = useDocumentStore.getState().getDocument(key)?.content;
        // close：iframe 即将销毁，不再等待回包——直接以最近 autosave 镜像为权威
        if (reason === 'close') {
          if (current == null) return null;
          return { docKey: key, instanceId, revision: getDocumentRevision(key), content: current };
        }
        // 🔴 S12：导出回包确认（计划 I 节：收到对应导出请求的有效回包并确认恢复
        //    能力才允许回收；超时/未就绪返回 null 保留镜像、不回收）
        const xml = await requestExportXml();
        if (xml === null) {
          return current != null && current.trim()
            ? { docKey: key, instanceId, revision: getDocumentRevision(key), content: current }
            : null;
        }
        submitCapturedContent(key, { instanceId, revision: getDocumentRevision(key), content: xml });
        return { docKey: key, instanceId, revision: getDocumentRevision(key), content: xml };
      },
      focus: () => {
        // Drawio 无独立键盘焦点入口，焦点由 iframe 自身接管
      },
      getSelectedText: () => '',
      // 🔴 S12：引擎加载成功且无错误时可回收（内容经 autosave 同步 store +
      //    flush 导出回包双重确认；挂载时从 store XML 重新 load 完整恢复）
      canSuspend: () => isLoadedRef.current && !loadErrorRef.current,
    };
    return registerEditorCapabilities(capabilities);
  }, [docKey]);

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
        // 🔴 S12：能力对象同步镜像（canSuspend 立即感知错误态）
        loadErrorRef.current = '加载 Diagrams.net 引擎耗时较长，请检查网络或点击重新加载';
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
          // 🔴 S12：能力对象的同步镜像（canSuspend/flush 回包判断）
          isLoadedRef.current = true;
          loadErrorRef.current = null;
          // 🔴 N10.2：Drawio 实例就绪终点（引擎 init + 能力注册完成；requestId 与打开请求对齐）
          perfMarkEditorInstanceReady(docKey, drawioInstanceIdRef.current);
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
            // 🔴 S12：引擎推送的真实内容变化推进 revision（会话屏障校验用）
            bumpDocumentRevision(docKey);
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
            // 🔴 S12：flush 的 xml 导出回包（串行匹配——同 iframe 至多一个在途请求）
            const pending = pendingExportRef.current;
            if (pending) pending.resolve(msg.data);
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
      // 🔴 S12：卸载时终结在途导出请求（不再有回包）
      const pending = pendingExportRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        pendingExportRef.current = null;
        pending.resolve(null);
      }
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
          <Tooltip content="导出为 SVG 矢量图" side="bottom" sideOffset={4}>
            <button
              type="button"
              onClick={() => handleRequestExport('svg')}
              aria-label="导出为 SVG 矢量图"
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
          </Tooltip>
          {/* 导出 PNG 按钮 */}
          <Tooltip content="导出为 PNG 图片" side="bottom" sideOffset={4}>
            <button
              type="button"
              onClick={() => handleRequestExport('png')}
              aria-label="导出为 PNG 图片"
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
          </Tooltip>
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
          onError={() => {
            setLoadError('无法加载 Draw.io 绘图引擎，请检查网络连接');
            loadErrorRef.current = '无法加载 Draw.io 绘图引擎，请检查网络连接';
          }}
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
                // 🔴 S12：同步镜像（重连期间不可回收）
                loadErrorRef.current = null;
                isLoadedRef.current = false;
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
