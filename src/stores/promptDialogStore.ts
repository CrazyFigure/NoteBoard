// NoteBoard 全局输入弹窗 Store
// 以 Promise 形式替代浏览器原生 window.prompt：样式跟随主题、支持移动端，且不阻塞主线程
// 由 components/PromptDialogHost 统一渲染，桌面端与移动端 Shell 各挂载一份

import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface PromptOptions {
  /** 弹窗标题 */
  title: string;
  /** 标题下方的补充说明 */
  description?: ReactNode;
  /** 标题左侧图标，缺省为通用编辑图标 */
  icon?: ReactNode;
  /** 输入框初始值 */
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** 允许提交空值（如「留空即移除链接」）；默认空值时确认按钮不可用 */
  allowEmpty?: boolean;
  /** 自定义校验：返回错误文案则阻止提交 */
  validate?: (value: string) => string | null;
  /** 在输入框下方实时预览图片地址 */
  previewImage?: boolean;
  /** 纯确认弹窗：不显示输入框，确认时返回空字符串 */
  confirmOnly?: boolean;
}

interface PromptRequest extends PromptOptions {
  id: number;
  resolve: (value: string | null) => void;
}

interface PromptDialogStore {
  request: PromptRequest | null;
  open: (options: PromptOptions) => Promise<string | null>;
  /** 结束当前弹窗：确认传入值，取消传 null */
  settle: (value: string | null) => void;
}

let seq = 0;

export const usePromptDialogStore = create<PromptDialogStore>((set, get) => ({
  request: null,
  open: (options) =>
    new Promise<string | null>((resolve) => {
      // 同一时间只保留一个输入弹窗：新请求顶替旧请求，旧请求按取消处理
      get().request?.resolve(null);
      set({ request: { ...options, id: ++seq, resolve } });
    }),
  settle: (value) => {
    const current = get().request;
    if (!current) return;
    set({ request: null });
    current.resolve(value);
  },
}));

/**
 * 打开主题化输入弹窗
 * @returns 确认时返回去除首尾空白的输入值；取消返回 null
 */
export const showPrompt = (options: PromptOptions): Promise<string | null> =>
  usePromptDialogStore.getState().open(options);

/**
 * 打开主题化确认弹窗（与输入弹窗同一外观）
 * @returns 确认返回 true，取消返回 false
 */
export const showConfirm = async (options: Omit<PromptOptions, 'confirmOnly' | 'allowEmpty'>): Promise<boolean> =>
  (await usePromptDialogStore.getState().open({ ...options, confirmOnly: true, allowEmpty: true })) !== null;
