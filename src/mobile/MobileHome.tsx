// NoteBoard 移动端首页
// 顶栏（品牌 + 设置）→ 分段（文件 / 收藏 / 已打开）→ 列表；右下角悬浮"新建"按钮。
// 文件：在"我的笔记"（应用私有工作区）与"手机存储"之间切换，面包屑逐级返回，长按条目弹出操作面板。

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  Braces,
  ChartColumn,
  ChevronRight,
  Database,
  FilePlus,
  FileText,
  FolderPlus,
  GitCompare,
  GitMerge,
  HardDrive,
  Import,
  Layout,
  Network,
  NotebookPen,
  PencilRuler,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Share2,
  ShieldAlert,
  Star,
  StarOff,
  Table2,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import type { FileTreeNode, FavoriteNode } from '../core/ipc/types';
import * as ipc from '../core/ipc/commands';
import { getExplorerFileIcon } from '../features/explorer/fileIcons';
import { basenameOf, isSubPath, pathKey, PATH_SEP } from '../features/explorer/pathUtils';
import { useFavoritesStore } from '../features/favorites/favoritesStore';
import {
  newBitable,
  newBoard,
  newDrawio,
  newInfographic,
  newJson,
  newMarkdown,
  newMermaid,
  newMindmap,
  newPlantUml,
  newSql,
  newText,
  newTextDiff,
} from '../features/welcome/welcomeActions';
import { useWindowStore } from '../stores/windowStore';
import { useLayoutStore } from '../stores/layoutStore';
import { showToast } from '../stores/toastStore';
import {
  ActionSheet,
  BottomSheet,
  ConfirmDialog,
  IconButton,
  PromptDialog,
  TopBar,
  useLongPress,
  type SheetAction,
} from './components';
import {
  createFolder,
  deleteEntry,
  importFiles,
  loadFolder,
  openEntry,
  openPathInEditor,
  refreshCurrentFolder,
  renameEntry,
  shareEntry,
  switchLocation,
  validateFileName,
} from './mobileFiles';
import { useMobileStore, type HomeSection } from './mobileStore';
import { SwipePager } from './SwipePager';

// ── 新建类型 ──

interface CreateItem {
  key: string;
  label: string;
  desc: string;
  icon: ReactNode;
  run: () => void;
}

const CREATE_ITEMS: CreateItem[] = [
  { key: 'md', label: 'Markdown 笔记', desc: '富文本与源码双模', icon: <FilePlus size={22} color="var(--editor-accent, #3b82f6)" />, run: newMarkdown },
  { key: 'txt', label: '文本文档', desc: '轻量纯文本', icon: <FileText size={22} color="#64748b" />, run: newText },
  { key: 'board', label: '自由画板', desc: 'Excalidraw 手绘', icon: <PencilRuler size={22} color="var(--accent-strong, #8b5cf6)" />, run: newBoard },
  { key: 'mindmap', label: '思维导图', desc: '大纲 ⇄ 脑图', icon: <Network size={22} color="#f97316" />, run: newMindmap },
  { key: 'bitable', label: '多维表格', desc: '表格 / 看板 / 甘特', icon: <Table2 size={22} color="#2563eb" />, run: newBitable },
  { key: 'drawio', label: 'Draw.io', desc: '架构与流程图（需联网）', icon: <Layout size={22} color="#ea580c" />, run: newDrawio },
  { key: 'mermaid', label: 'Mermaid', desc: '时序 / 流程图脚本', icon: <Workflow size={22} color="#00bfb2" />, run: newMermaid },
  { key: 'plantuml', label: 'PlantUML', desc: 'UML 建模（需联网）', icon: <GitMerge size={22} color="#a855f7" />, run: newPlantUml },
  { key: 'infographic', label: '信息图', desc: '看板 / 时间线', icon: <ChartColumn size={22} color="#14b8a6" />, run: newInfographic },
  { key: 'json', label: 'JSON', desc: '数据与配置', icon: <Braces size={22} color="#eab308" />, run: newJson },
  { key: 'sql', label: 'SQL', desc: '数据库脚本', icon: <Database size={22} color="#3b82f6" />, run: newSql },
  { key: 'diff', label: '文本对比', desc: '左右比对差异', icon: <GitCompare size={22} color="#10b981" />, run: newTextDiff },
];

// ── 工具函数 ──

/** 修改时间：今天显示时刻，今年显示月日，否则显示年月日 */
function formatMtime(mtime: number | null): string {
  if (!mtime) return '';
  // 后端返回秒或毫秒，统一换算为毫秒
  const date = new Date(mtime < 1e12 ? mtime * 1000 : mtime);
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 文件大小 */
function formatSize(size: number | null): string {
  if (size === null || size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 在收藏树中查找路径对应的收藏项 */
function findFavoriteByPath(nodes: FavoriteNode[], path: string): FavoriteNode | null {
  const target = pathKey(path);
  for (const node of nodes) {
    if (node.type === 'file' && pathKey(node.path) === target) return node;
    if (node.type === 'folder') {
      const found = findFavoriteByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

// ── 文件行 ──

interface FileRowProps {
  node: FileTreeNode;
  isOpen: boolean;
  onOpen: () => void;
  onMenu: () => void;
}

function FileRow({ node, isOpen, onOpen, onMenu }: FileRowProps) {
  const press = useLongPress(onMenu, onOpen);
  const meta = node.isDir ? '' : [formatMtime(node.mtime), formatSize(node.size)].filter(Boolean).join(' · ');
  return (
    <div className="nb-m-row" role="button" tabIndex={0} {...press}>
      <span className="nb-m-row-icon">{getExplorerFileIcon(node.name, { size: 22, isDir: node.isDir })}</span>
      <span className="nb-m-row-text">
        <span className="nb-m-row-title">
          {node.name}
          {isOpen && <span className="nb-m-badge">已打开</span>}
        </span>
        {meta && <span className="nb-m-row-meta">{meta}</span>}
      </span>
      {node.isDir && <ChevronRight size={18} className="nb-m-row-chevron" />}
    </div>
  );
}

// ── 面包屑 ──

function Breadcrumb() {
  const currentFolder = useMobileStore((s) => s.currentFolder);
  const locationRoot = useMobileStore((s) => s.locationRoot);
  const location = useMobileStore((s) => s.location);

  // 由根目录逐级拼出到当前文件夹的路径段
  const segments = useMemo(() => {
    const rootLabel = location === 'device' ? '手机存储' : '我的笔记';
    const result: Array<{ label: string; path: string }> = [{ label: rootLabel, path: locationRoot }];
    if (!currentFolder || !locationRoot || !isSubPath(locationRoot, currentFolder)) return result;
    const relative = currentFolder.slice(locationRoot.length).split(/[/\\]/).filter(Boolean);
    let accumulated = locationRoot;
    for (const part of relative) {
      accumulated = accumulated.endsWith(PATH_SEP) ? accumulated + part : accumulated + PATH_SEP + part;
      result.push({ label: part, path: accumulated });
    }
    return result;
  }, [currentFolder, locationRoot, location]);

  return (
    <nav className="nb-m-breadcrumb" aria-label="当前位置" data-no-swipe="">
      {segments.map((segment, index) => (
        <span key={segment.path} className="nb-m-crumb-wrap">
          {index > 0 && <ChevronRight size={14} className="nb-m-crumb-sep" />}
          <button
            type="button"
            className={`nb-m-crumb${index === segments.length - 1 ? ' is-current' : ''}`}
            onClick={() => void loadFolder(segment.path)}
          >
            {segment.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

// ── 文件分段 ──

function FilesSection({ onEntryMenu }: { onEntryMenu: (node: FileTreeNode) => void }) {
  const entries = useMobileStore((s) => s.entries);
  const loading = useMobileStore((s) => s.loading);
  const listError = useMobileStore((s) => s.listError);
  const location = useMobileStore((s) => s.location);
  const platform = useMobileStore((s) => s.platform);
  const tabs = useWindowStore((s) => s.tabs);
  const openKeys = useMemo(() => new Set(tabs.map((tab) => pathKey(tab.path ?? ''))), [tabs]);

  // 切换到手机存储：未授权时先引导开启"所有文件访问权限"
  const chooseDevice = async () => {
    if (!platform) return;
    if (!platform.allFilesAccess) {
      try {
        await ipc.requestAllFilesAccess();
        showToast('请在系统设置中允许 NoteBoard 访问所有文件，返回后自动刷新', 'info', 5000);
      } catch (error) {
        showToast(String(error), 'error');
      }
      return;
    }
    await switchLocation('device');
  };

  const needsPermission = location === 'device' && platform && !platform.allFilesAccess;

  return (
    <>
      <div className="nb-m-location" data-no-swipe="">
        <button
          type="button"
          className={`nb-m-chip${location === 'workspace' ? ' is-active' : ''}`}
          onClick={() => void switchLocation('workspace')}
        >
          <NotebookPen size={15} /> 我的笔记
        </button>
        {platform?.isMobile && (
          <button
            type="button"
            className={`nb-m-chip${location === 'device' ? ' is-active' : ''}`}
            onClick={() => void chooseDevice()}
          >
            <HardDrive size={15} /> 手机存储
            {!platform.allFilesAccess && <ShieldAlert size={14} className="nb-m-chip-warn" />}
          </button>
        )}
        <IconButton icon={<RefreshCw size={17} />} label="刷新" onClick={() => void refreshCurrentFolder()} className="nb-m-location-refresh" />
      </div>
      <Breadcrumb />
      <div className="nb-m-list">
        {needsPermission ? (
          <div className="nb-m-empty">
            <ShieldAlert size={36} />
            <div>需要"所有文件访问权限"才能浏览手机存储</div>
            <button type="button" className="nb-m-pill-btn" onClick={() => void chooseDevice()}>
              前往授权
            </button>
          </div>
        ) : listError ? (
          <div className="nb-m-empty">
            <div>无法读取文件夹</div>
            <div className="nb-m-empty-sub">{listError}</div>
            <button type="button" className="nb-m-pill-btn" onClick={() => void refreshCurrentFolder()}>
              重试
            </button>
          </div>
        ) : entries.length === 0 && !loading ? (
          <div className="nb-m-empty">
            <FilePlus size={36} />
            <div>这里还没有文件</div>
            <div className="nb-m-empty-sub">点击右下角 ＋ 新建笔记，或导入文件</div>
          </div>
        ) : (
          entries.map((node) => (
            <FileRow
              key={node.path}
              node={node}
              isOpen={!node.isDir && openKeys.has(pathKey(node.path))}
              onOpen={() => void openEntry(node)}
              onMenu={() => onEntryMenu(node)}
            />
          ))
        )}
      </div>
    </>
  );
}

// ── 收藏分段 ──

function FavoriteRows({ nodes, depth }: { nodes: FavoriteNode[]; depth: number }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const removeFavorite = useFavoritesStore((s) => s.removeFavorite);
  const openAddModal = useFavoritesStore((s) => s.openAddModal);
  const [menuTarget, setMenuTarget] = useState<FavoriteNode | null>(null);

  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'folder') {
          const isExpanded = expanded.has(node.id);
          return (
            <div key={node.id}>
              <div
                className="nb-m-row"
                role="button"
                style={{ paddingLeft: 16 + depth * 18 }}
                onClick={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  })
                }
              >
                <span className="nb-m-row-icon">{getExplorerFileIcon(node.name, { size: 22, isDir: true, isOpen: isExpanded })}</span>
                <span className="nb-m-row-text">
                  <span className="nb-m-row-title">{node.name}</span>
                  <span className="nb-m-row-meta">{node.children.length} 项</span>
                </span>
                <ChevronRight size={18} className={`nb-m-row-chevron${isExpanded ? ' is-expanded' : ''}`} />
              </div>
              {isExpanded && <FavoriteRows nodes={node.children} depth={depth + 1} />}
            </div>
          );
        }
        return (
          <FavoriteFileRow
            key={node.id}
            name={node.name}
            path={node.path}
            depth={depth}
            onMenu={() => setMenuTarget(node)}
          />
        );
      })}
      <ActionSheet
        open={menuTarget !== null}
        onClose={() => setMenuTarget(null)}
        title={menuTarget?.name}
        actions={menuTarget && menuTarget.type === 'file' ? [
          { key: 'open', label: '打开', icon: <FileText size={18} />, onSelect: () => void openPathInEditor(menuTarget.path) },
          // 已收藏文件也使用同一个弹窗，允许后续修改名称或移到其他收藏文件夹。
          { key: 'edit', label: '编辑收藏', icon: <Pencil size={18} />, onSelect: () => openAddModal({ name: menuTarget.name, path: menuTarget.path }) },
          { key: 'remove', label: '取消收藏', icon: <StarOff size={18} />, danger: true, onSelect: () => void removeFavorite(menuTarget.id) },
        ] : []}
      />
    </>
  );
}

function FavoriteFileRow({ name, path, depth, onMenu }: { name: string; path: string; depth: number; onMenu: () => void }) {
  const press = useLongPress(onMenu, () => void openPathInEditor(path));
  return (
    <div className="nb-m-row" role="button" style={{ paddingLeft: 16 + depth * 18 }} {...press}>
      <span className="nb-m-row-icon">{getExplorerFileIcon(path, { size: 22 })}</span>
      <span className="nb-m-row-text">
        <span className="nb-m-row-title">{name}</span>
        <span className="nb-m-row-meta">{path}</span>
      </span>
    </div>
  );
}

function FavoritesSection() {
  const roots = useFavoritesStore((s) => s.data.roots);
  if (roots.length === 0) {
    return (
      <div className="nb-m-list">
        <div className="nb-m-empty">
          <Star size={36} />
          <div>还没有收藏</div>
          <div className="nb-m-empty-sub">在文件上长按，选择"加入收藏"</div>
        </div>
      </div>
    );
  }
  return (
    <div className="nb-m-list">
      <FavoriteRows nodes={roots} depth={0} />
    </div>
  );
}

// ── 已打开分段 ──

function OpenSection() {
  const tabs = useWindowStore((s) => s.tabs);
  const activateTab = useWindowStore((s) => s.activateTab);
  const requestCloseTab = useWindowStore((s) => s.requestCloseTab);
  const setPage = useMobileStore((s) => s.setPage);

  if (tabs.length === 0) {
    return (
      <div className="nb-m-list">
        <div className="nb-m-empty">
          <Archive size={36} />
          <div>没有打开的文档</div>
        </div>
      </div>
    );
  }
  return (
    <div className="nb-m-list">
      {tabs.map((tab) => (
        <div
          key={tab.key}
          className="nb-m-row"
          role="button"
          onClick={() => {
            activateTab(tab.key);
            setPage('editor');
          }}
        >
          <span className="nb-m-row-icon">{getExplorerFileIcon(tab.displayName, { size: 22 })}</span>
          <span className="nb-m-row-text">
            <span className="nb-m-row-title">
              {tab.displayName}
              {tab.isDirty && <span className="nb-m-dirty-dot" aria-label="未保存" />}
            </span>
            <span className="nb-m-row-meta">{tab.path ?? '未保存的新文档'}</span>
          </span>
          <IconButton
            icon={<X size={18} />}
            label={`关闭 ${tab.displayName}`}
            onClick={() => {
              requestCloseTab(tab.key);
            }}
            className="nb-m-row-action"
          />
        </div>
      ))}
    </div>
  );
}

// ── 首页 ──

const SECTIONS: Array<{ key: HomeSection; label: string }> = [
  { key: 'files', label: '文件' },
  { key: 'favorites', label: '收藏' },
  { key: 'open', label: '已打开' },
];

export function MobileHome() {
  const homeSection = useMobileStore((s) => s.homeSection);
  const setHomeSection = useMobileStore((s) => s.setHomeSection);
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsModalVisible);
  const openCount = useWindowStore((s) => s.tabs.length);
  const favoriteRoots = useFavoritesStore((s) => s.data.roots);
  const openAddModal = useFavoritesStore((s) => s.openAddModal);
  const removeFavorite = useFavoritesStore((s) => s.removeFavorite);

  // 分段指示条位置：直接写 transform，拖动过程中不触发 React 重渲染
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const sectionIndex = Math.max(0, SECTIONS.findIndex((section) => section.key === homeSection));
  const moveIndicator = useCallback((position: number) => {
    const indicator = indicatorRef.current;
    if (!indicator) return;
    const clamped = Math.max(0, Math.min(SECTIONS.length - 1, position));
    indicator.style.transform = `translate3d(${clamped * 100}%, 0, 0)`;
  }, []);

  const [createOpen, setCreateOpen] = useState(false);
  const [menuNode, setMenuNode] = useState<FileTreeNode | null>(null);
  const [renameNode, setRenameNode] = useState<FileTreeNode | null>(null);
  const [deleteNode, setDeleteNode] = useState<FileTreeNode | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);

  // 长按条目的操作列表
  const entryActions: SheetAction[] = useMemo(() => {
    if (!menuNode) return [];
    const favorite = menuNode.isDir ? null : findFavoriteByPath(favoriteRoots, menuNode.path);
    const actions: SheetAction[] = [
      {
        key: 'open',
        label: menuNode.isDir ? '打开文件夹' : '打开',
        icon: menuNode.isDir ? getExplorerFileIcon('', { size: 18, isDir: true }) : <FileText size={18} />,
        onSelect: () => void openEntry(menuNode),
      },
      { key: 'rename', label: '重命名', icon: <Pencil size={18} />, onSelect: () => setRenameNode(menuNode) },
    ];
    if (!menuNode.isDir) {
      actions.push({ key: 'share', label: '分享 / 用其他应用打开', icon: <Share2 size={18} />, onSelect: () => void shareEntry(menuNode.path) });
      actions.push(
        favorite
          ? { key: 'unfav', label: '取消收藏', icon: <StarOff size={18} />, onSelect: () => void removeFavorite(favorite.id) }
          : {
              key: 'fav',
              label: '加入收藏',
              icon: <Star size={18} />,
              onSelect: () => {
                // 先选择收藏文件夹与名称，确认后才写入收藏；复用全局弹窗的新建文件夹流程。
                openAddModal({ name: menuNode.name, path: menuNode.path });
              },
            },
      );
    }
    actions.push({ key: 'delete', label: '删除', icon: <Trash2 size={18} />, danger: true, onSelect: () => setDeleteNode(menuNode) });
    return actions;
  }, [menuNode, favoriteRoots, openAddModal, removeFavorite]);

  return (
    <div className="nb-m-page">
      <TopBar
        title={
          <span className="nb-m-brand">
            <img src="/logo.png" alt="" width={22} height={22} />
            NoteBoard
          </span>
        }
        actions={<IconButton icon={<Settings size={20} />} label="设置" onClick={() => setSettingsOpen(true)} />}
      />

      <div className="nb-m-segmented" role="tablist">
        {/* 滑动指示条：跟随翻页拖动进度连续移动 */}
        <span
          ref={indicatorRef}
          className="nb-m-segment-indicator"
          style={{ width: `calc((100% - 6px) / ${SECTIONS.length})` }}
          aria-hidden
        />
        {SECTIONS.map((section) => (
          <button
            key={section.key}
            type="button"
            role="tab"
            aria-selected={homeSection === section.key}
            className={`nb-m-segment${homeSection === section.key ? ' is-active' : ''}`}
            onClick={() => setHomeSection(section.key)}
          >
            {section.label}
            {section.key === 'open' && openCount > 0 && <span className="nb-m-count">{openCount}</span>}
          </button>
        ))}
      </div>

      <div className="nb-m-page-body">
        <SwipePager
          index={sectionIndex}
          count={SECTIONS.length}
          onIndexChange={(next) => setHomeSection(SECTIONS[next].key)}
          onProgress={moveIndicator}
        >
          {[
            <FilesSection key="files" onEntryMenu={setMenuNode} />,
            <FavoritesSection key="favorites" />,
            <OpenSection key="open" />,
          ]}
        </SwipePager>
      </div>

      {/* 新建悬浮按钮 */}
      <button type="button" className="nb-m-fab" aria-label="新建" onClick={() => setCreateOpen(true)}>
        <Plus size={26} />
      </button>

      {/* 新建面板：文档类型网格 + 文件夹 / 导入 */}
      <BottomSheet open={createOpen} onClose={() => setCreateOpen(false)} title="新建">
        <div className="nb-m-create-grid">
          {CREATE_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="nb-m-create-card"
              onClick={() => {
                setCreateOpen(false);
                item.run();
                useMobileStore.getState().setPage('editor');
              }}
            >
              <span className="nb-m-create-icon">{item.icon}</span>
              <span className="nb-m-create-label">{item.label}</span>
              <span className="nb-m-create-desc">{item.desc}</span>
            </button>
          ))}
        </div>
        <div className="nb-m-action-list nb-m-create-extra">
          <button
            type="button"
            className="nb-m-action"
            onClick={() => {
              setCreateOpen(false);
              setHomeSection('files');
              setNewFolderOpen(true);
            }}
          >
            <span className="nb-m-action-icon"><FolderPlus size={18} /></span>
            <span className="nb-m-action-text"><span className="nb-m-action-label">新建文件夹</span></span>
          </button>
          <button
            type="button"
            className="nb-m-action"
            onClick={() => {
              setCreateOpen(false);
              setHomeSection('files');
              void importFiles();
            }}
          >
            <span className="nb-m-action-icon"><Import size={18} /></span>
            <span className="nb-m-action-text">
              <span className="nb-m-action-label">导入文件</span>
              <span className="nb-m-action-desc">从手机其它位置复制到当前文件夹</span>
            </span>
          </button>
        </div>
      </BottomSheet>

      <ActionSheet open={menuNode !== null} onClose={() => setMenuNode(null)} title={menuNode?.name} actions={entryActions} />

      <PromptDialog
        open={renameNode !== null}
        title="重命名"
        initialValue={renameNode?.name ?? ''}
        selectBaseName={!renameNode?.isDir}
        validate={validateFileName}
        onClose={() => setRenameNode(null)}
        onConfirm={async (value) => {
          if (renameNode && (await renameEntry(renameNode, value))) setRenameNode(null);
        }}
      />

      <PromptDialog
        open={newFolderOpen}
        title="新建文件夹"
        initialValue="新建文件夹"
        validate={validateFileName}
        onClose={() => setNewFolderOpen(false)}
        onConfirm={async (value) => {
          if (await createFolder(value)) setNewFolderOpen(false);
        }}
      />

      <ConfirmDialog
        open={deleteNode !== null}
        title={deleteNode?.isDir ? '删除文件夹' : '删除文件'}
        message={`「${deleteNode ? basenameOf(deleteNode.path) : ''}」${deleteNode?.isDir ? '及其中的全部内容' : ''}将被永久删除，无法恢复。`}
        confirmLabel="删除"
        danger
        onClose={() => setDeleteNode(null)}
        onConfirm={() => {
          if (deleteNode) void deleteEntry(deleteNode);
        }}
      />
    </div>
  );
}
