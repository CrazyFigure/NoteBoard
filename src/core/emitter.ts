// NoteBoard 强类型事件总线
// 基于 mitt，加上 TS 类型约束
// 用于组件间松耦合通信

import mitt from 'mitt';

// ── 事件类型 ──

export type AppEvents = {
  // 主题变化
  'theme-changed': { theme: string };
  // tab 切换
  'tab-activated': { key: string };
  // 文档脏态变化
  'document-dirty': { key: string; isDirty: boolean };
  // 面板可见性变化
  'panel-toggled': { panel: 'explorer' | 'outline'; visible: boolean };
  // 编辑器模式切换
  'view-mode-changed': { key: string; mode: 'visual' | 'source' };
  // 请求切换 Markdown 编辑器模式（可视化 / 源码）
  'toggle-md-view-mode': { key?: string; mode?: 'visual' | 'source' };
  // 请求唤起超链接插入/编辑弹窗
  'open-link-modal': { key?: string };
  // mitt 要求的索引签名
  [key: string]: unknown;
};

// ── 创建事件总线 ──

export const emitter = mitt<AppEvents>();

// 便捷封装
export function on<K extends keyof AppEvents>(
  type: K,
  handler: (payload: AppEvents[K]) => void,
): void {
  emitter.on(type, handler);
}

export function off<K extends keyof AppEvents>(
  type: K,
  handler: (payload: AppEvents[K]) => void,
): void {
  emitter.off(type, handler);
}

export function emit<K extends keyof AppEvents>(type: K, payload: AppEvents[K]): void {
  emitter.emit(type, payload);
}
