// 当前用户已共享出去的路径，供资源管理器显示共享标记、共享对话框与“我的共享”列表复用。
import { create } from 'zustand';
import { accountApi, type ShareInfo } from './accountApi';
import { isMultiUser } from './accountState';

interface ShareStore {
  shares: ShareInfo[];
  /** 路径 → 共享，资源管理器逐节点查找 */
  byPath: Map<string, ShareInfo>;
  loaded: boolean;
  /** 共享对话框当前目标路径；null 为关闭 */
  dialogPath: string | null;
  refresh: () => Promise<void>;
  openDialog: (path: string) => void;
  closeDialog: () => void;
}

export const useShareStore = create<ShareStore>((set) => ({
  shares: [],
  byPath: new Map(),
  loaded: false,
  dialogPath: null,
  refresh: async () => {
    if (!isMultiUser()) return;
    const shares = await accountApi.listMine();
    set({ shares, byPath: new Map(shares.map((share) => [share.path, share])), loaded: true });
  },
  openDialog: (path) => set({ dialogPath: path }),
  closeDialog: () => set({ dialogPath: null }),
}));

/** 共享对象的简短描述，用于 Tooltip 与列表元信息。 */
export function describeGrants(share: ShareInfo): string {
  if (share.grants.some((grant) => grant.userId === '*')) return '已共享给所有用户';
  return `已共享给 ${share.grants.length} 人`;
}
