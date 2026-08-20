// NoteBoard 保存文档编排
// Ctrl+S / Ctrl+Shift+S → 脏态 → 原子写 → WriteError 分类提示
// 详见 docs/09-开发路线图.md 4.11

import { save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../../core/ipc/commands';
import { useDocumentStore } from '../../../stores/documentStore';
import { useWindowStore } from '../../../stores/windowStore';
import { getEditorView } from '../CodeEditor';
import { getActiveSourceView, getActiveTipTapEditor } from '../../editor-md/TipTapEditor';
import { serializeMarkdown, getBaseline } from '../../editor-md/serialize';
import { getActiveBoardScene } from '../../board/BoardEditor';
import { serializeScene } from '../../board/sceneIo';
import { kindFromPath, languageFromPath } from '../../../core/docKind';
import type { WriteError } from '../../../core/ipc/types';
import { moveDocumentHistory } from '../../history/documentHistory';

// ── 保存单个文档 ──

export async function saveDocument(docKey: string): Promise<boolean> {
  const store = useDocumentStore.getState();
  const doc = store.getDocument(docKey);
  if (!doc) {
    console.warn('saveDocument: 文档不存在', docKey);
    return false;
  }

  // 1. Markdown 必须从当前可见模式读取权威内容，避免源码修改被隐藏的 TipTap 旧内容覆盖
  if (doc.kind === 'markdown') {
    const currentMode = useWindowStore.getState().getTab(docKey)?.viewMode ?? 'visual';
    if (currentMode === 'source') {
      const sourceView = getActiveSourceView(docKey);
      if (sourceView) {
        store.setContent(docKey, sourceView.state.doc.toString());
      }
    } else {
      const tipTap = getActiveTipTapEditor(docKey);
      if (tipTap) {
        try {
          store.setContent(docKey, serializeMarkdown(tipTap));
        } catch {
          // 序列化失败时保留 store 中的最近镜像，由后续写入错误处理统一反馈
        }
      }
    }
  }

  // 2. 如果是 CodeEditor，从 CM6 view 实例取最新内容
  const view = getEditorView();
  if (view && doc.kind === 'code') {
    const latest = view.state.doc.toString();
    store.setContent(docKey, latest);
  }

  // 3. 如果是画板，从活跃画板实例取最新场景并序列化
  if (doc.kind === 'board') {
    const scene = getActiveBoardScene(docKey);
    if (scene) {
      try {
        const latest = serializeScene(scene);
        store.setContent(docKey, latest);
      } catch {
        // ignore
      }
    }
  }

  const updatedDoc = useDocumentStore.getState().getDocument(docKey);
  if (!updatedDoc) return false;

  // 没有路径 → 另存为
  if (!updatedDoc.key || updatedDoc.key.startsWith('untitled:')) {
    return saveAs(updatedDoc.key, updatedDoc.content ?? '');
  }

  try {
    const result = await ipc.writeDocument(
      updatedDoc.key,
      updatedDoc.content ?? '',
      updatedDoc.encoding,
      updatedDoc.eol,
    );

    if (result.ok) {
      // 更新基线
      store.updateBaseline(docKey, updatedDoc.content ?? '', result.mtime, result.size);
      // 同步更新 Markdown 基线管理器
      getBaseline(docKey).updateBaseline(updatedDoc.content ?? '');
      // 写盘期间若继续编辑，保存前后的历史仍保留，且当前文档继续显示为未保存
      const stillDirty = useDocumentStore.getState().getDocument(docKey)?.isDirty ?? false;
      useWindowStore.getState().setTabDirty(docKey, stillDirty);
      await ipc.setDocumentDirty(docKey, stillDirty);
      return true;
    } else if (result.error) {
      showWriteError(result.error);
      return false;
    }
  } catch (e) {
    console.error('保存失败:', e);
    showWriteError({ kind: 'io', message: e instanceof Error ? e.message : String(e) });
  }

  return false;
}

// ── 另存为 ──

export async function saveAs(originalKey: string, content: string): Promise<boolean> {
  const docStore = useDocumentStore.getState();
  const tabStore = useWindowStore.getState();
  const doc = docStore.getDocument(originalKey);

  const isMarkdown = doc?.kind === 'markdown' || originalKey.includes('markdown');
  const isBoard = doc?.kind === 'board' || originalKey.includes('board');

  const defaultExtension = isMarkdown ? 'md' : isBoard ? 'excalidraw' : 'txt';
  const defaultPath = doc?.displayName && !doc.displayName.startsWith('未命名')
    ? doc.displayName
    : `未命名.${defaultExtension}`;

  const filters = isMarkdown
    ? [{ name: 'Markdown 笔记 (*.md)', extensions: ['md', 'markdown'] }, { name: '全部文件 (*.*)', extensions: ['*'] }]
    : isBoard
    ? [{ name: '画板文件 (*.excalidraw, *.board)', extensions: ['excalidraw', 'board', 'canvas'] }, { name: '全部文件 (*.*)', extensions: ['*'] }]
    : [{ name: '文本文档 (*.txt, *.json, *.sql)', extensions: ['txt', 'json', 'sql', 'yaml', 'yml', 'xml', 'md'] }, { name: '全部文件 (*.*)', extensions: ['*'] }];

  try {
    const selectedPath = await save({
      defaultPath,
      filters,
    });

    if (!selectedPath) return false;

    const encoding = doc?.encoding ?? 'utf8';
    const eol = doc?.eol ?? 'lf';

    const result = await ipc.writeDocument(selectedPath, content, encoding, eol);

    if (result.ok) {
      const displayName = selectedPath.split(/[\\/]/).pop() ?? selectedPath;
      const dirPath = selectedPath.substring(0, selectedPath.lastIndexOf('\\')) || selectedPath;
      const kind = kindFromPath(selectedPath);
      const language = languageFromPath(selectedPath);

      // 注册新文档
      const label = getCurrentWindow().label;
      try {
        await ipc.registerDocument(label, selectedPath, kind);
        if (originalKey && originalKey !== selectedPath) {
          await ipc.unregisterDocument(label, originalKey);
        }
      } catch {
        // ignore
      }

      // 更新 DocumentStore
      if (originalKey !== selectedPath) {
        // 先迁移文件级历史，再删除旧文档状态，保证首次另存为前后的步骤仍然存在
        moveDocumentHistory(originalKey, selectedPath);
        docStore.remove(originalKey);
      }

      docStore.upsertFromPayload({
        key: selectedPath,
        displayName,
        dirPath,
        kind,
        language,
        content,
        encoding,
        eol,
        size: result.size,
        mtime: result.mtime,
        readonly: false,
      });

      // 同步更新 Markdown 基线管理器
      getBaseline(selectedPath).updateBaseline(content);

      // 更新 WindowStore
      tabStore.updateTabPath(originalKey, selectedPath, displayName);
      tabStore.setTabDirty(selectedPath, false);

      return true;
    } else if (result.error) {
      showWriteError(result.error);
      return false;
    }
  } catch (err) {
    console.error('另存为失败:', err);
    showWriteError({ kind: 'io', message: err instanceof Error ? err.message : String(err) });
  }

  return false;
}

// ── WriteError 分类提示 ──

export function getWriteErrorMessage(error: WriteError): string {
  switch (error.kind) {
    case 'permission-denied':
      return `没有权限写入文件：${error.path}`;
    case 'disk-full':
      return '磁盘空间不足，无法保存';
    case 'file-locked':
      return `文件被其他程序锁定：${error.path}`;
    case 'readonly':
      return `文件是只读的：${error.path}`;
    case 'path-not-found':
      return `路径不存在：${error.path}`;
    case 'io':
      return `写入出错：${error.message}`;
  }
}

export function showWriteError(error: WriteError): void {
  const msg = getWriteErrorMessage(error);
  console.error('保存错误:', msg);
}
