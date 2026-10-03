// NoteBoard 移动端通用组件
// 底部面板、操作面板、输入对话框、确认对话框、顶栏与图标按钮。
// 设计延续桌面版：低对比 chrome、圆角与过渡沿用主题变量；触控目标 ≥ 44px，按压时缩放 + 加深背景反馈。
// 所有覆盖层登记到 mobileStore 覆盖层栈，Android 返回键优先关闭最上层。

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useMobileStore } from './mobileStore';

/** 覆盖层打开期间登记到返回键栈 */
export function useBackDismiss(open: boolean, onClose: () => void): void {
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    useMobileStore.getState().pushOverlay(id, () => closeRef.current());
    return () => useMobileStore.getState().removeOverlay(id);
  }, [open, id]);
}

// ── 图标按钮 ──

export interface IconButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}

/** 顶栏/工具栏图标按钮：44px 触控区域，aria-label 提供无障碍说明（触屏无悬停提示） */
export function IconButton({ icon, label, onClick, active, disabled, className }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`nb-m-icon-btn${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

// ── 顶栏 ──

export interface TopBarProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  onTitleClick?: () => void;
}

export function TopBar({ title, subtitle, onBack, actions, onTitleClick }: TopBarProps) {
  return (
    <header className="nb-m-topbar">
      {onBack && <IconButton icon={<ChevronLeft size={22} />} label="返回" onClick={onBack} />}
      <div
        className={`nb-m-topbar-title${onBack ? '' : ' has-padding'}${onTitleClick ? ' is-clickable' : ''}`}
        onClick={onTitleClick}
        role={onTitleClick ? 'button' : undefined}
      >
        <div className="nb-m-topbar-main">{title}</div>
        {subtitle && <div className="nb-m-topbar-sub">{subtitle}</div>}
      </div>
      <div className="nb-m-topbar-actions">{actions}</div>
    </header>
  );
}

// ── 底部面板 ──

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** 面板高度：auto 随内容（最高 85%），tall 固定 85% */
  size?: 'auto' | 'tall';
}

/** 底部面板：遮罩点击或返回键关闭；内容区可滚动 */
export function BottomSheet({ open, onClose, title, children, size = 'auto' }: BottomSheetProps) {
  useBackDismiss(open, onClose);
  if (!open) return null;
  return (
    <div className="nb-m-sheet-overlay" onClick={onClose}>
      <div
        className={`nb-m-sheet${size === 'tall' ? ' is-tall' : ''}`}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nb-m-sheet-grip" />
        {title && <div className="nb-m-sheet-title">{title}</div>}
        <div className="nb-m-sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ── 操作面板 ──

export interface SheetAction {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  description?: string;
  onSelect: () => void;
}

export interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  actions: SheetAction[];
}

/** 操作面板：选择后自动关闭再执行（避免执行中再弹出的对话框被立即关闭） */
export function ActionSheet({ open, onClose, title, actions }: ActionSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="nb-m-action-list">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={`nb-m-action${action.danger ? ' is-danger' : ''}`}
            disabled={action.disabled}
            onClick={() => {
              onClose();
              // 关闭后再执行：先让覆盖层出栈（setTimeout 不依赖渲染帧，后台/低帧率时同样可靠）
              window.setTimeout(() => action.onSelect(), 0);
            }}
          >
            {action.icon && <span className="nb-m-action-icon">{action.icon}</span>}
            <span className="nb-m-action-text">
              <span className="nb-m-action-label">{action.label}</span>
              {action.description && <span className="nb-m-action-desc">{action.description}</span>}
            </span>
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}

// ── 居中对话框 ──

interface DialogFrameProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}

function DialogFrame({ open, onClose, title, children, footer }: DialogFrameProps) {
  useBackDismiss(open, onClose);
  if (!open) return null;
  return (
    <div className="nb-m-dialog-overlay" onClick={onClose}>
      <div className="nb-m-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="nb-m-dialog-title">{title}</div>
        <div className="nb-m-dialog-body">{children}</div>
        <div className="nb-m-dialog-footer">{footer}</div>
      </div>
    </div>
  );
}

export interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  initialValue: string;
  placeholder?: string;
  confirmLabel?: string;
  /** 文件名场景：初始仅选中扩展名之前的部分 */
  selectBaseName?: boolean;
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void | Promise<void>;
  onClose: () => void;
}

/** 输入对话框：回车确认；校验失败时在输入框下方提示 */
export function PromptDialog({
  open,
  title,
  description,
  initialValue,
  placeholder,
  confirmLabel = '确定',
  selectBaseName,
  validate,
  onConfirm,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开重置内容并聚焦（文件名只选中主名部分，便于直接改名保留扩展名）
  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError(null);
    const timer = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const dot = initialValue.lastIndexOf('.');
      if (selectBaseName && dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [open, initialValue, selectBaseName]);

  const submit = async () => {
    const message = validate?.(value) ?? null;
    if (message) {
      setError(message);
      return;
    }
    setBusy(true);
    try {
      await onConfirm(value.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="nb-m-text-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="nb-m-text-btn is-primary" onClick={() => void submit()} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {description && <div className="nb-m-dialog-desc">{description}</div>}
      <input
        ref={inputRef}
        className={`nb-m-input${error ? ' has-error' : ''}`}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {error && <div className="nb-m-input-error">{error}</div>}
    </DialogFrame>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** 确认对话框（危险操作使用 danger 配色） */
export function ConfirmDialog({ open, title, message, confirmLabel = '确定', danger, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <DialogFrame
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="nb-m-text-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`nb-m-text-btn ${danger ? 'is-danger' : 'is-primary'}`}
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="nb-m-dialog-desc">{message}</div>
    </DialogFrame>
  );
}

// ── 长按 ──

/**
 * 长按手势：480ms 触发；移动超过 10px 视为滚动取消。
 * 返回需展开到目标元素上的事件处理器；长按触发后吞掉随后的 click，避免同时执行"打开"。
 */
export function useLongPress(onLongPress: () => void, onTap: () => void) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return {
    onPointerDown: (event: React.PointerEvent) => {
      firedRef.current = false;
      startRef.current = { x: event.clientX, y: event.clientY };
      clear();
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        // 轻微震动反馈（设备支持时）
        navigator.vibrate?.(12);
        onLongPress();
      }, 480);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    // 长按已触发时阻止本次触摸的默认行为：抬手后浏览器补发的 click 会落在刚弹出的面板上，
    // 导致面板立即被遮罩关闭或误触面板中的操作项
    onTouchEnd: (event: React.TouchEvent) => {
      if (firedRef.current) event.preventDefault();
    },
    onClick: () => {
      if (firedRef.current) {
        firedRef.current = false;
        return;
      }
      onTap();
    },
    // 系统长按菜单由应用接管
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  };
}
