// NoteBoard 资源管理器路径工具函数
// 统一路径规范化、相对路径链计算与父子路径判断
// Windows：单反斜杠分隔、大小写不敏感（盘符根目录保留反斜杠如 C:\）
// Android 等 POSIX 平台：正斜杠分隔、大小写敏感（根目录为 /）

import { USES_WINDOWS_PATHS } from '../../core/platform';

/** 当前平台的路径分隔符 */
export const PATH_SEP = USES_WINDOWS_PATHS ? '\\' : '/';

/**
 * 规范化文件或目录路径
 * Windows：统一替换为标准单反斜杠，去除首尾空白及末尾反斜杠（盘符根目录保留反斜杠如 C:\）
 * POSIX：合并重复斜杠，去除末尾斜杠（根目录保留 /）
 */
export function normalizePath(p: string | null | undefined): string {
  if (!p) return '';
  if (!USES_WINDOWS_PATHS) {
    const norm = p.trim().replace(/\/+/g, '/');
    if (norm === '/') return norm;
    return norm.replace(/\/+$/, '');
  }
  let norm = p.trim().replace(/[/\\]+/g, '\\');
  // 盘符根目录特殊处理 (如 "C:" 或 "C:\") -> "C:\"
  if (/^[A-Za-z]:\\?$/.test(norm)) {
    return norm.substring(0, 2) + '\\';
  }
  // 去除末尾的单反斜杠
  norm = norm.replace(/\\+$/, '');
  return norm;
}

/**
 * 路径比较键：Windows 转小写（大小写不敏感），POSIX 保持原样
 */
export function pathKey(p: string | null | undefined): string {
  const norm = normalizePath(p);
  return USES_WINDOWS_PATHS ? norm.toLowerCase() : norm;
}

/**
 * 路径等价比较（Windows 大小写不敏感，POSIX 严格相等）
 */
export function sameKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null && b === null) return true;
  if (a === undefined && b === undefined) return true;
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

/**
 * 判断 child 是否与 parent 相等或是 parent 的子路径
 */
export function isSubPath(parent: string | null | undefined, child: string | null | undefined): boolean {
  if (!parent || !child) return false;
  const lowerParent = pathKey(parent);
  const lowerChild = pathKey(child);
  if (!lowerParent || !lowerChild) return false;

  // 相同路径视为包含
  if (lowerParent === lowerChild) return true;

  // 根目录情况 (如 "C:\" 或 "/")
  if (lowerParent.endsWith(PATH_SEP)) {
    return lowerChild.startsWith(lowerParent);
  }

  // 常规目录前缀包含判断 (要求紧接分隔符，避免 C:\foo 匹配 C:\foobar)
  return lowerChild.startsWith(lowerParent + PATH_SEP);
}

/**
 * 计算从 rootDir 到 targetPath 之间所有需要展开的父级目录绝对路径列表
 * 例如 rootDir = "C:\app", targetPath = "C:\app\src\ui\Button.tsx"
 * 返回: ["C:\app\src", "C:\app\src\ui"]
 */
export function getPathChain(rootDir: string, targetPath: string): string[] {
  const normRoot = normalizePath(rootDir);
  const normTarget = normalizePath(targetPath);
  if (!normRoot || !normTarget) return [];
  if (!isSubPath(normRoot, normTarget)) return [];

  // 获取 target 所在父目录
  const lastSlashIndex = normTarget.lastIndexOf(PATH_SEP);
  if (lastSlashIndex < 0) return [];
  const targetDir = normTarget.substring(0, lastSlashIndex);

  // 若父目录就是根目录，无需展开任何子级目录
  if (sameKey(normRoot, targetDir) || sameKey(normRoot, normTarget)) {
    return [];
  }

  // 提取相对路径部分并逐级累加生成路径链
  const rel = normTarget.substring(normRoot.length).split(PATH_SEP).filter(Boolean);
  // 排除最后一个元素（如果是文件或目标本身）
  rel.pop();

  const chain: string[] = [];
  let current = normRoot.endsWith(PATH_SEP) ? normRoot.substring(0, normRoot.length - 1) : normRoot;

  for (const part of rel) {
    current = current + PATH_SEP + part;
    chain.push(current);
  }

  return chain;
}

/** 拼接目录与名称（自动处理目录末尾分隔符） */
export function joinPath(dir: string, name: string): string {
  const norm = normalizePath(dir);
  if (!norm) return name;
  return norm.endsWith(PATH_SEP) ? norm + name : norm + PATH_SEP + name;
}

/** 取父目录（根目录返回自身） */
export function dirnameOf(p: string): string {
  const norm = normalizePath(p);
  const index = norm.lastIndexOf(PATH_SEP);
  if (index < 0) return '';
  if (index === 0) return PATH_SEP;
  // Windows 盘符根：C:\foo → C:\
  if (USES_WINDOWS_PATHS && index === 2 && norm[1] === ':') return norm.substring(0, 3);
  return norm.substring(0, index);
}

/** 取文件名（兼容两种分隔符） */
export function basenameOf(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
