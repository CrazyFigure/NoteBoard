// NoteBoard 资源管理器路径工具函数
// 统一 Windows 路径规范化、相对路径链计算与父子路径判断

/**
 * 规范化文件或目录路径
 * 统一替换为标准 Windows 单反斜杠，去除首尾空白及末尾反斜杠（盘符根目录保留反斜杠如 C:\）
 */
export function normalizePath(p: string | null | undefined): string {
  if (!p) return '';
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
 * 路径大小写不敏感等价比较
 */
export function sameKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null && b === null) return true;
  if (a === undefined && b === undefined) return true;
  if (!a || !b) return false;
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/**
 * 判断 child 是否与 parent 相等或是 parent 的子路径
 */
export function isSubPath(parent: string | null | undefined, child: string | null | undefined): boolean {
  if (!parent || !child) return false;
  const normParent = normalizePath(parent);
  const normChild = normalizePath(child);
  if (!normParent || !normChild) return false;

  const lowerParent = normParent.toLowerCase();
  const lowerChild = normChild.toLowerCase();

  // 相同路径视为包含
  if (lowerParent === lowerChild) return true;

  // 盘符根目录情况 (如 "C:\")
  if (lowerParent.endsWith('\\')) {
    return lowerChild.startsWith(lowerParent);
  }

  // 常规目录前缀包含判断 (要求紧接反斜杠，避免 C:\foo 匹配 C:\foobar)
  return lowerChild.startsWith(lowerParent + '\\');
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
  const lastSlashIndex = normTarget.lastIndexOf('\\');
  if (lastSlashIndex < 0) return [];
  const targetDir = normTarget.substring(0, lastSlashIndex);

  // 若父目录就是根目录，无需展开任何子级目录
  if (sameKey(normRoot, targetDir) || sameKey(normRoot, normTarget)) {
    return [];
  }

  // 提取相对路径部分并逐级累加生成路径链
  const rel = normTarget.substring(normRoot.length).replace(/^\\+/, '');
  const parts = rel.split('\\').filter(Boolean);
  // 排除最后一个元素（如果是文件或目标本身）
  parts.pop();

  const chain: string[] = [];
  let current = normRoot.endsWith('\\') ? normRoot.substring(0, normRoot.length - 1) : normRoot;

  for (const part of parts) {
    current = current + '\\' + part;
    chain.push(current);
  }

  return chain;
}
