// NoteBoard 保存文档编排
// Ctrl+S / Ctrl+Shift+S → 脏态 → 原子写 → WriteError 分类提示
// 详见 docs/09-开发路线图.md 4.11

import { save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../../core/ipc/commands';
import { useDocumentStore } from '../../../stores/documentStore';
import { useWindowStore } from '../../../stores/windowStore';
import { getBaseline } from '../../editor-md/serialize';
import { kindFromPath, languageFromPath } from '../../../core/docKind';
import type { WriteError } from '../../../core/ipc/types';
import { moveDocumentHistory } from '../../history/documentHistory';
import { DEFAULT_DRAWIO_XML, syncDocumentContent } from './syncDocumentContent';
import { onDocumentSaved } from '../../staging/stagingManager';

// ── 保存单个文档 ──

export async function saveDocument(docKey: string): Promise<boolean> {
  const store = useDocumentStore.getState();
  const doc = store.getDocument(docKey);
  if (!doc) {
    console.warn('saveDocument: 文档不存在', docKey);
    return false;
  }

  // 保存与暂存共用同一套权威内容抓取逻辑，避免不同退出路径得到不一致副本。
  syncDocumentContent(docKey);

  const updatedDoc = useDocumentStore.getState().getDocument(docKey);
  if (!updatedDoc) return false;

  // 运行期间原文件被删除后，Ctrl+S 也必须转为另存为，禁止悄悄在旧路径重建文件。
  const detached = useWindowStore.getState().getTab(docKey)?.isDetached ?? false;
  if (updatedDoc.externalStatus === 'deleted' || detached) {
    return saveAs(updatedDoc.key, updatedDoc.content ?? '');
  }

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
      // 正常写入原文件后，该副本不再代表未保存内容，应从暂存区清理。
      await onDocumentSaved(docKey);
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
  // 另存为可能由“原文件已删除”提示触发，先抓取编辑器权威内容，避免写入防抖前的旧镜像。
  syncDocumentContent(originalKey);
  const doc = docStore.getDocument(originalKey);

  let defaultExtension = 'txt';
  let filters: Array<{ name: string; extensions: string[] }> = [
    { name: '文本文档 (*.txt)', extensions: ['txt'] },
    { name: '全部文件 (*.*)', extensions: ['*'] },
  ];

  if (doc?.kind === 'markdown' || originalKey.includes('markdown')) {
    defaultExtension = 'md';
    filters = [
      { name: 'Markdown 笔记 (*.md)', extensions: ['md', 'markdown'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.kind === 'mindmap' || originalKey.includes('mindmap')) {
    defaultExtension = 'mindmap';
    filters = [
      { name: '思维导图文件 (*.mindmap)', extensions: ['mindmap'] },
      { name: 'XMind 思维导图 (*.xmind)', extensions: ['xmind'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.kind === 'drawio' || originalKey.includes('drawio')) {
    defaultExtension = 'drawio';
    filters = [
      { name: 'Draw.io 架构图 (*.drawio)', extensions: ['drawio'] },
      { name: 'Draw.io XML (*.xml)', extensions: ['xml'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.kind === 'board' || originalKey.includes('board') || originalKey.includes('excalidraw')) {
    defaultExtension = 'excalidraw';
    filters = [
      { name: '自由画板 (*.excalidraw)', extensions: ['excalidraw', 'board', 'canvas'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.language === 'mermaid' || originalKey.includes('mermaid')) {
    defaultExtension = 'mmd';
    filters = [
      { name: 'Mermaid 图表 (*.mmd)', extensions: ['mmd', 'mermaid'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.language === 'plantuml' || originalKey.includes('plantuml')) {
    defaultExtension = 'puml';
    filters = [
      { name: 'PlantUML 图表 (*.puml)', extensions: ['puml', 'plantuml', 'iuml', 'uml'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.language === 'json' || originalKey.includes('json')) {
    defaultExtension = 'json';
    filters = [
      { name: 'JSON 数据 (*.json)', extensions: ['json'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.language === 'yaml' || originalKey.includes('yaml')) {
    defaultExtension = 'yaml';
    filters = [
      { name: 'YAML 配置文件 (*.yaml, *.yml)', extensions: ['yaml', 'yml'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.language === 'sql' || originalKey.includes('sql')) {
    defaultExtension = 'sql';
    filters = [
      { name: 'SQL 脚本 (*.sql)', extensions: ['sql'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  } else if (doc?.language === 'xml' || originalKey.includes('xml')) {
    defaultExtension = 'xml';
    filters = [
      { name: 'XML 文档 (*.xml)', extensions: ['xml'] },
      { name: '全部文件 (*.*)', extensions: ['*'] },
    ];
  }

  const defaultPath = doc?.displayName || `未命名.${defaultExtension}`;
  // 同步后的 DocumentStore 内容优先；content 仅作为文档实例尚未建立时的兼容回退。
  const latestContent = doc?.content ?? content;
  const saveContent = (doc?.kind === 'drawio' && !latestContent.trim()) ? DEFAULT_DRAWIO_XML : latestContent;

  try {
    const selectedPath = await save({
      defaultPath,
      filters,
    });

    if (!selectedPath) return false;

    const encoding = doc?.encoding ?? 'utf8';
    const eol = doc?.eol ?? 'lf';

    const result = await ipc.writeDocument(selectedPath, saveContent, encoding, eol);

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
        content: saveContent,
        encoding,
        eol,
        size: result.size,
        mtime: result.mtime,
        readonly: false,
      });

      // 同步更新 Markdown 基线管理器
      getBaseline(selectedPath).updateBaseline(saveContent);

      // 更新 WindowStore
      tabStore.updateTabPath(originalKey, selectedPath, displayName);
      tabStore.setTabDirty(selectedPath, false);

      // 另存为会迁移文档 key，因此按原 key 清理先前的未命名暂存副本。
      await onDocumentSaved(originalKey);

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
