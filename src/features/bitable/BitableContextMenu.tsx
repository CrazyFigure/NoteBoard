// NoteBoard 多维表格单元格右键菜单（表格视图 / 甘特视图共用）
// 1) 主菜单按实测尺寸做视口越界防护：指针右侧/下方放不下时翻到左侧/上方，仍放不下再夹进视口
// 2) 支持二级子菜单：贴触发项右侧展开，右侧不足翻到左侧；两侧都放不下（手机窄屏）时改在触发项下方展开
// 3) 桌面端悬停打开子菜单、移到其它项时延迟收起（容忍斜向移动）；触屏端点击触发项打开

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

/** 菜单普通项 */
export interface BitableMenuItem {
  kind: 'item';
  key: string;
  icon: React.ReactNode;
  label: string;
  /** 右侧快捷键提示 */
  shortcut?: string;
  /** 危险操作（删除类）用红色文字 */
  danger?: boolean;
  /** 点击回调；执行后菜单自动关闭 */
  onSelect: () => void;
}

/** 分隔线 */
export interface BitableMenuDivider {
  kind: 'divider';
  key: string;
}

/** 二级子菜单触发项 */
export interface BitableMenuSubmenu {
  kind: 'submenu';
  key: string;
  icon: React.ReactNode;
  label: string;
  children: Array<BitableMenuItem | BitableMenuDivider | false | null | undefined>;
}

export type BitableMenuEntry = BitableMenuItem | BitableMenuDivider | BitableMenuSubmenu;

/** 允许调用方用 `cond && {...}` 声明条件项 */
type MaybeEntry<T> = T | false | null | undefined;

interface BitableContextMenuProps {
  /** 指针位置（视口坐标） */
  x: number;
  y: number;
  entries: Array<MaybeEntry<BitableMenuEntry>>;
  /** 包裹主菜单与子菜单的外层引用，供调用方判断「点击是否在菜单内」 */
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

const VIEWPORT_PADDING = 8;
// 子菜单与触发项的水平间距
const SUBMENU_GAP = 2;
// 菜单容器的 padding + border，用于让子菜单首项与触发项顶边齐平
const PANEL_INSET = 5;
// 鼠标移到其它项后收起子菜单的延迟：给斜向移入子菜单留出余量
const SUBMENU_CLOSE_DELAY = 150;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

/** 去掉条件项留下的 false/null，并清理首尾与连续的分隔线 */
function compactEntries<T extends { kind: string }>(list: Array<MaybeEntry<T>>): T[] {
  const result: T[] = [];
  for (const entry of list) {
    if (!entry) continue;
    if (entry.kind === 'divider' && (result.length === 0 || result[result.length - 1].kind === 'divider')) continue;
    result.push(entry);
  }
  while (result.length > 0 && result[result.length - 1].kind === 'divider') result.pop();
  return result;
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  background: 'var(--editor-surface, #ffffff)',
  border: '1px solid var(--editor-border, #cbd5e1)',
  borderRadius: 8,
  boxShadow: '0 10px 25px rgba(15,23,42,0.15)',
  padding: 4,
  fontSize: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  boxSizing: 'border-box',
  // 视口实在放不下时才出现滚动，保证菜单本身不越界
  maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
  overflowY: 'auto',
};

const dividerStyle: React.CSSProperties = {
  height: 1,
  flexShrink: 0,
  background: 'var(--editor-border, #e2e8f0)',
  margin: '3px 0',
};

export function BitableContextMenu({ x, y, entries, menuRef, onClose }: BitableContextMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  // 主菜单定位：测量完成前隐藏，避免先在越界位置闪一下
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 当前展开的子菜单及其触发项位置
  const [submenu, setSubmenu] = useState<{
    key: string;
    anchor: { top: number; bottom: number; left: number; right: number };
  } | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number } | null>(null);

  const items = compactEntries(entries);
  const activeSubmenu = submenu
    ? (items.find((e) => e.kind === 'submenu' && e.key === submenu.key) as BitableMenuSubmenu | undefined)
    : undefined;
  const submenuItems = activeSubmenu ? compactEntries(activeSubmenu.children) : [];

  const cancelSubmenuClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleSubmenuClose = () => {
    cancelSubmenuClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setSubmenu(null);
    }, SUBMENU_CLOSE_DELAY);
  };

  useEffect(() => cancelSubmenuClose, []);

  // 主菜单：按实测宽高决定朝向，右/下放不下就翻到指针左/上侧，最后统一夹进视口
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = x + w > vw - VIEWPORT_PADDING ? x - w : x;
    const top = y + h > vh - VIEWPORT_PADDING ? y - h : y;
    setPos({
      left: clamp(left, VIEWPORT_PADDING, vw - w - VIEWPORT_PADDING),
      top: clamp(top, VIEWPORT_PADDING, vh - h - VIEWPORT_PADDING),
    });
    // 在新位置重新打开时收起上一次残留的子菜单
    setSubmenu(null);
  }, [x, y, items.length]);

  // 子菜单：右侧 → 左侧 → 触发项下方（窄屏兜底），再夹进视口
  useLayoutEffect(() => {
    const el = submenuRef.current;
    if (!submenu || !el) return;
    const { anchor } = submenu;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (anchor.right + SUBMENU_GAP + w <= vw - VIEWPORT_PADDING) {
      left = anchor.right + SUBMENU_GAP;
      top = anchor.top - PANEL_INSET;
    } else if (anchor.left - SUBMENU_GAP - w >= VIEWPORT_PADDING) {
      left = anchor.left - SUBMENU_GAP - w;
      top = anchor.top - PANEL_INSET;
    } else {
      // 两侧都放不下：叠在主菜单上、从触发项下方展开，下方不够再翻到触发项上方
      left = anchor.left + 16;
      top = anchor.bottom + SUBMENU_GAP;
      if (top + h > vh - VIEWPORT_PADDING) top = anchor.top - SUBMENU_GAP - h;
    }
    setSubmenuPos({
      left: clamp(left, VIEWPORT_PADDING, vw - w - VIEWPORT_PADDING),
      top: clamp(top, VIEWPORT_PADDING, vh - h - VIEWPORT_PADDING),
    });
  }, [submenu]);

  const openSubmenu = (key: string, el: HTMLElement) => {
    cancelSubmenuClose();
    if (submenu?.key === key) return;
    const r = el.getBoundingClientRect();
    // 水平方向贴主菜单外框（而非触发项）展开，避免子菜单压住主菜单边框
    const panel = panelRef.current?.getBoundingClientRect();
    setSubmenuPos(null);
    setSubmenu({
      key,
      anchor: { top: r.top, bottom: r.bottom, left: panel?.left ?? r.left, right: panel?.right ?? r.right },
    });
  };

  const renderItem = (item: BitableMenuItem, onMouseEnter?: () => void) => (
    <button
      key={item.key}
      type="button"
      className="nb-bitable-menu-item"
      style={item.danger ? { color: '#ef4444' } : undefined}
      onMouseEnter={onMouseEnter}
      onClick={() => {
        item.onSelect();
        onClose();
      }}
    >
      {item.icon}
      <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{item.label}</span>
      {item.shortcut && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 12 }}>{item.shortcut}</span>}
    </button>
  );

  return (
    <div
      ref={menuRef}
      data-no-drag
      // 阻止 mousedown 冒泡，防止外部监听提前关闭菜单导致按钮 onClick 无法触发
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        ref={panelRef}
        // 菜单自身滚动会让子菜单与触发项错位，直接收起子菜单
        onScroll={() => setSubmenu(null)}
        style={{
          ...panelStyle,
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          visibility: pos ? 'visible' : 'hidden',
          zIndex: 9999,
          minWidth: 160,
        }}
      >
        {items.map((entry) => {
          if (entry.kind === 'divider') return <div key={entry.key} style={dividerStyle} />;
          // 主菜单普通项：移入时延迟收起已展开的子菜单
          if (entry.kind === 'item') return renderItem(entry, () => submenu && scheduleSubmenuClose());
          const isOpen = submenu?.key === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              className={['nb-bitable-menu-item', 'has-submenu', isOpen ? 'is-submenu-open' : ''].filter(Boolean).join(' ')}
              // 桌面端悬停即展开；触屏端点按同样走 click 打开（重复打开同一子菜单为空操作）
              onMouseEnter={(e) => openSubmenu(entry.key, e.currentTarget)}
              onClick={(e) => openSubmenu(entry.key, e.currentTarget)}
            >
              {entry.icon}
              <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{entry.label}</span>
              <ChevronRight size={12} style={{ opacity: 0.55, flexShrink: 0 }} />
            </button>
          );
        })}
      </div>

      {activeSubmenu && submenuItems.length > 0 && (
        <div
          ref={submenuRef}
          onMouseEnter={cancelSubmenuClose}
          style={{
            ...panelStyle,
            left: submenuPos?.left ?? submenu!.anchor.right + SUBMENU_GAP,
            top: submenuPos?.top ?? submenu!.anchor.top,
            visibility: submenuPos ? 'visible' : 'hidden',
            zIndex: 10000,
            minWidth: 140,
          }}
        >
          {submenuItems.map((entry) =>
            entry.kind === 'divider' ? <div key={entry.key} style={dividerStyle} /> : renderItem(entry),
          )}
        </div>
      )}
    </div>
  );
}
