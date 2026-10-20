// NoteBoard 收藏夹数据操作纯函数工具库
// 负责树形结构查找、扁平化、节点移动与防循环嵌套校验

import type {
  FavoriteNode,
  FavoriteFolderItem,
  FavoriteFileItem,
} from '../../core/ipc/types';
import { pathKey, dirnameOf, isSubPath } from '../explorer/pathUtils';

/**
 * 递归深拷贝节点树，避免意外的状态共享与就地修改
 */
export function cloneRoots(roots: FavoriteNode[]): FavoriteNode[] {
  return JSON.parse(JSON.stringify(roots));
}

/**
 * 按 ID 递归查找任意节点（文件或文件夹）
 */
export function findNodeById(roots: FavoriteNode[], id: string): FavoriteNode | null {
  for (const node of roots) {
    if (node.id === id) return node;
    if (node.type === 'folder' && node.children) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 按 ID 递归查找文件夹节点
 */
export function findFolderById(roots: FavoriteNode[], id: string): FavoriteFolderItem | null {
  const node = findNodeById(roots, id);
  if (node && node.type === 'folder') {
    return node as FavoriteFolderItem;
  }
  return null;
}

/**
 * 查找某个节点的父级文件夹；若该节点处于顶层 roots，则返回 null
 */
export function findParentFolder(
  roots: FavoriteNode[],
  targetId: string,
  currentParent: FavoriteFolderItem | null = null,
): FavoriteFolderItem | null {
  for (const node of roots) {
    if (node.id === targetId) {
      return currentParent;
    }
    if (node.type === 'folder' && node.children) {
      const found = findParentFolder(node.children, targetId, node as FavoriteFolderItem);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 按文件绝对路径查找是否已收藏（Windows 下不区分大小写比较）
 */
export function findFavoriteByPath(roots: FavoriteNode[], filePath: string): FavoriteFileItem | null {
  // 收藏身份与打开文档一致，Linux / 网页工作区按大小写区分文件。
  const normalizedTarget = pathKey(filePath);
  for (const node of roots) {
    if (node.type === 'file') {
      if (pathKey(node.path) === normalizedTarget) {
        return node as FavoriteFileItem;
      }
    } else if (node.type === 'folder' && node.children) {
      const found = findFavoriteByPath(node.children, filePath);
      if (found) return found;
    }
  }
  return null;
}

export interface FolderOption {
  id: string;
  name: string;
  pathName: string;
  depth: number;
}

/**
 * 获取所有文件夹的层级扁平列表，方便在下拉菜单中展示（如“根目录”、“根目录 / 工作 / 项目”）
 */
export function getAllFolders(
  roots: FavoriteNode[],
  parentPath = '',
  depth = 0,
): FolderOption[] {
  const result: FolderOption[] = [];
  if (depth === 0) {
    result.push({
      id: 'root',
      name: '根目录',
      pathName: '根目录',
      depth: 0,
    });
  }
  for (const node of roots) {
    if (node.type === 'folder') {
      const currentPath = parentPath ? `${parentPath} / ${node.name}` : `根目录 / ${node.name}`;
      result.push({
        id: node.id,
        name: node.name,
        pathName: currentPath,
        depth: depth + 1,
      });
      if (node.children && node.children.length > 0) {
        result.push(...getAllFolders(node.children, currentPath, depth + 1));
      }
    }
  }
  return result;
}

/**
 * 判断 maybeChildId 是否为 folderId 本身或其子孙文件夹（防止将父文件夹拖拽至其子目录下死循环）
 */
export function isDescendantOrSelf(roots: FavoriteNode[], folderId: string, maybeChildId: string): boolean {
  if (folderId === 'root') return false;
  if (folderId === maybeChildId) return true;
  const folder = findFolderById(roots, folderId);
  if (!folder || !folder.children) return false;

  function checkSub(children: FavoriteNode[]): boolean {
    for (const child of children) {
      if (child.id === maybeChildId) return true;
      if (child.type === 'folder' && child.children) {
        if (checkSub(child.children)) return true;
      }
    }
    return false;
  }

  return checkSub(folder.children);
}

/**
 * 向指定文件夹内追加或插入一个节点（若 folderId 为 'root' 或空则放入根列表）
 */
export function addNodeToFolder(
  roots: FavoriteNode[],
  folderId: string,
  node: FavoriteNode,
  targetIndex?: number,
): FavoriteNode[] {
  const newRoots = cloneRoots(roots);
  if (!folderId || folderId === 'root') {
    if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= newRoots.length) {
      newRoots.splice(targetIndex, 0, node);
    } else {
      newRoots.push(node);
    }
    return newRoots;
  }

  const targetFolder = findFolderById(newRoots, folderId);
  if (!targetFolder) {
    // 找不到目标文件夹时默认放入根目录
    newRoots.push(node);
    return newRoots;
  }

  if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= targetFolder.children.length) {
    targetFolder.children.splice(targetIndex, 0, node);
  } else {
    targetFolder.children.push(node);
  }
  return newRoots;
}

/**
 * 按 ID 从树中移除指定节点，返回新的根列表及被移除的节点对象
 */
export function removeNodeById(
  roots: FavoriteNode[],
  targetId: string,
): { newRoots: FavoriteNode[]; removedNode: FavoriteNode | null } {
  const newRoots = cloneRoots(roots);
  let removedNode: FavoriteNode | null = null;

  function removeFromList(list: FavoriteNode[]): boolean {
    const index = list.findIndex((n) => n.id === targetId);
    if (index !== -1) {
      removedNode = list.splice(index, 1)[0];
      return true;
    }
    for (const item of list) {
      if (item.type === 'folder' && item.children) {
        if (removeFromList(item.children)) return true;
      }
    }
    return false;
  }

  removeFromList(newRoots);
  return { newRoots, removedNode };
}

/**
 * 移动节点到目标文件夹，可指定插入索引；若存在循环引用则拒绝移动
 */
export function moveNode(
  roots: FavoriteNode[],
  sourceId: string,
  targetFolderId: string,
  targetIndex?: number,
): FavoriteNode[] {
  // 校验循环嵌套：禁止将文件夹移入自身或自身子目录下
  if (isDescendantOrSelf(roots, sourceId, targetFolderId)) {
    return roots;
  }

  // 1. 从原位置移除
  const { newRoots, removedNode } = removeNodeById(roots, sourceId);
  if (!removedNode) return roots;

  // 2. 插入到新目标文件夹（若 targetFolderId 为 'root' 则插入到顶层）
  return addNodeToFolder(newRoots, targetFolderId, removedNode, targetIndex);
}

/**
 * 把节点移动到参照节点的前面或后面（参照节点所在层级即目标层级），用于列表拖拽排序
 */
export function moveNodeRelative(
  roots: FavoriteNode[],
  sourceId: string,
  referenceId: string,
  position: 'before' | 'after',
): FavoriteNode[] {
  if (sourceId === referenceId) return roots;
  const parent = findParentFolder(roots, referenceId);
  const targetFolderId = parent ? parent.id : 'root';
  // 校验循环嵌套：参照节点不能位于被拖动文件夹的内部
  if (isDescendantOrSelf(roots, sourceId, targetFolderId)) {
    return roots;
  }

  const { newRoots, removedNode } = removeNodeById(roots, sourceId);
  if (!removedNode) return roots;

  // 必须在移除源节点之后再取参照索引，同层后移时索引才不会偏移
  const siblings = targetFolderId === 'root'
    ? newRoots
    : findFolderById(newRoots, targetFolderId)?.children;
  if (!siblings) return roots;
  const refIndex = siblings.findIndex((n) => n.id === referenceId);
  if (refIndex < 0) return roots;
  siblings.splice(position === 'before' ? refIndex : refIndex + 1, 0, removedNode);
  return newRoots;
}

/**
 * 收集文件夹内（含子孙）所有收藏文件的路径
 */
function collectFilePaths(nodes: FavoriteNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.path) out.push(node.path);
    } else if (node.children) {
      collectFilePaths(node.children, out);
    }
  }
  return out;
}

/**
 * 计算收藏文件夹对应的磁盘目录：其下所有文件的最近公共父目录；无文件或跨盘符时返回 null
 */
export function getFolderCommonDir(folder: FavoriteFolderItem): string | null {
  const paths = collectFilePaths(folder.children || []);
  if (paths.length === 0) return null;

  let common = dirnameOf(paths[0]);
  for (const p of paths.slice(1)) {
    // 逐级向上收缩，直到公共目录包含当前文件
    while (common && !isSubPath(common, p)) {
      const parent = dirnameOf(common);
      // 已到根目录仍不包含（如跨盘符），视为没有公共目录
      if (!parent || parent === common) return null;
      common = parent;
    }
    if (!common) return null;
  }
  return common || null;
}

/**
 * 在整个收藏夹中搜索匹配的文件项
 */
export function searchFavorites(roots: FavoriteNode[], query: string): FavoriteFileItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: FavoriteFileItem[] = [];

  function traverse(list: FavoriteNode[]) {
    for (const node of list) {
      if (node.type === 'file') {
        if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
          results.push(node as FavoriteFileItem);
        }
      } else if (node.type === 'folder' && node.children) {
        traverse(node.children);
      }
    }
  }

  traverse(roots);
  return results;
}
