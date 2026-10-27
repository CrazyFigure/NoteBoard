// 网页多用户命令封装：账号、用户管理与共享授权。只在网页多用户模式下调用。
import { invoke } from '@tauri-apps/api/core';

export type SharePermission = 'read' | 'edit';

/** 管理员看到的普通用户信息（不含密码哈希）。 */
export interface ManagedUser {
  id: string;
  username: string;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** 与部署配置的管理员账号同名，无法登录 */
  conflict: boolean;
}

/** 共享对象：userId 为 '*' 表示所有用户。 */
export interface ShareGrant {
  userId: string;
  permission: SharePermission;
  username?: string | null;
}

export interface ShareInfo {
  id: string;
  path: string;
  createdAt: number;
  grants: ShareGrant[];
  /** 目标已被移走或删除 */
  missing?: boolean;
  isDir?: boolean;
}

export interface ShareTarget {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export const ALL_USERS = '*';

export const accountApi = {
  changePassword: (oldPassword: string, newPassword: string) => invoke<null>('account_change_password', { oldPassword, newPassword }),
  logoutOthers: () => invoke<null>('account_logout_others'),
  listUsers: () => invoke<ManagedUser[]>('users_list'),
  createUser: (username: string, password: string) => invoke<ManagedUser>('users_create', { username, password }),
  setDisabled: (id: string, disabled: boolean) => invoke<ManagedUser>('users_set_disabled', { id, disabled }),
  resetPassword: (id: string, password: string) => invoke<ManagedUser>('users_reset_password', { id, password }),
  deleteUser: (id: string) => invoke<null>('users_delete', { id }),
  shareTargets: () => invoke<ShareTarget[]>('share_targets'),
  getShare: (path: string) => invoke<ShareInfo | null>('share_get', { path }),
  setShare: (path: string, grants: ShareGrant[]) => invoke<ShareInfo | null>('share_set', { path, grants: grants.map(({ userId, permission }) => ({ userId, permission })) }),
  removeShare: (id: string) => invoke<null>('share_remove', { id }),
  listMine: () => invoke<ShareInfo[]>('share_list_mine'),
};

/** 退出登录：服务端吊销会话并清除 Cookie，随后进入登录页。 */
export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-NoteBoard-Request': '1' } }).catch(() => undefined);
  location.assign('/login');
}

/** 生成易读的随机初始密码：去掉易混淆字符，长度 12。 */
export function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte % alphabet.length]).join('');
}

/** 统一把调用异常转换为可读文案。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '操作失败';
}
