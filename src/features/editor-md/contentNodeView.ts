// NoteBoard 带可编辑内容的 React 节点视图
// 背景：Tiptap 的 NodeView.ignoreMutation 在 Android / iOS 且编辑器聚焦时有一条特判——节点视图"外壳"
// （contentDOM 之外的区域）中出现新增可编辑元素的 childList 变动时不忽略，交给 ProseMirror 处理。
// React 节点视图挂载时恰好会把 NodeViewWrapper 与 contentDOM 插入外壳，ProseMirror 于是认为 DOM 被修改，
// 把整个节点标记为需重建 → 新节点视图挂载再次产生同样的变动 → 在 MutationObserver 微任务里无限循环，
// 主线程永不让出，整个应用卡死（移动端插入分栏、折叠块、高亮块等时必现或易现）。
// 处理：外壳内的变动一律由 React 自己管理（与桌面端行为一致），只有 contentDOM 内部的变动交给 ProseMirror。

import type { ComponentType } from 'react';
import type { NodeViewRenderer } from '@tiptap/core';
import {
  ReactNodeView,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
  type ReactNodeViewRendererOptions,
} from '@tiptap/react';

type ViewMutation = MutationRecord | { type: 'selection'; target: Node };

/**
 * 创建带可编辑内容（NodeViewContent）的 React 节点视图，去掉会导致移动端死循环的变动特判。
 * 用法与 ReactNodeViewRenderer 相同；无内容的原子节点视图无需使用。
 */
export function contentReactNodeViewRenderer<T = HTMLElement>(
  component: ComponentType<ReactNodeViewProps<T>>,
  options?: Partial<ReactNodeViewRendererOptions>,
): NodeViewRenderer {
  const create = ReactNodeViewRenderer(component, options);
  return (props) => {
    const view = create(props);
    // 编辑器尚未挂载 React 内容组件时返回空对象，无需处理
    if (!(view instanceof ReactNodeView)) return view;
    view.ignoreMutation = (mutation: ViewMutation) => {
      const { contentDOM } = view;
      if (!view.dom || !contentDOM) return true;
      // 选区变化始终交给 ProseMirror
      if (mutation.type === 'selection') return false;
      // contentDOM 自身的属性变化由节点视图管理
      if (mutation.target === contentDOM && mutation.type === 'attributes') return true;
      // 只有内容区内部的变动才代表用户编辑
      return !contentDOM.contains(mutation.target);
    };
    return view;
  };
}
