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

const DEFAULT_DRAWIO_XML = `<mxfile host="NoteBoard" modified="${new Date().toISOString()}" agent="NoteBoard" version="0.1.3" etag="noteboard">
  <diagram id="diagram_1" name="第 1 页">
    <mxGraphModel dx="1000" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" background="none" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="开始绘图" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="340" y="240" width="120" height="60" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

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

  // 4. 如果是 Draw.io 且内容为空，初始化为默认 XML 模板
  if (doc.kind === 'drawio' && !doc.content?.trim()) {
    store.setContent(docKey, DEFAULT_DRAWIO_XML);
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
  const saveContent = (doc?.kind === 'drawio' && !content.trim()) ? DEFAULT_DRAWIO_XML : content;

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
