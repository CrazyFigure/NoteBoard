// NoteBoard 全局导出结果弹窗宿主
// 渲染 exportResultStore 中的当前结果：成功时提供「打开文件 / 在文件管理器中定位 / 关闭」，
// 失败时展示原因。外观沿用全局输入弹窗（nb-prompt）以保持一致。

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, FolderOpen, SquareArrowOutUpRight, X, XCircle } from 'lucide-react';
import { useExportResultStore } from '../stores/exportResultStore';
import { showToast } from '../stores/toastStore';
import * as ipc from '../core/ipc/commands';
import { IS_NATIVE_MOBILE } from '../core/platform';
import { Tooltip } from './Tooltip';

export function ExportResultDialogHost() {
  const request = useExportResultStore((s) => s.request);
  if (!request) return null;
  // 以请求 id 作为 key：连续导出时每次都是全新实例，焦点与按键监听天然重置
  return createPortal(<ExportResultDialog key={request.id} />, document.body);
}

/** 把异常整理成提示文案 */
function describe(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function ExportResultDialog() {
  const request = useExportResultStore((s) => s.request)!;
  const closeStore = useExportResultStore((s) => s.close);
  const primaryRef = useRef<HTMLButtonElement>(null);
  // 记录打开前的焦点，仅关闭时归还；打开文件后焦点应交给新标签页
  const prevFocusRef = useRef<Element | null>(document.activeElement);

  const success = request.status === 'success';
  const path = success ? request.path : null;

  const close = () => {
    const prev = prevFocusRef.current;
    if (prev instanceof HTMLElement && prev.isConnected) prev.focus({ preventScroll: true });
    closeStore();
  };

  // 在本软件中打开导出文件：按需加载打开编排，弹窗不额外拉起编辑器依赖
  const openInApp = async () => {
    if (!path) return;
    closeStore();
    try {
      const { openDocument } = await import('../features/editor-code/orchestration/openDocument');
      await openDocument(path);
    } catch (error) {
      showToast(`打开文件失败：${describe(error, '未知错误')}`, 'error');
    }
  };

  // 在系统文件管理器中定位导出文件
  const reveal = async () => {
    if (!path) return;
    closeStore();
    try {
      await ipc.revealInExplorer(path);
    } catch (error) {
      showToast(`无法打开文件夹：${describe(error, '未知错误')}`, 'error');
    }
  };

  // 键盘与按钮回调都经 ref 取最新闭包，监听器只需绑定一次
  const actionsRef = useRef({ close, primary: success ? openInApp : close });
  actionsRef.current = { close, primary: success ? openInApp : close };

  // 打开后聚焦主按钮，Enter 可直接执行
  useEffect(() => {
    const timer = window.setTimeout(() => primaryRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * 在 window 捕获阶段接管键盘：
   * 导出可能由多维表格弹层、思维导图等自带快捷键的区域发起，必须先于它们拦截，
   * 并阻止按键继续传播到编辑器或全局快捷键。
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        actionsRef.current.close();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // 焦点在某个按钮上时执行该按钮，否则执行主操作
        const focused = document.activeElement;
        if (focused instanceof HTMLButtonElement && focused.closest('.nb-export-result')) {
          focused.click();
        } else {
          void actionsRef.current.primary();
        }
        return;
      }
      // 与全局规则一致：弹窗内不使用 Tab 循环切换按钮
      if (e.key === 'Tab') e.preventDefault();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  return (
    <div
      className="nb-prompt-overlay"
      role="presentation"
      // 点击遮罩空白处等同关闭
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={`nb-prompt nb-export-result ${success ? 'is-success' : 'is-error'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nb-export-result-title"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nb-prompt-head">
          <div className="nb-prompt-icon">{success ? <CheckCircle2 size={18} /> : <XCircle size={18} />}</div>
          <div className="nb-prompt-heading">
            <div id="nb-export-result-title" className="nb-prompt-title">
              {request.title}
            </div>
            <div className="nb-prompt-desc">{success ? request.fileName : '文件未能导出'}</div>
          </div>
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button type="button" className="nb-prompt-close" aria-label="关闭" onClick={close}>
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="nb-prompt-body">
          {success ? (
            <div className="nb-export-result-path">{request.path}</div>
          ) : (
            <div className="nb-export-result-error">{request.message}</div>
          )}
        </div>

        <div className="nb-prompt-foot">
          {success ? (
            <>
              <button type="button" className="nb-btn-secondary" onClick={close}>
                关闭
              </button>
              {/* 移动端没有系统文件管理器可定位 */}
              {!IS_NATIVE_MOBILE && (
                <button type="button" className="nb-btn-secondary nb-export-result-btn" onClick={() => void reveal()}>
                  <FolderOpen size={14} />
                  在文件管理器中定位
                </button>
              )}
              <button
                ref={primaryRef}
                type="button"
                className="nb-btn-primary nb-export-result-btn"
                onClick={() => void openInApp()}
              >
                <SquareArrowOutUpRight size={14} />
                打开文件
              </button>
            </>
          ) : (
            <button ref={primaryRef} type="button" className="nb-btn-primary" onClick={close}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
