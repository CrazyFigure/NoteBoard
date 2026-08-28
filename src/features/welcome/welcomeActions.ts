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
import { showToast } from '../../stores/toastStore';
import { createDefaultBitableDocument, serializeBitableDocument } from '../bitable/bitableConverter';
import { INFOGRAPHIC_TEMPLATES } from '../infographic/infographicTemplates';

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
      { name: '多维表格', extensions: ['bitable', 'table'] },
      { name: '思维导图', extensions: ['mindmap', 'xmind', 'mm'] },
      { name: '画板与绘图', extensions: ['excalidraw', 'drawio', 'dio', 'board'] },
      { name: '图表与信息图脚本', extensions: ['mmd', 'mermaid', 'puml', 'plantuml', 'uml', 'infographic', 'ig'] },
    ],
  });
  if (!paths || paths.length === 0) return;

  for (const path of paths) {
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

/**
 * 打开已配置的暂存区并加载到左侧文件树。
 * 与“打开文件夹”保持相同浏览体验，但无需用户每次重新选择路径。
 */
export async function openStagingArea(): Promise<void> {
  try {
    const root = await ipc.ensureStagingDirectory();
    const nodes = await ipc.readDir(root, false);
    useExplorerStore.getState().setRoot(root, nodes);
  } catch (error) {
    showToast(`无法打开暂存区：${error instanceof Error ? error.message : String(error)}`, 'error', 5000);
  }
}

/** 创建未命名文档与 tab */
function createUntitledDocument(
  type:
    | 'markdown'
    | 'board'
    | 'txt'
    | 'mindmap'
    | 'drawio'
    | 'bitable'
    | 'mermaid'
    | 'plantuml'
    | 'infographic'
    | 'json'
    | 'yaml'
    | 'sql'
    | 'xml',
): void {
  const key = nextUntitledKey(type);
  let kind: DocumentKind = 'code';
  let language: LanguageId = 'plaintext';
  let displayName = '未命名.txt';
  let initialContent = '';

  // 根据新建类型决定文档模型、语言标识与默认文件名
  if (type === 'markdown') {
    kind = 'markdown';
    language = 'markdown';
    displayName = '未命名.md';
  } else if (type === 'board') {
    kind = 'board';
    language = 'plaintext';
    displayName = '未命名.excalidraw';
  } else if (type === 'mindmap') {
    kind = 'mindmap';
    language = 'json';
    displayName = '未命名.mindmap';
  } else if (type === 'drawio') {
    kind = 'drawio';
    language = 'xml';
    displayName = '未命名.drawio';
  } else if (type === 'bitable') {
    kind = 'bitable';
    language = 'json';
    displayName = '未命名.bitable';
    initialContent = serializeBitableDocument(createDefaultBitableDocument('未命名多维表格'));
  } else if (type === 'mermaid') {
    kind = 'code';
    language = 'mermaid';
    displayName = '未命名.mmd';
    initialContent = `graph TD\n    A[开始] --> B(处理中)\n    B --> C{是否完成?}\n    C -->|是| D[结束]\n    C -->|否| B`;
  } else if (type === 'plantuml') {
    kind = 'code';
    language = 'plantuml';
    displayName = '未命名.puml';
    initialContent = `@startuml\nactor 用户 as User\nparticipant "系统" as System\n\nUser -> System: 登录请求\nSystem --> User: 登录成功\n@enduml`;
  } else if (type === 'infographic') {
    // 信息图为声明式 YAML 源码，默认填充指标看板模板，保证新建即可见效果
    kind = 'code';
    language = 'infographic';
    displayName = '未命名.infographic';
    initialContent = INFOGRAPHIC_TEMPLATES[0]?.code ?? 'type: metric-cards\n';
  } else if (type === 'json') {
    kind = 'code';
    language = 'json';
    displayName = '未命名.json';
    initialContent = `{\n  "name": "NoteBoard",\n  "version": "0.1.3"\n}`;
  } else if (type === 'yaml') {
    kind = 'code';
    language = 'yaml';
    displayName = '未命名.yaml';
    initialContent = `name: NoteBoard\nversion: 0.1.3\nenabled: true`;
  } else if (type === 'sql') {
    kind = 'code';
    language = 'sql';
    displayName = '未命名.sql';
    initialContent = `-- NoteBoard SQL 查询\nSELECT * FROM notes WHERE is_active = 1;`;
  } else if (type === 'xml') {
    kind = 'code';
    language = 'xml';
    displayName = '未命名.xml';
    initialContent = `<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <item name="NoteBoard" />\n</root>`;
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
    content: initialContent,
    encoding: 'utf8',
    eol: 'lf',
    size: initialContent.length,
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

/** 新建思维导图文档 */
export function newMindmap(): void {
  createUntitledDocument('mindmap');
}

/** 新建 Draw.io 绘图文档 */
export function newDrawio(): void {
  createUntitledDocument('drawio');
}

/** 新建多维表格文档 */
export function newBitable(): void {
  createUntitledDocument('bitable');
}

/** 新建 Mermaid 图表文档 */
export function newMermaid(): void {
  createUntitledDocument('mermaid');
}

/** 新建 PlantUML 图表文档 */
export function newPlantUml(): void {
  createUntitledDocument('plantuml');
}

/** 新建信息图文档（.infographic 声明式源码） */
export function newInfographic(): void {
  createUntitledDocument('infographic');
}

/** 新建 JSON 配置文件 */
export function newJson(): void {
  createUntitledDocument('json');
}

/** 新建 YAML 配置文件 */
export function newYaml(): void {
  createUntitledDocument('yaml');
}

/** 新建 SQL 数据库脚本 */
export function newSql(): void {
  createUntitledDocument('sql');
}

/** 新建 XML 标记文档 */
export function newXml(): void {
  createUntitledDocument('xml');
}

/** 新建纯文本 (TXT) 文档 */
export function newText(): void {
  createUntitledDocument('txt');
}

/** 新建画板文档 */
export function newBoard(): void {
  createUntitledDocument('board');
}
