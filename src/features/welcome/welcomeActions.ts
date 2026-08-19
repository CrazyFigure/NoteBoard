// NoteBoard 欢迎页动作
// 打开文件/文件夹、新建 Markdown/画板
// 详见 docs/01-需求规格说明.md FR-105 ~ FR-108

import { open } from '@tauri-apps/plugin-dialog';
import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { openDocument } from '../editor-code/orchestration/openDocument';
import type { DocumentKind, LanguageId } from '../../core/ipc/types';

let untitledCounter = 0;

/** 生成唯一的未命名文档 key */
function nextUntitledKey(prefix: string): string {
  untitledCounter += 1;
  return `untitled:${prefix}:${Date.now()}:${untitledCounter}`;
}

/**
 * 打开系统文件选择对话框，支持多选
 * 选中后逐个打开为 tab
 */
export async function openFileDialog(): Promise<void> {
  const paths = await open({
    multiple: true,
    filters: [
      { name: '全部文件', extensions: ['*'] },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: '画板', extensions: ['excalidraw'] },
    ],
  });
  if (!paths || paths.length === 0) return;

  for (const path of paths) {
    // eslint-disable-next-line no-await-in-loop
    await openDocument(path);
  }
}

/**
 * 打开系统文件夹选择对话框
 * 将所选目录设为资源管理器根，不自动打开任何文件
 */
export async function openFolderDialog(): Promise<void> {
  const selected = await open({
    directory: true,
    multiple: false,
  });
  if (!selected || Array.isArray(selected)) return;

  const root = selected;
  const nodes = await ipc.readDir(root, false);
  useExplorerStore.getState().setRoot(root, nodes);

  // 推送到最近打开（非关键路径）
  try {
    await ipc.pushRecent(root, true);
  } catch {
    // 忽略
  }
}

/** 创建未命名文档与 tab */
function createUntitledDocument(type: 'markdown' | 'board' | 'txt'): void {
  const key = nextUntitledKey(type);
  let kind: DocumentKind;
  let language: LanguageId = 'plaintext';
  let displayName = '未命名.txt';

  // 根据新建类型决定文档模型、语言标识与默认文件名
  if (type === 'markdown') {
    kind = 'markdown';
    language = 'markdown';
    displayName = '未命名.md';
  } else if (type === 'board') {
    kind = 'board';
    language = 'plaintext';
    displayName = '未命名.excalidraw';
  } else {
    // 纯文本 (TXT) 使用代码编辑器与纯文本语法模式
    kind = 'code';
    language = 'plaintext';
    displayName = '未命名.txt';
  }

  const docStore = useDocumentStore.getState();
  docStore.upsertFromPayload({
    key,
    displayName,
    dirPath: '',
    kind,
    language,
    content: '',
    encoding: 'utf8',
    eol: 'lf',
    size: 0,
    mtime: 0,
    readonly: false,
  });

  const tab: Tab = {
    key,
    displayName,
    path: null,
    kind,
    language,
    isDirty: false,
    isPreview: false,
    viewMode: null,
    externalStatus: null,
    isDetached: false,
  };
  useWindowStore.getState().openTab(tab);
}

/** 新建 Markdown 文档 */
export function newMarkdown(): void {
  createUntitledDocument('markdown');
}

/** 新建纯文本 (TXT) 文档 */
export function newText(): void {
  createUntitledDocument('txt');
}

/** 新建画板文档 */
export function newBoard(): void {
  createUntitledDocument('board');
}
