// 设置 · 全局 · 新建入口布局
// 两个分区：「直接展示」与「收进更多」，主页卡片与「+」菜单共用一份配置。
// 交互：区内拖动排序、跨区拖动改变归属；每项另有一键移动按钮，触屏或键盘无需拖拽也能调整。
// 宽容器左右并排，窄容器（手机 / 窄窗口）上下堆叠，移动按钮箭头随方向切换。

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowLeftRight,
  ArrowUpDown,
  ChevronRight,
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  GripVertical,
  Home,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  DEFAULT_CREATE_FORMATS,
  getCreateFormat,
  isDefaultCreateFormats,
  type CreateFormatId,
  type ResolvedCreateFormats,
} from '../../features/welcome/createFormats';
import { useCreateFormats } from '../../features/welcome/useCreateFormats';

type Zone = 'primary' | 'more';

// 分区容器的拖放 id，与格式 id 区分开
const ZONE_DROP_ID: Record<Zone, string> = { primary: 'zone:primary', more: 'zone:more' };
// 内容区窄于该宽度时改为上下堆叠
const STACK_BREAKPOINT = 560;

function zoneOf(id: string, items: ResolvedCreateFormats): Zone | null {
  if (id === ZONE_DROP_ID.primary) return 'primary';
  if (id === ZONE_DROP_ID.more) return 'more';
  if ((items.primary as string[]).includes(id)) return 'primary';
  if ((items.more as string[]).includes(id)) return 'more';
  return null;
}

function sameLayout(a: ResolvedCreateFormats, b: ResolvedCreateFormats): boolean {
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return same(a.primary, b.primary) && same(a.more, b.more);
}

// 指针落在某个条目上时优先命中条目，落在分区空白处命中分区；键盘拖动没有指针坐标，退回最近中心
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length > 0) {
    const itemHits = hits.filter((hit) => !String(hit.id).startsWith('zone:'));
    return itemHits.length > 0 ? itemHits : hits;
  }
  return closestCenter(args);
};

/** 监听元素宽度，决定是否切换为上下堆叠 */
function useStacked(ref: React.RefObject<HTMLElement | null>): boolean {
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setStacked(entry.contentRect.width < STACK_BREAKPOINT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return stacked;
}

// ── 单个条目 ──

interface FormatChipProps {
  id: CreateFormatId;
  zone: Zone;
  /** 拖动浮层中的副本 */
  overlay?: boolean;
  /** 刚通过按钮移入，播放一次高亮 */
  flash?: boolean;
}

/** 条目外观：拖动把手、图标、名称、扩展名 */
function FormatChipBody({ id, zone }: { id: CreateFormatId; zone: Zone }) {
  const meta = getCreateFormat(id);
  const Icon = meta.icon;
  return (
    <>
      <span className="nb-cf-grip" aria-hidden="true">
        <GripVertical size={14} />
      </span>
      <span className="nb-cf-icon" style={{ '--nb-cf-color': meta.color } as CSSProperties}>
        <Icon size={zone === 'primary' ? 15 : 14} color={meta.color} />
      </span>
      <span className="nb-cf-name">{meta.name}</span>
      {meta.ext && <span className="nb-cf-ext">{meta.ext}</span>}
    </>
  );
}

function SortableFormatChip({
  id,
  zone,
  stacked,
  flash,
  dragging,
  onMove,
}: FormatChipProps & { stacked: boolean; dragging: boolean; onMove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  // 移动按钮的方向示意目标分区的相对位置
  const MoveIcon = zone === 'primary'
    ? (stacked ? ChevronsDown : ChevronsRight)
    : (stacked ? ChevronsUp : ChevronsLeft);
  const moveLabel = zone === 'primary' ? '收进更多' : '直接展示';
  const name = getCreateFormat(id).name;
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={[
        'nb-cf-chip',
        `is-${zone}`,
        isDragging ? 'is-placeholder' : '',
        flash ? 'is-flash' : '',
      ].filter(Boolean).join(' ')}
      {...attributes}
      {...listeners}
      aria-label={`${name}，${zone === 'primary' ? '直接展示' : '收进更多'}`}
    >
      <FormatChipBody id={id} zone={zone} />
      <Tooltip content={moveLabel} side="top" sideOffset={6} disabled={dragging}>
        <button
          type="button"
          className="nb-cf-move"
          aria-label={`${name}${moveLabel}`}
          // 阻止按钮上的按下与按键冒泡到条目，避免被识别为拖动起点
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={onMove}
        >
          <MoveIcon size={14} />
        </button>
      </Tooltip>
    </li>
  );
}

// ── 分区 ──

interface ZoneProps {
  zone: Zone;
  ids: CreateFormatId[];
  stacked: boolean;
  activeZone: Zone | null;
  dragging: boolean;
  flashId: CreateFormatId | null;
  onMove: (id: CreateFormatId) => void;
}

function FormatZone({ zone, ids, stacked, activeZone, dragging, flashId, onMove }: ZoneProps) {
  const { setNodeRef } = useDroppable({ id: ZONE_DROP_ID[zone] });
  const isPrimary = zone === 'primary';
  return (
    <section
      className={['nb-cf-zone', `is-${zone}`, activeZone === zone ? 'is-target' : ''].filter(Boolean).join(' ')}
      aria-label={isPrimary ? '直接展示' : '收进更多'}
    >
      <header className="nb-cf-zone-head">
        {isPrimary ? (
          <span className="nb-cf-zone-badge is-primary">
            <LayoutGrid size={13} />
          </span>
        ) : (
          <span className="nb-cf-zone-badge is-more">
            <MoreHorizontal size={13} />
          </span>
        )}
        <span className="nb-cf-zone-title">{isPrimary ? '直接展示' : '收进更多'}</span>
        <span className="nb-cf-zone-count">{ids.length}</span>
        {/* 图形化提示分区去向：直接展示出现在主页与「+」菜单首层；收进更多折叠在「更多 ›」之后 */}
        {isPrimary ? (
          <span className="nb-cf-where" aria-hidden="true">
            <Home size={12} />
            <Plus size={12} />
          </span>
        ) : (
          <span className="nb-cf-where is-more" aria-hidden="true">
            <span>更多</span>
            <ChevronRight size={11} />
          </span>
        )}
      </header>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className="nb-cf-list">
          {ids.map((id) => (
            <SortableFormatChip
              key={id}
              id={id}
              zone={zone}
              stacked={stacked}
              dragging={dragging}
              flash={flashId === id}
              onMove={() => onMove(id)}
            />
          ))}
          {ids.length === 0 && (
            <li className="nb-cf-empty" aria-hidden="true">
              拖到这里
            </li>
          )}
        </ul>
      </SortableContext>
    </section>
  );
}

// ── 主体 ──

export function CreateFormatsSettings() {
  const saved = useCreateFormats();
  const setLayout = useSettingsStore((s) => s.setLayout);
  // 拖动期间的临时布局；松手后提交到设置并清空
  const [draft, setDraft] = useState<ResolvedCreateFormats | null>(null);
  const draftRef = useRef<ResolvedCreateFormats | null>(null);
  const [activeId, setActiveId] = useState<CreateFormatId | null>(null);
  const [flashId, setFlashId] = useState<CreateFormatId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stacked = useStacked(rootRef);
  const items = draft ?? saved;
  const isDefault = isDefaultCreateFormats(saved);

  const updateDraft = (next: ResolvedCreateFormats | null) => {
    draftRef.current = next;
    setDraft(next);
  };

  const commit = (next: ResolvedCreateFormats) => {
    void setLayout({ createFormats: { primary: [...next.primary], more: [...next.more] } });
  };

  // 鼠标移动 4px 起拖，避免点按误触；触屏长按 180ms 起拖，短滑仍用于滚动页面
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 高亮在动画结束后清除
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 700);
    return () => clearTimeout(timer);
  }, [flashId]);

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(active.id as CreateFormatId);
    updateDraft(saved);
  };

  // 跨区拖动时实时移入目标分区，松手前即可看到落点
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    const current = draftRef.current;
    if (!current || !over) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    const from = zoneOf(activeKey, current);
    const to = zoneOf(overKey, current);
    if (!from || !to || from === to) return;
    const fromList = current[from].filter((id) => id !== activeKey);
    const toList = [...current[to]];
    const overIndex = toList.indexOf(overKey as CreateFormatId);
    let insertAt = toList.length;
    if (overIndex >= 0) {
      // 拖动项中心越过目标项中线时插到其后
      const activeRect = active.rect.current.translated;
      const below = activeRect ? activeRect.top + activeRect.height / 2 > over.rect.top + over.rect.height / 2 : false;
      insertAt = overIndex + (below ? 1 : 0);
    }
    toList.splice(insertAt, 0, activeKey as CreateFormatId);
    updateDraft({ ...current, [from]: fromList, [to]: toList });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    let next = draftRef.current ?? saved;
    if (over) {
      const activeKey = String(active.id);
      const overKey = String(over.id);
      const zone = zoneOf(activeKey, next);
      if (zone && zone === zoneOf(overKey, next)) {
        const list = next[zone];
        const oldIndex = list.indexOf(activeKey as CreateFormatId);
        const newIndex = overKey.startsWith('zone:') ? list.length - 1 : list.indexOf(overKey as CreateFormatId);
        if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) {
          next = { ...next, [zone]: arrayMove(list, oldIndex, newIndex) };
        }
      }
    } else {
      // 拖出所有分区后松手视为取消
      next = saved;
    }
    setActiveId(null);
    updateDraft(null);
    if (!sameLayout(next, saved)) commit(next);
  };

  const handleDragCancel = () => {
    setActiveId(null);
    updateDraft(null);
  };

  // 一键移到另一分区末尾
  const moveToOtherZone = (id: CreateFormatId) => {
    const from = zoneOf(id, saved);
    if (!from) return;
    const to: Zone = from === 'primary' ? 'more' : 'primary';
    commit({
      ...saved,
      [from]: saved[from].filter((item) => item !== id),
      [to]: [...saved[to], id],
    });
    setFlashId(id);
  };

  const activeZone = activeId ? zoneOf(activeId, items) : null;

  return (
    <div className="nb-cf" ref={rootRef}>
      <div className="nb-cf-head">
        <div className="nb-cf-head-text">
          <div className="nb-cf-title">
            <span className="nb-cf-title-icons" aria-hidden="true">
              <Home size={13} />
              <Plus size={13} />
            </span>
            <span>新建入口</span>
          </div>
          <div className="nb-cf-hint">主页与「+」菜单共用 · 拖动排序或拖到另一侧</div>
        </div>
        <Tooltip content="恢复默认布局" side="top" sideOffset={6}>
          <button
            type="button"
            className="nb-cf-reset"
            disabled={isDefault}
            onClick={() => commit({ primary: [...DEFAULT_CREATE_FORMATS.primary], more: [...DEFAULT_CREATE_FORMATS.more] } as ResolvedCreateFormats)}
          >
            <RotateCcw size={13} />
            <span>恢复默认</span>
          </button>
        </Tooltip>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className={['nb-cf-board', stacked ? 'is-stacked' : ''].filter(Boolean).join(' ')}>
          <FormatZone
            zone="primary"
            ids={items.primary}
            stacked={stacked}
            activeZone={activeZone}
            dragging={Boolean(activeId)}
            flashId={flashId}
            onMove={moveToOtherZone}
          />
          {/* 两区之间的双向箭头，示意条目可在两侧之间移动 */}
          <div className="nb-cf-bridge" aria-hidden="true">
            <span>{stacked ? <ArrowUpDown size={14} /> : <ArrowLeftRight size={14} />}</span>
          </div>
          <FormatZone
            zone="more"
            ids={items.more}
            stacked={stacked}
            activeZone={activeZone}
            dragging={Boolean(activeId)}
            flashId={flashId}
            onMove={moveToOtherZone}
          />
        </div>

        {/* 浮层挂到 body，避免被设置弹窗的滚动容器裁切；层级高于设置遮罩 */}
        {createPortal(
          <DragOverlay zIndex={10060} dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
            {activeId && activeZone ? (
              <div className={`nb-cf-chip is-${activeZone} is-overlay`}>
                <FormatChipBody id={activeId} zone={activeZone} />
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </div>
  );
}
