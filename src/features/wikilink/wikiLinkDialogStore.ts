// NoteBoard 双链编辑弹窗 Store
// 以 Promise 形式打开「插入 / 编辑双向链接」弹窗：选笔记、选标题、填显示名、切换链接 / 嵌入，
// 不需要记忆 `[[笔记#标题|显示名]]`、`![[...]]` 语法。由 WikiLinkDialogHost 统一渲染（桌面与移动端外壳各挂载一份）。

import { create } from 'zustand';

export interface WikiLinkDialogOptions {
  /** insert：插入新链接；edit：编辑已有链接（显示删除与打开按钮） */
  mode: 'insert' | 'edit';
  /** 链接所在文档（解析相对路径、同名优先级） */
  docKey: string;
  /** 已有链接的内部文字（编辑时）或预填的目标 */
  inner?: string;
  /** 是否为嵌入 */
  embed?: boolean;
  /** 插入时预填的显示名（例如当前选中的文字） */
  alias?: string;
}

export type WikiLinkDialogResult =
  | { action: 'confirm'; inner: string; embed: boolean }
  | { action: 'remove' }
  /** 编辑弹窗中点了「打开笔记」 */
  | { action: 'open'; inner: string };

interface WikiLinkDialogRequest extends WikiLinkDialogOptions {
  id: number;
  resolve: (result: WikiLinkDialogResult | null) => void;
}

interface WikiLinkDialogStore {
  request: WikiLinkDialogRequest | null;
  open: (options: WikiLinkDialogOptions) => Promise<WikiLinkDialogResult | null>;
  /** 结束当前弹窗：取消传 null */
  settle: (result: WikiLinkDialogResult | null) => void;
}

let seq = 0;

export const useWikiLinkDialogStore = create<WikiLinkDialogStore>((set, get) => ({
  request: null,
  open: (options) =>
    new Promise((resolve) => {
      // 同一时间只保留一个弹窗：新请求顶替旧请求，旧请求按取消处理
      get().request?.resolve(null);
      set({ request: { ...options, id: ++seq, resolve } });
    }),
  settle: (result) => {
    const current = get().request;
    if (!current) return;
    set({ request: null });
    current.resolve(result);
  },
}));

/** 打开双链弹窗；取消返回 null */
export const openWikiLinkDialog = (options: WikiLinkDialogOptions): Promise<WikiLinkDialogResult | null> =>
  useWikiLinkDialogStore.getState().open(options);
