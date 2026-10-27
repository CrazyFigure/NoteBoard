// 网页多用户的当前账号状态：由网页运行时启动时写入，组件同步读取；原生端始终为空。

/** 多用户部署中的当前登录账号。 */
export interface WebAccount {
  username: string;
  role: 'admin' | 'user';
}

/** 每个用户拥有自己的 /workspace，接收的共享位于该虚拟根目录下。 */
export const SHARED_ROOT = '/shared';

let account: WebAccount | null = null;

/** 仅网页运行时调用；公开部署传入 null。 */
export function setWebAccount(value: WebAccount | null): void {
  account = value;
}

/** 当前登录账号；原生端与公开部署返回 null。 */
export function getWebAccount(): WebAccount | null {
  return account;
}

/** 部署启用了管理员账号即进入多用户模式。 */
export function isMultiUser(): boolean {
  return !!account;
}

export function isAdmin(): boolean {
  return account?.role === 'admin';
}

/** 插件与字体包按实例共享：公开部署与管理员可管理，普通用户只能使用。 */
export function canManageInstance(): boolean {
  return !account || account.role === 'admin';
}

/** 路径位于“共享给我”虚拟根目录内。 */
export function isSharedPath(path: string | null | undefined): boolean {
  return !!account && !!path && (path === SHARED_ROOT || path.startsWith(`${SHARED_ROOT}/`));
}
