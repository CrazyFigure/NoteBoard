// NoteBoard HTML 网页双栏编辑器（.html / .htm）
// 左侧源码编辑 + 右侧安全预览（沙箱 iframe，不执行脚本），顶部切换分屏 / 源码 / 预览
// 布局与交互对齐 Mermaid 图表编辑器；完整效果（含脚本）可一键交给系统浏览器打开

import { useState, useEffect, useRef, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import '../../styles/canvasEditors.css';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history } from '@codemirror/commands';
import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { Columns, Code2, Eye, Globe, ExternalLink, RotateCw, ShieldCheck } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
// 🔴 S12：回收能力注册与视图状态恢复（与图表双栏编辑器共用能力实现）
import { takeViewState } from '../session/editorSuspension';
import { registerEditorCapabilities } from '../../core/editor/editorRegistry';
import { createSplitEditorCapabilities } from '../diagram-preview/splitEditorCapabilities';
import { scheduleAutoSave } from '../session/documentSession';
import { saveDocument } from '../editor-code/orchestration/saveDocument';
import { Tooltip } from '../../components/Tooltip';
import { codeMirrorSearchSupport } from '../search/searchController';
import { tripleClickLineSelection } from '../editor-code/tripleClickLine';
import { createIndentationExtension } from '../editor-code/indentation';
import { loadLanguageExtension } from '../editor-code/languages';
import { nbSyntaxHighlighting } from '../editor-code/highlightStyle';
import { handleLinkClick, resolveRelativeDocPath } from '../editor-md/linkHandler';
import * as ipc from '../../core/ipc/commands';
import { IS_NATIVE_MOBILE, IS_WEB } from '../../core/platform';
import { ReadingModeOverlay } from '../reading/ReadingModeOverlay';
import { requestReadingMode, useIsReading } from '../reading/readingMode';
import { buildHtmlPreviewDocument, type HtmlPreviewEnv } from './htmlPreview';

interface HtmlSplitEditorProps {
  docKey: string;
}

type LayoutMode = 'split' | 'code' | 'preview';

/** 输入停顿多久后刷新预览（每次刷新都会重新加载 iframe） */
const PREVIEW_DEBOUNCE_MS = 300;

/** 编辑区窄于该宽度时分屏改为上下堆叠 */
const STACK_BELOW_WIDTH = 640;

/** 只有桌面端能把文件交给系统浏览器；网页端与移动端始终在应用内预览 */
const CAN_OPEN_IN_BROWSER = !IS_WEB && !IS_NATIVE_MOBILE;

/** 预览中需要转交应用处理的快捷键（iframe 获得焦点时按键不会冒泡到主窗口） */
function shouldForwardKey(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || event.key === 'Escape' || /^F\d{1,2}$/.test(event.key);
}

/** 读取本地文本文件；失败时静默返回 null（样式表缺失不影响预览其余部分） */
async function readTextFile(absPath: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await readFile(absPath));
  } catch {
    return null;
  }
}

/** 当前平台的预览构建能力 */
function createPreviewEnv(baseDir: string | null): HtmlPreviewEnv {
  return {
    baseDir,
    resolvePath: resolveRelativeDocPath,
    toResourceUrl: convertFileSrc,
    readText: readTextFile,
  };
}

export function HtmlSplitEditor({ docKey }: HtmlSplitEditorProps) {
  const doc = useDocumentStore((s) => s.documents.get(docKey));
  const setContent = useDocumentStore((s) => s.setContent);
  const setDirty = useDocumentStore((s) => s.setDirty);
  const setTabDirty = useWindowStore((s) => s.setTabDirty);
  const baseDir = doc?.dirPath || null;

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('split');
  // 沉浸阅读只显示预览，工具栏与源码栏隐藏（不改动用户选择的布局）
  const isReading = useIsReading(docKey);
  const paneMode: LayoutMode = isReading ? 'preview' : layoutMode;
  const previewVisible = paneMode !== 'code';
  // 极窄模式或编辑区宽度不足（手机、网页窄屏、桌面窄窗口）时左右分栏过窄，
  // 分屏改为上下堆叠（源码在上、预览在下）
  const compactMode = useLayoutStore((s) => s.compactMode);
  const [narrow, setNarrow] = useState(false);
  const stacked = compactMode || narrow;
  const exitReading = useCallback(() => requestReadingMode(false), []);
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // 监听编辑区宽度决定是否堆叠
  useEffect(() => {
    const el = splitContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      // 宽度为 0 表示标签处于隐藏状态，保持原布局
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setNarrow(width < STACK_BELOW_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const [source, setSource] = useState<string>(doc?.content ?? '');
  const [srcDoc, setSrcDoc] = useState<string>('');
  // 手动刷新计数：外部样式表或图片改动后重新读取
  const [refreshTick, setRefreshTick] = useState(0);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const languageCompartmentRef = useRef<Compartment>(new Compartment());
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 刷新前记录的预览滚动位置，新文档加载后恢复，避免每次输入都跳回顶部
  const previewScrollRef = useRef({ x: 0, y: 0 });
  const buildTokenRef = useRef(0);

  // 🔴 S12：布局状态 ref 镜像（回收捕获读取最新值）+ 能力注册 + 重挂载恢复
  const extraStateRef = useRef({ layoutMode: 'split' as LayoutMode, zoom: 1, pan: { x: 0, y: 0 } });
  useEffect(() => {
    extraStateRef.current = { layoutMode, zoom: 1, pan: { x: 0, y: 0 } };
  }, [layoutMode]);

  useEffect(() => {
    // 重挂载恢复回收前保存的布局模式（一次性消费）
    const restored = takeViewState(docKey) as { kind: 'split-diagram'; layoutMode: LayoutMode } | null;
    if (restored?.kind === 'split-diagram') setLayoutMode(restored.layoutMode);
    const dispose = registerEditorCapabilities(
      createSplitEditorCapabilities({
        docKey,
        instanceId: `html-${docKey}`,
        getEditorView: () => editorViewRef.current,
        captureExtra: () => extraStateRef.current,
        // 纯预览布局隐藏了源码区：搜索时切回双栏，命中项才能被看到
        revealSource: () => setLayoutMode((mode) => (mode === 'preview' ? 'split' : mode)),
      }),
    );
    return dispose;
  }, [docKey]);

  // 初始化 CodeMirror 6 源码编辑器（仅在切换文档时重建）
  useEffect(() => {
    if (!editorContainerRef.current) return;
    if (editorViewRef.current) editorViewRef.current.destroy();

    const initialContent = doc?.content ?? '';
    setSource(initialContent);
    const softWrap = useSettingsStore.getState().settings.editor.softWrap;

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        // 三击选行不带换行符，避免行号高亮跳到下一行
        tripleClickLineSelection,
        history(),
        // 与普通文本文档共用缩进宽度、制表符偏好和 Tab 按键规则
        createIndentationExtension(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Ctrl+F 搜索高亮与查询状态（界面由统一悬浮搜索栏提供）
        codeMirrorSearchSupport,
        softWrap ? EditorView.lineWrapping : [],
        nbSyntaxHighlighting,
        languageCompartmentRef.current.of([]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            const newText = update.state.doc.toString();
            setSource(newText);
            setContent(docKey, newText);
            setDirty(docKey, true);
            setTabDirty(docKey, true);
            // auto 策略下停止编辑 800ms 后自动写盘
            scheduleAutoSave(docKey);
          }
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: 'var(--mono-font-size, 13px)',
            fontFamily: 'var(--mono-font-family, monospace)',
            background: 'var(--cm-background, var(--editor-bg, #ffffff))',
            color: 'var(--cm-text, var(--editor-text, #1e293b))',
          },
          '.cm-content': {
            padding: '12px 0',
            caretColor: 'var(--cm-cursor, var(--editor-accent, #3b82f6))',
          },
          '.cm-gutters': {
            background: 'var(--cm-gutter-background, var(--editor-surface, #f8fafc))',
            color: 'var(--cm-gutter-text, var(--editor-text-muted, #94a3b8))',
            borderRight: '1px solid var(--editor-border, #e2e8f0)',
          },
          '&.cm-focused': {
            outline: 'none',
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorContainerRef.current });
    editorViewRef.current = view;

    // HTML 语法包（含内嵌 CSS / JS）为动态包，加载完成后再注入，避免阻塞首屏
    void loadLanguageExtension('html').then((ext) => {
      if (editorViewRef.current !== view) return;
      view.dispatch({ effects: languageCompartmentRef.current.reconfigure(ext) });
    });

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
    // 编辑器内容由自身驱动写回 store，此处仅依赖 docKey，避免输入时被外部重建导致失焦
  }, [docKey]);

  // 外部重载（replaceContent）同样经 updateListener 更新 source，预览随之刷新

  // 切换布局或分栏比例后通知 CodeMirror 重新测量尺寸
  useEffect(() => {
    if (paneMode !== 'preview' && editorViewRef.current) editorViewRef.current.requestMeasure();
  }, [paneMode, splitRatio, stacked]);

  // 源码变化后防抖重建预览；纯源码布局下预览不可见，不做无用的构建
  useEffect(() => {
    if (!previewVisible) return;
    const token = ++buildTokenRef.current;
    const timer = window.setTimeout(() => {
      void buildHtmlPreviewDocument(source, createPreviewEnv(baseDir)).then(
        (html) => {
          if (token !== buildTokenRef.current) return;
          // 记录旧文档滚动位置，onLoad 时恢复
          const win = iframeRef.current?.contentWindow;
          if (win) previewScrollRef.current = { x: win.scrollX, y: win.scrollY };
          setSrcDoc(html);
        },
        (error: unknown) => {
          console.error('构建 HTML 预览失败:', error);
        },
      );
    }, srcDoc ? PREVIEW_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // srcDoc 仅用于判断是否首次构建（首次不防抖），不作为重建触发条件
  }, [source, baseDir, previewVisible, refreshTick]);

  // 预览文档加载完成：恢复滚动、接管链接点击并转发快捷键
  const handlePreviewLoad = useCallback(() => {
    const frame = iframeRef.current;
    const frameDoc = frame?.contentDocument;
    const frameWin = frame?.contentWindow;
    if (!frameDoc || !frameWin) return;
    const { x, y } = previewScrollRef.current;
    if (x || y) frameWin.scrollTo(x, y);

    // 链接一律拦截：锚点在预览内滚动，其余按笔记链接规则处理（外链交给系统浏览器，本地文件在应用内打开）
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target && typeof target.closest === 'function' ? target.closest('a') : null;
      if (!anchor) return;
      event.preventDefault();
      if (event.type === 'auxclick' && event.button !== 1) return;
      const href = (anchor.getAttribute('href') ?? '').trim();
      if (!href) return;
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const el = id ? frameDoc.getElementById(id) ?? frameDoc.getElementsByName(id)[0] : null;
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (!id) frameWin.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      void handleLinkClick(href, docKey);
    };
    frameDoc.addEventListener('click', onClick);
    frameDoc.addEventListener('auxclick', onClick);

    // 焦点在预览里时 Ctrl+S、Ctrl+F、Esc 等快捷键转交主窗口处理
    frameDoc.addEventListener('keydown', (event) => {
      if (!shouldForwardKey(event)) return;
      const forwarded = new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      });
      if (!window.dispatchEvent(forwarded)) event.preventDefault();
    });
  }, [docKey]);

  // 分隔条拖拽调整比例：指针事件统一鼠标与触屏，指针捕获保证划过 iframe 时仍能收到移动事件
  const handleResizerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
  };
  const handleResizerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isResizing || !splitContainerRef.current) return;
    const rect = splitContainerRef.current.getBoundingClientRect();
    const ratio = stacked ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width;
    setSplitRatio(Math.max(0.18, Math.min(0.82, ratio)));
  };
  const handleResizerPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setIsResizing(false);
  };

  // 交给系统默认浏览器打开：有未保存修改时先保存，浏览器才能看到最新内容
  const openInBrowser = useCallback(async () => {
    const current = useDocumentStore.getState().getDocument(docKey);
    if (!current?.dirPath) {
      showToast('请先保存文件，再用浏览器打开', 'warning');
      return;
    }
    if (current.isDirty && !(await saveDocument(docKey))) return;
    try {
      await ipc.openWithDefaultApp(docKey);
    } catch (error: unknown) {
      console.error('用浏览器打开失败:', error);
      showToast(typeof error === 'string' ? error : error instanceof Error ? error.message : '打开失败', 'error');
    }
  }, [docKey]);

  // 布局切换按钮
  const layoutButton = (mode: LayoutMode, icon: ReactNode, label: string, tip: string) => (
    <Tooltip content={tip} side="bottom" sideOffset={4}>
      <button
        type="button"
        className="nb-editor-pill-btn"
        data-active={layoutMode === mode}
        onClick={() => setLayoutMode(mode)}
        aria-label={tip}
        style={{ padding: '3px 8px', fontSize: 11 }}
      >
        {icon}
        <span>{label}</span>
      </button>
    </Tooltip>
  );

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
      {/* 顶部工具栏 */}
      <div
        className="nb-editor-topbar"
        style={{
          height: 38,
          minHeight: 38,
          display: isReading ? 'none' : 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--editor-border, #e2e8f0)',
          background: 'var(--editor-surface, #f8fafc)',
          userSelect: 'none',
          fontSize: 12,
          color: 'var(--editor-text, #1e293b)',
        }}
      >
        {/* 左侧：格式标识与布局切换 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="nb-editor-topbar-title" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Globe size={16} color="var(--editor-accent, #3b82f6)" />
            <span>HTML 网页</span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--editor-bg, #ffffff)',
              borderRadius: 6,
              padding: 2,
              border: '1px solid var(--editor-border, #e2e8f0)',
            }}
          >
            {layoutButton('split', <Columns size={13} />, '分屏', '双栏分屏')}
            {layoutButton('code', <Code2 size={13} />, '源码', '仅源码')}
            {layoutButton('preview', <Eye size={13} />, '预览', '仅预览')}
          </div>
        </div>

        {/* 右侧：安全说明、刷新与浏览器打开 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {previewVisible && (
            <>
              <Tooltip content="安全预览：不运行脚本，不加载网络样式" side="bottom" sideOffset={4}>
                <span
                  aria-label="安全预览：不运行脚本，不加载网络样式"
                  style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 6px', color: 'var(--editor-text-muted, #94a3b8)' }}
                >
                  <ShieldCheck size={14} />
                </span>
              </Tooltip>
              <Tooltip content="刷新预览" side="bottom" sideOffset={4}>
                <button
                  type="button"
                  className="nb-editor-icon-btn"
                  onClick={() => setRefreshTick((n) => n + 1)}
                  aria-label="刷新预览"
                  style={{ padding: '2px 6px' }}
                >
                  <RotateCw size={13} />
                </button>
              </Tooltip>
            </>
          )}
          {CAN_OPEN_IN_BROWSER && (
            <Tooltip content="用系统浏览器打开（完整运行脚本）" side="bottom" sideOffset={4}>
              <button
                type="button"
                className="nb-editor-pill-btn"
                onClick={() => void openInBrowser()}
                aria-label="用系统浏览器打开"
                style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--editor-border, #e2e8f0)' }}
              >
                <ExternalLink size={13} />
                <span>浏览器打开</span>
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* 主编辑与预览区域 */}
      <div
        ref={splitContainerRef}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: stacked ? 'column' : 'row',
          overflow: 'hidden',
          position: 'relative',
          userSelect: isResizing ? 'none' : 'auto',
        }}
      >
        {/* 沉浸阅读：退出按钮 */}
        {isReading && <ReadingModeOverlay onExit={exitReading} />}
        {/* 源码编辑区（常驻 DOM，切换模式不销毁） */}
        <div
          ref={editorContainerRef}
          style={{
            display: paneMode === 'preview' ? 'none' : 'block',
            width: paneMode === 'split' && !stacked ? `calc(${splitRatio * 100}% - 4px)` : '100%',
            height: paneMode === 'split' && stacked ? `calc(${splitRatio * 100}% - 4px)` : '100%',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        />

        {/* 分栏可拖拽分隔条 */}
        {paneMode === 'split' && (
          <Tooltip content="拖拽调节分栏比例，双击复位" side="top" sideOffset={6}>
            <div
              className="nb-html-split-sash"
              data-resizing={isResizing}
              data-stacked={stacked}
              onPointerDown={handleResizerPointerDown}
              onPointerMove={handleResizerPointerMove}
              onPointerUp={handleResizerPointerUp}
              onPointerCancel={handleResizerPointerUp}
              onDoubleClick={() => setSplitRatio(0.5)}
              aria-label="拖拽调节分栏比例，双击复位"
              style={{
                width: stacked ? '100%' : 8,
                height: stacked ? 8 : '100%',
                cursor: stacked ? 'row-resize' : 'col-resize',
                position: 'relative',
                flexShrink: 0,
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                touchAction: 'none',
              }}
            >
              <div
                style={{
                  width: stacked ? '100%' : 1,
                  height: stacked ? 1 : '100%',
                  background: 'var(--editor-border, #e2e8f0)',
                }}
              />
            </div>
          </Tooltip>
        )}

        {/* 网页预览区（常驻 DOM）：沙箱不含 allow-scripts，页面脚本、表单与弹窗均不生效；
            allow-same-origin 仅用于宿主读取滚动位置与拦截链接点击 */}
        <div
          style={{
            display: paneMode === 'code' ? 'none' : 'flex',
            width: paneMode === 'split' && !stacked ? `calc(${(1 - splitRatio) * 100}% - 4px)` : '100%',
            height: paneMode === 'split' && stacked ? `calc(${(1 - splitRatio) * 100}% - 4px)` : '100%',
            overflow: 'hidden',
            position: 'relative',
            flexShrink: 0,
            // 网页默认按白底设计，预览与浏览器保持一致，不跟随应用深色主题
            background: '#ffffff',
          }}
        >
          <iframe
            ref={iframeRef}
            title="HTML 预览"
            sandbox="allow-same-origin"
            srcDoc={srcDoc}
            onLoad={handlePreviewLoad}
            style={{
              flex: 1,
              width: '100%',
              height: '100%',
              border: 'none',
              background: '#ffffff',
              colorScheme: 'light',
              // 拖动分隔条期间屏蔽 iframe 的指针事件，避免拖拽中途丢失
              pointerEvents: isResizing ? 'none' : 'auto',
            }}
          />
          {!source.trim() && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94a3b8',
                fontSize: 13,
                pointerEvents: 'none',
              }}
            >
              输入 HTML 即可实时预览
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
