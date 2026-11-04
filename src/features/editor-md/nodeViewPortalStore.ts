// React 节点视图门户的登记表：替换 @tiptap/react 自带实现中的平方复杂度。
//
// 官方 EditorContent 为每个编辑器创建一个登记表（contentComponent），每个 React 节点视图挂载时
// setRenderer 都执行 `renderers = { ...renderers, [id]: portal }`，复制整张表：N 个节点视图共复制 N²/2 次
// （50 万字符的文档约 1 万个节点视图，仅此一项约 2 秒）。这里改为可变 Map 登记，React 读取快照时才生成
// 新对象（订阅通知本就按微任务合并，每批只生成一次），对外行为、键顺序与通知时机与官方实现一致。
//
// 只在官方登记表的接口与当前版本完全一致时替换；接口有变化（升级 TipTap 后）则保留官方实现，不会静默出错。
import type { Editor } from '@tiptap/core';
import type { ReactNode, ReactPortal } from 'react';
import { createPortal } from 'react-dom';

/** 与 @tiptap/react 3.x 的 ContentComponent 一致的接口 */
interface ContentComponent {
  subscribe(callback: () => void): () => void;
  getSnapshot(): Record<string, ReactPortal>;
  getServerSnapshot(): Record<string, ReactPortal>;
  setRenderer(id: string, renderer: { reactElement: ReactNode; element: Element }): void;
  removeRenderer(id: string): void;
}

const EXPECTED_KEYS = ['getServerSnapshot', 'getSnapshot', 'removeRenderer', 'setRenderer', 'subscribe'];

/** 官方登记表是否为已知接口（键集合完全一致且都是函数） */
function isKnownContentComponent(value: unknown): value is ContentComponent {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value).sort();
  return keys.length === EXPECTED_KEYS.length
    && keys.every((key, index) => key === EXPECTED_KEYS[index] && typeof (value as Record<string, unknown>)[key] === 'function');
}

/** 创建与官方行为一致、登记为 O(1) 的门户登记表 */
export function createNodeViewPortalStore(): ContentComponent {
  const subscribers = new Set<() => void>();
  const portals = new Map<string, ReactPortal>();
  let snapshot: Record<string, ReactPortal> = {};
  // 登记表有变化、快照尚未重建
  let stale = false;
  let isNotificationQueued = false;
  // 与官方一致：同一微任务内的多次变化只通知一次；无订阅者时不排队
  const notifySubscribers = () => {
    if (isNotificationQueued || !subscribers.size) return;
    isNotificationQueued = true;
    queueMicrotask(() => {
      isNotificationQueued = false;
      subscribers.forEach((subscriber) => subscriber());
    });
  };
  // React 会以未绑定方式调用 getSnapshot，不能依赖 this
  const getSnapshot = () => {
    if (stale) {
      // Map 保持插入顺序，重复登记同一 id 时位置不变，与对象展开的键顺序一致
      snapshot = Object.fromEntries(portals);
      stale = false;
    }
    return snapshot;
  };
  return {
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    getSnapshot,
    getServerSnapshot: getSnapshot,
    setRenderer(id, renderer) {
      portals.set(id, createPortal(renderer.reactElement, renderer.element, id));
      stale = true;
      notifySubscribers();
    },
    removeRenderer(id) {
      portals.delete(id);
      stale = true;
      notifySubscribers();
    },
  };
}

/**
 * 在编辑器创建时（onBeforeCreate，早于 EditorContent 挂载）接管 contentComponent 的赋值：
 * 官方创建登记表时换成 createNodeViewPortalStore，卸载时赋 null 照常生效。
 */
export function installNodeViewPortalStore({ editor }: { editor: Editor }): void {
  const target = editor as unknown as { contentComponent: unknown };
  let current: unknown = target.contentComponent;
  Object.defineProperty(target, 'contentComponent', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value: unknown) => {
      current = isKnownContentComponent(value) ? createNodeViewPortalStore() : value;
    },
  });
}
