// NoteBoard 文档历史记录：画板差异（Excalidraw 元素按 id，纯函数）
//
//   - 忽略每次保存都会变化的字段（version / versionNonce / updated / seed / index）
//   - 绑定在容器里的文字并入容器：改文字算容器被修改
//   - 删除的元素复制为半透明、锁定的「幽灵」元素放回原位置（新 id，解除分组与绑定），
//     图片元素引用的文件从旧版本补齐
// 改动处按画面位置（自上而下、自左而右）排序，供上一处 / 下一处跳转。

import type { ExcalidrawElement, ExcalidrawScene, ExcalidrawFileData } from '../../board/sceneIo';

export type BoardDiffKind = 'ins' | 'del' | 'mod';

export interface BoardChange {
  /** 合并场景中的元素 id（删除的元素为幽灵副本 id） */
  id: string;
  kind: BoardDiffKind;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface BoardDiffResult {
  elements: ExcalidrawElement[];
  files: Record<string, ExcalidrawFileData>;
  changes: BoardChange[];
}

/** 幽灵副本 id 后缀 */
export const GHOST_SUFFIX = '~nb-history';
const VOLATILE = ['version', 'versionNonce', 'updated', 'seed', 'index'];

const TYPE_LABEL: Record<string, string> = {
  rectangle: '矩形', ellipse: '椭圆', diamond: '菱形', arrow: '箭头', line: '线条',
  freedraw: '手绘', text: '文字', image: '图片', frame: '画框', embeddable: '嵌入',
};

function live(scene: ExcalidrawScene | null): ExcalidrawElement[] {
  return (scene?.elements ?? []).filter((e) => !e.isDeleted);
}

function key(el: ExcalidrawElement): string {
  const copy: Record<string, unknown> = { ...el };
  for (const k of VOLATILE) delete copy[k];
  return JSON.stringify(copy, Object.keys(copy).sort());
}

/** 元素外接矩形（线条与箭头的宽高可能为负） */
export function boundsOf(el: ExcalidrawElement): BoardChange['bounds'] {
  const x1 = Math.min(el.x, el.x + (el.width || 0));
  const y1 = Math.min(el.y, el.y + (el.height || 0));
  return { x: x1, y: y1, width: Math.abs(el.width || 0), height: Math.abs(el.height || 0) };
}

function labelOf(el: ExcalidrawElement, kind: BoardDiffKind, textOf: (id: string) => string | undefined): string {
  const verb = kind === 'ins' ? '新增' : kind === 'del' ? '删除' : '修改';
  const text = (el.type === 'text' ? el.text : textOf(el.id))?.trim();
  const name = TYPE_LABEL[el.type] ?? '元素';
  return text ? `${verb}${name}：${text.length > 24 ? `${text.slice(0, 24)}…` : text}` : `${verb}${name}`;
}

export function diffBoards(base: ExcalidrawScene | null, target: ExcalidrawScene): BoardDiffResult {
  const next = live(target);
  const files: Record<string, ExcalidrawFileData> = { ...(base?.files ?? {}), ...(target.files ?? {}) };
  if (!base) return { elements: next, files: target.files ?? {}, changes: [] };
  const prev = live(base);
  const oldById = new Map(prev.map((e) => [e.id, e]));
  const newById = new Map(next.map((e) => [e.id, e]));
  const kinds = new Map<string, BoardDiffKind>();
  for (const el of next) {
    const old = oldById.get(el.id);
    if (!old) kinds.set(el.id, 'ins');
    else if (key(old) !== key(el)) kinds.set(el.id, 'mod');
  }
  for (const el of prev) if (!newById.has(el.id)) kinds.set(el.id, 'del');

  // 绑定文字并入容器
  const containerOf = (id: string): string | null => {
    const el = newById.get(id) ?? oldById.get(id);
    const c = el?.containerId;
    return typeof c === 'string' && (newById.has(c) || oldById.has(c)) ? c : null;
  };
  for (const [id, kind] of [...kinds]) {
    const c = containerOf(id);
    if (!c) continue;
    kinds.delete(id);
    if (!kinds.has(c)) kinds.set(c, kind === 'ins' || kind === 'del' ? 'mod' : kind);
  }
  const boundText = (id: string): string | undefined => {
    const all = [...next, ...prev];
    return all.find((e) => e.type === 'text' && e.containerId === id)?.text as string | undefined;
  };

  // 删除元素的幽灵副本（容器的绑定文字一并复制）
  const ghosts: ExcalidrawElement[] = [];
  const ghostOf = (el: ExcalidrawElement): ExcalidrawElement => ({
    ...el,
    id: `${el.id}${GHOST_SUFFIX}`,
    opacity: Math.round((el.opacity ?? 100) * 0.35),
    locked: true,
    groupIds: [],
    frameId: null,
    boundElements: null as unknown as unknown[],
    containerId: null,
  });
  for (const el of prev) {
    if (newById.has(el.id)) continue;
    const c = typeof el.containerId === 'string' ? el.containerId : null;
    // 容器仍存在、只删了绑定文字：文字不单独显示幽灵（容器已标记修改）
    if (c && newById.has(c)) continue;
    ghosts.push(ghostOf(el));
  }

  const changes: BoardChange[] = [];
  for (const [id, kind] of kinds) {
    const el = kind === 'del' ? oldById.get(id) : newById.get(id);
    if (!el) continue;
    changes.push({
      id: kind === 'del' ? `${id}${GHOST_SUFFIX}` : id,
      kind,
      label: labelOf(el, kind, boundText),
      bounds: boundsOf(el),
    });
  }
  changes.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  return { elements: [...next, ...ghosts], files, changes };
}
