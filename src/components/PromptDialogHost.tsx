// NoteBoard 全局输入弹窗宿主
// 渲染 promptDialogStore 中的当前请求，替代浏览器原生 prompt 的灰白系统框

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageOff, Loader2, PenLine, X, XCircle } from 'lucide-react';
import { usePromptDialogStore } from '../stores/promptDialogStore';
import { Tooltip } from './Tooltip';

type PreviewState = 'idle' | 'loading' | 'ok' | 'error';

/** 仅对可直接访问的地址做预览，相对路径交给编辑器按文档目录解析 */
const isPreviewableUrl = (url: string) => /^(https?:\/\/|data:image\/)/i.test(url);

export function PromptDialogHost() {
  const request = usePromptDialogStore((s) => s.request);
  if (!request) return null;
  // 以请求 id 作为 key：每次打开都是全新实例，输入值与预览状态天然重置
  return createPortal(<PromptDialog key={request.id} />, document.body);
}

function PromptDialog() {
  const request = usePromptDialogStore((s) => s.request)!;
  const settle = usePromptDialogStore((s) => s.settle);
  const [value, setValue] = useState(request.defaultValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; state: PreviewState }>({ url: '', state: 'idle' });
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 记录打开前的焦点，取消时归还（例如回到编辑器原光标处）
  const prevFocusRef = useRef<Element | null>(document.activeElement);

  const trimmed = value.trim();
  const canSubmit = request.allowEmpty || trimmed !== '';

  const close = (result: string | null) => {
    const prev = prevFocusRef.current;
    if (result === null && prev instanceof HTMLElement && prev.isConnected) {
      prev.focus({ preventScroll: true });
    }
    settle(result);
  };

  const submit = () => {
    if (!canSubmit) return;
    const message = request.validate?.(trimmed) ?? null;
    if (message) {
      setError(message);
      inputRef.current?.focus();
      return;
    }
    close(trimmed);
  };

  // 键盘与按钮回调都经 ref 取最新闭包，监听器只需绑定一次
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const closeRef = useRef(close);
  closeRef.current = close;

  // 打开后聚焦输入框并全选，便于直接覆盖旧值
  useEffect(() => {
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 30);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * 在 window 捕获阶段接管键盘：
   * 弹窗可能叠在多维表格弹层、设置面板等自带 Esc / Ctrl+Enter 处理的浮层之上，
   * 必须先于它们拦截，并阻止按键继续传播到编辑器或全局快捷键。
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const panel = panelRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current(null);
        return;
      }
      if (e.key === 'Enter' && e.target === inputRef.current) {
        e.preventDefault();
        e.stopPropagation();
        submitRef.current();
        return;
      }
      // Tab 焦点限制在弹窗内循环
      if (e.key === 'Tab' && panel) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>('input, button:not(:disabled)'));
        if (items.length > 0) {
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement;
          if (e.shiftKey && (active === first || !panel.contains(active))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
            e.preventDefault();
            first.focus();
          }
        }
      }
      // 其余按键只阻断传播，不阻止默认行为（输入、Ctrl+A、Ctrl+Z 等仍在输入框内生效）
      e.stopPropagation();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // 图片地址预览：输入停顿 300ms 后再加载，避免逐字请求
  useEffect(() => {
    if (!request.previewImage) return;
    if (!isPreviewableUrl(trimmed)) {
      setPreview({ url: '', state: 'idle' });
      return;
    }
    const timer = window.setTimeout(() => setPreview({ url: trimmed, state: 'loading' }), 300);
    return () => window.clearTimeout(timer);
  }, [trimmed, request.previewImage]);

  return (
    <div
      className="nb-prompt-overlay"
      role="presentation"
      // 点击遮罩空白处等同取消
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null);
      }}
    >
      <div
        ref={panelRef}
        className="nb-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nb-prompt-title"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nb-prompt-head">
          <div className="nb-prompt-icon">{request.icon ?? <PenLine size={17} />}</div>
          <div className="nb-prompt-heading">
            <div id="nb-prompt-title" className="nb-prompt-title">
              {request.title}
            </div>
            {request.description && <div className="nb-prompt-desc">{request.description}</div>}
          </div>
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button type="button" className="nb-prompt-close" aria-label="关闭" onClick={() => close(null)}>
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="nb-prompt-body">
          <div className={`nb-prompt-field${error ? ' has-error' : ''}`}>
            <input
              ref={inputRef}
              className="nb-prompt-input"
              type="text"
              value={value}
              placeholder={request.placeholder}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            {value && (
              <Tooltip content="清空" side="top" sideOffset={4}>
                <button
                  type="button"
                  className="nb-prompt-clear"
                  aria-label="清空"
                  // 保持输入框焦点，点击后可直接重新输入
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setValue('');
                    setError(null);
                    inputRef.current?.focus();
                  }}
                >
                  <XCircle size={15} />
                </button>
              </Tooltip>
            )}
          </div>
          {error && <div className="nb-prompt-error">{error}</div>}

          {request.previewImage && (
            <div className={`nb-prompt-preview is-${preview.state}`}>
              {preview.url && (
                <img
                  key={preview.url}
                  src={preview.url}
                  alt=""
                  // 与编辑器图片节点一致不发送 Referer，兼顾隐私与图床防盗链
                  referrerPolicy="no-referrer"
                  onLoad={() => setPreview((p) => (p.url === preview.url ? { ...p, state: 'ok' } : p))}
                  onError={() => setPreview((p) => (p.url === preview.url ? { ...p, state: 'error' } : p))}
                />
              )}
              {preview.state === 'idle' && <span>输入 http(s) 图片地址后在此预览</span>}
              {preview.state === 'loading' && (
                <span>
                  <Loader2 size={16} className="nb-prompt-spin" />
                  正在加载预览…
                </span>
              )}
              {preview.state === 'error' && (
                <span>
                  <ImageOff size={16} />
                  预览加载失败，仍可尝试插入
                </span>
              )}
            </div>
          )}
        </div>

        <div className="nb-prompt-foot">
          <span className="nb-prompt-hint">
            <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 取消
          </span>
          <button type="button" className="nb-btn-secondary" onClick={() => close(null)}>
            取消
          </button>
          <button type="button" className="nb-btn-primary" disabled={!canSubmit} onClick={submit}>
            {request.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
