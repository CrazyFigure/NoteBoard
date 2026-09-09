// NoteBoard 文本对比视图
// 左右两个 CodeMirror 编辑器（复用 txt 编辑器观感）+ @codemirror/merge 实时差异高亮
// 中缝双箭头按钮逐处采用（◀ 左侧采用右侧 / ▶ 右侧采用左侧），中缝可左右拖拽调整分栏（双击复位）
// 纯前端工具视图：不落盘、不进 documentStore、不参与暂存/会话恢复（tab 关闭即释放）

import React, { useState, useEffect, useRef } from 'react';
import {
  MergeView,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
} from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { Compartment, type Extension } from '@codemirror/state';
import { open } from '@tauri-apps/plugin-dialog';
import {
  FolderOpen,
  ArrowLeftRight,
  ChevronUp,
  ChevronDown,
  Copy,
  FoldVertical,
  Trash2,
  WrapText,
} from 'lucide-react';
import { createBaseExtensions } from '../editor-code/setup';
import { nbMergeDiffTheme } from './mergeTheme';
import * as ipc from '../../core/ipc/commands';
import { useSettingsStore } from '../../stores/settingsStore';
import { showToast } from '../../stores/toastStore';
import { Tooltip } from '../../components/Tooltip';

/** 文本对比可打开的文件类型（文本类优先） */
const TEXT_DIFF_FILE_FILTERS = [
  { name: '全部文件', extensions: ['*'] },
  {
    name: '常见文本格式',
    extensions: [
      'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'sql', 'log', 'ini',
      'conf', 'cfg', 'env', 'csv', 'mmd', 'mermaid', 'puml', 'js', 'ts', 'tsx',
      'jsx', 'css', 'html', 'py', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'bat', 'ps1',
    ],
  },
];

/** 超大文本提示阈值（字符数） */
const LARGE_TEXT_WARNING_CHARS = 2 * 1024 * 1024;

/** 折叠相同行参数：差异上下保留 3 行上下文，至少 6 行连续相同才折叠（默认关闭，工具栏可开） */
const COLLAPSE_UNCHANGED = { margin: 3, minSize: 6 };

/** 中缝列宽度（px，与 CSS 中 .nb-diff-chunkbar 的 width 保持一致） */
const CHUNK_BAR_WIDTH = 38;

/** 工具栏与中缝按钮层样式（nb-diff-* 类名均为本组件私有） */
const TEXT_DIFF_CSS = `
.nb-diff-root { display: flex; flex-direction: column; height: 100%; background: var(--editor-bg); }
.nb-diff-toolbar {
  display: flex; align-items: center; gap: 4px; padding: 4px 8px;
  border-bottom: 1px solid var(--editor-border); flex-shrink: 0;
}
.nb-diff-tbtn {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
  border-radius: 4px; border: none; background: transparent;
  color: var(--editor-text-muted, #64748b); font-size: 11px; cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.nb-diff-tbtn:hover { background: var(--toolbar-hover, rgba(59, 130, 246, 0.12)); color: var(--editor-text, #1e293b); }
.nb-diff-tbtn:active { background: var(--toolbar-active, rgba(59, 130, 246, 0.2)); }
/* 主操作（打开文件）用强调色，避免被误认为不可点击 */
.nb-diff-tbtn-accent, .nb-diff-tbtn-accent:hover {
  color: var(--editor-accent, #3b82f6); font-weight: 600;
}
.nb-diff-tbtn-on {
  background: var(--toolbar-active, rgba(59, 130, 246, 0.12));
  color: var(--editor-accent, #3b82f6); font-weight: 600;
}
.nb-diff-tbtn-on:hover { color: var(--editor-accent, #3b82f6); }
.nb-diff-name {
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: var(--editor-text, #1e293b);
}
.nb-diff-count { font-size: 11px; color: var(--editor-text-muted, #64748b); padding: 0 4px; white-space: nowrap; }
.nb-diff-spacer { flex: 1 1 0; }
.nb-diff-host { flex: 1 1 0; min-height: 0; }
/* merge 视图外层滚动（merge 默认不设高度，需宿主显式给高） */
.nb-diff-host > .cm-mergeView { height: 100%; overflow-y: auto; }
/* 编辑区撑满整栏：使整个区域如同普通文本编辑器，行号槽与文本区垂直铺满全高，下方空白可直接点击定位 */
.nb-diff-host .cm-mergeViewEditors { min-height: 100%; display: flex; align-items: stretch; }
.nb-diff-host .cm-mergeViewEditor { display: flex; flex-direction: column; flex: 1 1 0; min-height: 100%; }
.nb-diff-host .cm-mergeViewEditor > .cm-editor {
  flex: 1 1 auto; display: flex !important; flex-direction: column;
  min-height: 100% !important; height: auto !important; cursor: text;
}
.nb-diff-host .cm-mergeViewEditor .cm-scroller {
  flex: 1 1 auto; display: flex !important;
  min-height: 100% !important; height: auto !important; cursor: text;
}
.nb-diff-host .cm-mergeViewEditor .cm-gutters {
  min-height: 100% !important; align-self: stretch !important;
}
.nb-diff-host .cm-mergeViewEditor .cm-content {
  min-height: 100% !important; cursor: text;
}
/* 左侧编辑器宽度由变量控制（中缝拖拽调整 inline 覆盖；默认左右平分去掉中缝宽） */
.nb-diff-host { --nb-diff-left: calc((100% - ${CHUNK_BAR_WIDTH}px) / 2); }
.nb-diff-host .cm-mergeViewEditor:first-child { flex: 0 0 var(--nb-diff-left); }
/* 中缝列：可拖拽调整分栏（col-resize），内嵌采用按钮 */
.nb-diff-chunkbar {
  position: relative; flex: 0 0 auto; width: ${CHUNK_BAR_WIDTH}px; z-index: 6;
  cursor: col-resize; transition: background 0.15s ease;
}
.nb-diff-chunkbar:hover { background: var(--toolbar-hover, rgba(59, 130, 246, 0.10)); }
.nb-diff-chunkbar.nb-diff-resizing {
  background: var(--toolbar-active, rgba(59, 130, 246, 0.18));
}
/* 中缝细中线（视觉分界，不响应指针） */
.nb-diff-chunkbar::after {
  content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px;
  background: var(--editor-border, #e2e8f0); transform: translateX(-0.5px);
  pointer-events: none;
}
.nb-diff-chunkbtns {
  position: absolute; display: flex; gap: 2px; left: 50%; transform: translateX(-50%);
}
.nb-diff-chunkbtns button {
  width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--editor-border, #e2e8f0); border-radius: 4px;
  background: var(--editor-surface, #fff); color: var(--editor-text-muted, #64748b);
  font-size: 9px; line-height: 1; cursor: pointer; padding: 0;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.nb-diff-chunkbtns button:hover {
  background: var(--editor-accent, #3b82f6); border-color: var(--editor-accent, #3b82f6); color: #fff;
}
.nb-diff-chunkbtns button:active { transform: scale(0.92); }
`;

/** 全量替换编辑器文本（打开文件/交换两侧时使用） */
function replaceDoc(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

// props.docKey 由 EditorHost 统一传入（编辑器签名约定）；文本对比不落盘，不消费该值
export function TextDiffView(_props: { docKey: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const chunkBarRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(-1);

  // 文件名仅在打开文件后显示（初始无占位文字）
  const [leftName, setLeftName] = useState('');
  const [rightName, setRightName] = useState('');
  const [chunkCount, setChunkCount] = useState(0);
  // 默认不折叠相同行（工具栏可开）
  const [collapseOn, setCollapseOn] = useState(false);
  // 左右两侧软换行状态与独立的 compartment
  const wrapCompARef = useRef(new Compartment());
  const wrapCompBRef = useRef(new Compartment());
  const [softWrap, setSoftWrap] = useState(() => useSettingsStore.getState().settings.editor.softWrap);
  const softWrapRef = useRef(softWrap);
  softWrapRef.current = softWrap;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 挂载时取编辑器设置快照（工具视图不随设置热切换；重开 tab 生效）
    const settings = useSettingsStore.getState().settings.editor;

    // 渲染一组采用按钮（◀ 左侧采用右侧 / ▶ 右侧采用左侧）
    const renderChunkButtons = (top: string, chunkIndex: number): HTMLElement => {
      const group = document.createElement('div');
      group.className = 'nb-diff-chunkbtns';
      group.dataset.chunk = String(chunkIndex);
      group.style.top = top;
      const leftBtn = document.createElement('button');
      leftBtn.type = 'button';
      leftBtn.className = 'nb-diff-apply-left';
      leftBtn.textContent = '◀';
      leftBtn.setAttribute('aria-label', '左侧采用右侧内容');
      const rightBtn = document.createElement('button');
      rightBtn.type = 'button';
      rightBtn.className = 'nb-diff-apply-right';
      rightBtn.textContent = '▶';
      rightBtn.setAttribute('aria-label', '右侧采用左侧内容');
      group.append(leftBtn, rightBtn);
      return group;
    };

    // 与 merge 内置 revert 层同机制：只为视口内差异块渲染/复用按钮，保序增删
    const updateChunkBar = () => {
      const current = mergeRef.current;
      const bar = chunkBarRef.current;
      if (!current || !bar) return;
      const chunks = getChunks(current.a.state)?.chunks ?? [];
      setChunkCount(chunks.length);
      const vpA = current.a.viewport;
      const vpB = current.b.viewport;
      const removeNode = (elt: HTMLElement): HTMLElement | null => {
        const following = elt.nextSibling as HTMLElement | null;
        elt.remove();
        return following;
      };
      let next = bar.firstChild as HTMLElement | null;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // chunks 有序：越过视口下界即可停止
        if (chunk.fromA > vpA.to || chunk.fromB > vpB.to) break;
        // 视口上界之前的块不渲染
        if (chunk.fromA < vpA.from || chunk.fromB < vpB.from) continue;
        const top = current.a.lineBlockAt(chunk.fromA).top + 'px';
        while (next && Number(next.dataset.chunk) < i) next = removeNode(next);
        if (next && next.dataset.chunk === String(i)) {
          if (next.style.top !== top) next.style.top = top;
          next = next.nextSibling as HTMLElement | null;
        } else {
          bar.insertBefore(renderChunkButtons(top, i), next);
        }
      }
      while (next) next = removeNode(next);
    };

    // rAF 节流更新中缝按钮（输入/视口/尺寸变化后等布局稳定再测量行位置）
    const scheduleUpdate = () => {
      if (rafRef.current > -1) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = -1;
        updateChunkBar();
      });
    };

    const makeSideExtensions = (wrapComp: Compartment): Extension[] => [
      // 与 txt 编辑器一致的基础观感（行号/主题/历史/括号匹配等）
      ...createBaseExtensions({
        showLineNumbers: settings.showLineNumbers,
        softWrap: false, // 软换行由本组件独立 Compartment 管理
      }),
      wrapComp.of(softWrapRef.current ? EditorView.lineWrapping : []),
      nbMergeDiffTheme,
      // 文档或视口变化后重算差异块按钮位置（拖拽分栏导致换行时视口变化）
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.viewportChanged) scheduleUpdate();
      }),
    ];

    const mv = new MergeView({
      a: { doc: '', extensions: makeSideExtensions(wrapCompARef.current) },
      b: { doc: '', extensions: makeSideExtensions(wrapCompBRef.current) },
      parent: host,
      // 差异行 gutter 色条
      gutter: true,
    });
    mergeRef.current = mv;

    // 逐处采用：把一侧差异块内容写入另一侧（复刻 merge 内置 revert 的编辑事务）
    const applyChunkAt = (index: number, toLeft: boolean) => {
      const current = mergeRef.current;
      if (!current) return;
      const chunk = (getChunks(current.a.state)?.chunks ?? [])[index];
      if (!chunk) return;
      // toLeft=true：左侧采用右侧（b → a）；false：右侧采用左侧（a → b）
      const [source, dest, srcFrom, srcTo, destFrom, destTo] = toLeft
        ? [current.b, current.a, chunk.fromB, chunk.toB, chunk.fromA, chunk.toA]
        : [current.a, current.b, chunk.fromA, chunk.toA, chunk.fromB, chunk.toB];
      let insert = source.state.sliceDoc(srcFrom, Math.max(srcFrom, srcTo - 1));
      if (srcFrom !== srcTo && destTo <= dest.state.doc.length)
        insert += source.state.lineBreak;
      dest.dispatch({
        changes: { from: destFrom, to: Math.min(dest.state.doc.length, destTo), insert },
        userEvent: 'revert',
      });
    };

    // 中缝拖拽：按住中缝（按钮之外区域）左右移动调整分栏；双击复位为左右平分
    const startResize = (e: MouseEvent) => {
      e.preventDefault();
      const bar = chunkBarRef.current;
      const row = bar?.parentElement as HTMLElement | null;
      if (!bar || !row) return;
      bar.classList.add('nb-diff-resizing');
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const handleMove = (moveEvent: MouseEvent) => {
        const rect = row.getBoundingClientRect();
        // 左侧宽度 = 鼠标位置减去中缝一半（以中缝中心线为界），限制在 20%~80%
        const usable = Math.max(1, rect.width - CHUNK_BAR_WIDTH);
        const leftPx = moveEvent.clientX - rect.left - CHUNK_BAR_WIDTH / 2;
        const clamped = Math.max(usable * 0.2, Math.min(usable * 0.8, leftPx));
        host.style.setProperty('--nb-diff-left', `${Math.round(clamped)}px`);
      };
      const handleUp = () => {
        bar.classList.remove('nb-diff-resizing');
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    };

    // 中缝按钮层：插入两个编辑器之间，mousedown 事件委托（按钮=采用；按钮外=拖拽分栏）
    const bar = document.createElement('div');
    bar.className = 'nb-diff-chunkbar';
    const handleBarMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const group = target.closest('.nb-diff-chunkbtns') as HTMLElement | null;
      if (group) {
        e.preventDefault();
        applyChunkAt(Number(group.dataset.chunk), target.classList.contains('nb-diff-apply-left'));
        return;
      }
      // 中缝空白区域：开始拖拽调整左右分栏
      startResize(e);
    };
    const handleBarDblClick = () => {
      // 双击复位为默认左右平分（CSS 里的变量默认值）
      host.style.removeProperty('--nb-diff-left');
    };
    bar.addEventListener('mousedown', handleBarMouseDown);
    bar.addEventListener('dblclick', handleBarDblClick);
    chunkBarRef.current = bar;
    const editorsRow = mv.dom.firstElementChild;
    if (editorsRow) editorsRow.insertBefore(bar, editorsRow.children[1] ?? null);

    // 监听两侧编辑器点击：点击行号槽下方无数字空白或编辑器容器空白时，聚焦并将光标移至文末
    const handleSideMouseDown = (view: EditorView) => (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // 若点击的是有效行号、折叠按钮或中缝采用按钮，交由原生处理
      if (target.closest('.cm-gutterElement') || target.closest('.nb-diff-chunkbtns')) {
        return;
      }
      // 若点击在行号槽空白区或滚动容器下方空白区，聚焦并将光标移至末尾
      if (
        target.closest('.cm-gutters') ||
        target.classList.contains('cm-scroller') ||
        target.classList.contains('cm-mergeViewEditor')
      ) {
        view.focus();
        const len = view.state.doc.length;
        view.dispatch({ selection: { anchor: len, head: len } });
      }
    };

    const sideAMouseDown = handleSideMouseDown(mv.a);
    const sideBMouseDown = handleSideMouseDown(mv.b);
    mv.a.dom.addEventListener('mousedown', sideAMouseDown);
    mv.b.dom.addEventListener('mousedown', sideBMouseDown);

    // 宽度/布局变化影响换行与行位置：resize 后重算（jsdom 无 ResizeObserver，判空跳过）
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleUpdate());
      resizeObserver.observe(mv.dom);
      // 拖拽分栏只改变编辑器 wrap 宽度（外层容器不变），需分别观察
      resizeObserver.observe(mv.a.dom);
      resizeObserver.observe(mv.b.dom);
    }

    updateChunkBar();

    return () => {
      if (rafRef.current > -1) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = -1;
      }
      resizeObserver?.disconnect();
      mv.a.dom.removeEventListener('mousedown', sideAMouseDown);
      mv.b.dom.removeEventListener('mousedown', sideBMouseDown);
      bar.removeEventListener('mousedown', handleBarMouseDown);
      bar.removeEventListener('dblclick', handleBarDblClick);
      bar.remove();
      chunkBarRef.current = null;
      mv.destroy();
      mergeRef.current = null;
    };
  }, []);

  // 打开文本文件到指定侧（后端统一探测编码 utf8/bom/gbk）
  const handleOpenFile = async (side: 'a' | 'b') => {
    const path = await open({ multiple: false, filters: TEXT_DIFF_FILE_FILTERS });
    if (!path || Array.isArray(path)) return;
    try {
      const payload = await ipc.readDocument(path);
      const mv = mergeRef.current;
      if (!mv) return;
      const content = payload.content ?? '';
      replaceDoc(side === 'a' ? mv.a : mv.b, content);
      if (side === 'a') setLeftName(payload.displayName || path);
      else setRightName(payload.displayName || path);
      if (content.length > LARGE_TEXT_WARNING_CHARS)
        showToast('文件较大，差异计算可能稍有延迟', 'info', 3000);
      // 载入后跳到第一处差异（若有）
      requestAnimationFrame(() => {
        const view = mergeRef.current;
        if (view && getChunks(view.a.state)?.chunks.length) goToNextChunk(view.a);
      });
    } catch (error) {
      showToast(
        `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
        'error',
        5000,
      );
    }
  };

  // 交换两侧文本与文件名
  const handleSwap = () => {
    const mv = mergeRef.current;
    if (!mv) return;
    const textA = mv.a.state.doc.toString();
    const textB = mv.b.state.doc.toString();
    replaceDoc(mv.a, textB);
    replaceDoc(mv.b, textA);
    setLeftName(rightName);
    setRightName(leftName);
  };

  // 复制一侧全文到剪贴板
  const handleCopy = (side: 'a' | 'b') => {
    const mv = mergeRef.current;
    if (!mv) return;
    const text = (side === 'a' ? mv.a : mv.b).state.doc.toString();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast('已复制到剪贴板', 'success', 2000))
        .catch(() => {
          // 忽略剪贴板写入失败（权限受限场景）
        });
    }
  };

  // 差异导航（在左侧编辑器执行：选中并滚动到上/下一处差异）
  const handleNav = (dir: 'next' | 'prev') => {
    const mv = mergeRef.current;
    if (!mv) return;
    const ok = dir === 'next' ? goToNextChunk(mv.a) : goToPreviousChunk(mv.a);
    if (!ok) showToast(dir === 'next' ? '已是最后一处差异' : '已是第一处差异', 'info', 2000);
  };

  // 折叠相同行开关（reconfigure 运行时切换，无需重建编辑器实例；默认关闭）
  const handleToggleCollapse = () => {
    const mv = mergeRef.current;
    if (!mv) return;
    const next = !collapseOn;
    setCollapseOn(next);
    mv.reconfigure({ collapseUnchanged: next ? COLLAPSE_UNCHANGED : undefined });
  };

  // 清空一侧文本与文件名
  const handleClear = (side: 'a' | 'b') => {
    const mv = mergeRef.current;
    if (!mv) return;
    replaceDoc(side === 'a' ? mv.a : mv.b, '');
    if (side === 'a') setLeftName('');
    else setRightName('');
  };

  // 自动换行开关（动态重配两侧编辑器）
  const handleToggleWrap = () => {
    const mv = mergeRef.current;
    if (!mv) return;
    const next = !softWrap;
    setSoftWrap(next);
    mv.a.dispatch({
      effects: wrapCompARef.current.reconfigure(next ? EditorView.lineWrapping : []),
    });
    mv.b.dispatch({
      effects: wrapCompBRef.current.reconfigure(next ? EditorView.lineWrapping : []),
    });
  };

  return (
    <div className="nb-diff-root">
      <style>{TEXT_DIFF_CSS}</style>
      {/* 工具栏：左=原文侧操作，中=对比控制，右=修改文侧操作 */}
      <div className="nb-diff-toolbar">
        <Tooltip content="打开文件到左侧" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn nb-diff-tbtn-accent" onClick={() => void handleOpenFile('a')}>
            <FolderOpen size={13} />
            <span>打开文件</span>
          </button>
        </Tooltip>
        <span className="nb-diff-name">{leftName}</span>
        <Tooltip content="复制左侧全文" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn" onClick={() => handleCopy('a')}>
            <Copy size={13} />
          </button>
        </Tooltip>
        <Tooltip content="清空左侧内容" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn" onClick={() => handleClear('a')}>
            <Trash2 size={13} />
          </button>
        </Tooltip>

        <span className="nb-diff-spacer" />

        <Tooltip content="交换两侧内容" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn" onClick={handleSwap}>
            <ArrowLeftRight size={13} />
          </button>
        </Tooltip>
        <Tooltip content="上一处差异" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn" onClick={() => handleNav('prev')}>
            <ChevronUp size={13} />
          </button>
        </Tooltip>
        <Tooltip content="下一处差异" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn" onClick={() => handleNav('next')}>
            <ChevronDown size={13} />
          </button>
        </Tooltip>
        <span className="nb-diff-count">{chunkCount > 0 ? `${chunkCount} 处差异` : '无差异'}</span>
        <Tooltip content="折叠相同行" side="bottom" sideOffset={4}>
          <button
            type="button"
            className={`nb-diff-tbtn${collapseOn ? ' nb-diff-tbtn-on' : ''}`}
            onClick={handleToggleCollapse}
          >
            <FoldVertical size={13} />
          </button>
        </Tooltip>
        <Tooltip content={softWrap ? '关闭自动换行' : '开启自动换行'} side="bottom" sideOffset={4}>
          <button
            type="button"
            className={`nb-diff-tbtn${softWrap ? ' nb-diff-tbtn-on' : ''}`}
            onClick={handleToggleWrap}
          >
            <WrapText size={13} />
          </button>
        </Tooltip>

        <span className="nb-diff-spacer" />

        <Tooltip content="清空右侧内容" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn" onClick={() => handleClear('b')}>
            <Trash2 size={13} />
          </button>
        </Tooltip>
        <Tooltip content="复制右侧全文" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn" onClick={() => handleCopy('b')}>
            <Copy size={13} />
          </button>
        </Tooltip>
        <span className="nb-diff-name">{rightName}</span>
        <Tooltip content="打开文件到右侧" side="bottom" sideOffset={4}>
          <button type="button" className="nb-diff-tbtn nb-diff-tbtn-accent" onClick={() => void handleOpenFile('b')}>
            <FolderOpen size={13} />
            <span>打开文件</span>
          </button>
        </Tooltip>
      </div>
      {/* MergeView 宿主（左右编辑器 + 中缝采用按钮层/拖拽把手） */}
      <div ref={hostRef} className="nb-diff-host" />
    </div>
  );
}
