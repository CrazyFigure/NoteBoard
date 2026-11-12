// 大选区性能：全选长文档后，选区变化与切换标签都不再随文档长度线性卡顿
//
// 1. React 提交时的选区追踪（全选卡顿主因）
//    React DOM 每次提交（commit）前，只要焦点所在元素的 contentEditable 为 "true"，就会从该元素根部
//    逐个遍历全部 DOM 节点、累加文字长度来计算选区的字符偏移（getSelectionInformation），提交后
//    焦点若被抢走再按偏移还原选区。焦点停在 ProseMirror 根节点上时，应用里任何组件的任何一次提交
//    都要遍历整篇正文；全选会让大量节点视图同时更新、触发多次提交，长文档实测单次全选卡数秒。
//    ProseMirror 自己维护选区，聚焦时会按编辑器状态重设 DOM 选区，React 这份按字符偏移的还原
//    对它既无必要、也不准确。因此只在编辑器根节点实例上让 contentEditable 读取值不再是 "true"，
//    React 便跳过偏移计算（焦点还原逻辑不受影响）；可编辑性由 contenteditable 属性决定，
//    浏览器编辑行为、isContentEditable 与 ProseMirror 均不读取根节点的这个属性。
//
// 2. 隐藏标签时的原生选区（切换标签卡顿主因）
//    保活标签以 visibility: hidden 隐藏（可继承属性，整棵子树都要重算样式）。原生选区覆盖全文时，
//    选中范围内的每个元素都要额外计算 ::selection 高亮样式（15 万字文档实测切走时重算的元素
//    从约 0.8 万增至 6.7 万）。
//    切走前清掉落在该编辑器内的原生选区即可；ProseMirror 选区与整块底板装饰仍保留，
//    重新聚焦时 ProseMirror 会按状态恢复原生选区。

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * 让 React 提交时不再遍历该元素追踪选区。
 * 返回撤销函数，恢复为原型上的原生属性。
 */
export function bypassReactSelectionTracking(element: HTMLElement): () => void {
  // 调用时读取原型上的原生访问器；运行环境未实现该属性（如 jsdom）时不做处理
  const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'contentEditable');
  const getNative = native?.get;
  const setNative = native?.set;
  if (!getNative || !setNative) return () => {};
  Object.defineProperty(element, 'contentEditable', {
    configurable: true,
    enumerable: true,
    // React 只认 "true"：可编辑时报告为等价的继承语义，其余取值原样返回
    get(this: HTMLElement) {
      const value = getNative.call(this) as string;
      return value === 'true' ? 'inherit' : value;
    },
    // 赋值仍走原生实现，保证 contenteditable 属性照常切换
    set(this: HTMLElement, value: string) {
      setNative.call(this, value);
    },
  });
  return () => {
    delete (element as unknown as Record<string, unknown>).contentEditable;
  };
}

/**
 * 原生选区覆盖了 root 内的内容（非折叠）时清除它，返回是否清除。
 * 只要选区任一端点落在 root 内即视为属于该编辑器。
 */
export function releaseNativeSelectionWithin(root: Node): boolean {
  const selection = root.ownerDocument?.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  const inside = (anchorNode && root.contains(anchorNode)) || (focusNode && root.contains(focusNode));
  if (!inside) return false;
  selection.removeAllRanges();
  return true;
}

const reactSelectionTrackingKey = new PluginKey('nbReactSelectionTracking');

/** 编辑器视图创建时为根节点关闭 React 的选区追踪，销毁时恢复 */
export const ReactSelectionTrackingBypass = Extension.create({
  name: 'nbReactSelectionTrackingBypass',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: reactSelectionTrackingKey,
        view(view) {
          const restore = bypassReactSelectionTracking(view.dom);
          return { destroy: restore };
        },
      }),
    ];
  },
});
