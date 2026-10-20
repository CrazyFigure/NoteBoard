// NoteBoard 设置页下拉选择器
// 替代原生 <select>：原生弹出列表跟随系统样式（WebView2 下为深色块），无法适配三种主题
// 弹层挂到 body 并以 fixed 定位，避免被设置面板的滚动容器裁切；下方空间不足时向上展开

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface SettingsSelectOption<T extends string> {
  value: T;
  label: string;
}

interface SettingsSelectProps<T extends string> {
  value: T;
  options: readonly SettingsSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}

interface MenuPosition {
  left: number;
  top: number;
  minWidth: number;
  placement: 'bottom' | 'top';
}

/** 弹层与触发按钮的间距 */
const MENU_GAP = 4;

export function SettingsSelect<T extends string>({ value, options, onChange, ariaLabel }: SettingsSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: rect.left, top: rect.bottom + MENU_GAP, minWidth: rect.width, placement: 'bottom' });
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const closeMenu = () => {
    setOpen(false);
    setPosition(null);
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
    closeMenu();
    triggerRef.current?.focus();
  };

  // 弹层渲染后按实际高度判断方向：下方放不下且上方空间更大时改为向上展开
  useLayoutEffect(() => {
    if (!open || !position || position.placement !== 'bottom') return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    const spaceBelow = window.innerHeight - trigger.bottom - MENU_GAP;
    if (menu.height > spaceBelow && trigger.top > spaceBelow) {
      setPosition({ ...position, top: trigger.top - MENU_GAP - menu.height, placement: 'top' });
    }
  }, [open, position]);

  // 打开期间：点击外部、外部滚动或窗口尺寸变化时收起（fixed 弹层不会跟随滚动）
  useEffect(() => {
    if (!open) return;
    const isInside = (target: EventTarget | null) =>
      target instanceof Node && (!!menuRef.current?.contains(target) || !!triggerRef.current?.contains(target));
    const handlePointerDown = (e: PointerEvent) => {
      if (!isInside(e.target)) closeMenu();
    };
    const handleScroll = (e: Event) => {
      if (!isInside(e.target)) closeMenu();
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', closeMenu);
    };
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        // 只收起下拉，不让设置弹窗的 Esc 监听关闭整个设置
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Tab':
        closeMenu();
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="nb-settings-select"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className="nb-settings-select-value">{selected?.label ?? ''}</span>
        <ChevronDown size={14} className="nb-settings-select-arrow" />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            className={`nb-settings-select-menu is-${position.placement}`}
            style={{ left: position.left, top: position.top, minWidth: position.minWidth }}
          >
            {options.map((option, index) => {
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`nb-settings-select-option${isSelected ? ' is-selected' : ''}${index === activeIndex ? ' is-active' : ''}`}
                  // 阻止按下时抢走触发按钮焦点，保证键盘操作连续
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(index)}
                >
                  <span>{option.label}</span>
                  {isSelected && <Check size={14} className="nb-settings-select-check" />}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
