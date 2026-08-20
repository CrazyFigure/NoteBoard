// NoteBoard 扩展名 → DocumentKind 单一真相源
// Rust 侧 build.rs include_str! 同一份 JSON
// 详见 docs/08-数据契约与持久化.md §5.2

import kindByExtJson from './docKind.json' with { type: 'json' };
import type { DocumentKind, LanguageId, SavePolicy } from './ipc/types';

/** 扩展名 → kind 的映射表（小写键） */
export const KIND_BY_EXT: Record<string, DocumentKind> = kindByExtJson as Record<string, DocumentKind>;

/** 扩展名 → LanguageId */
export const LANGUAGE_BY_EXT: Record<string, LanguageId> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'plaintext',
  log: 'plaintext',
  ini: 'plaintext',
  conf: 'plaintext',
  cfg: 'plaintext',
  env: 'plaintext',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  excalidraw: 'plaintext',
  board: 'plaintext',
  canvas: 'plaintext',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  puml: 'plantuml',
  plantuml: 'plantuml',
  iuml: 'plantuml',
  uml: 'plantuml',
  drawio: 'xml',
  dio: 'xml',
  mindmap: 'json',
  xmind: 'plaintext',
  mm: 'plaintext',
};

/** 从路径提取扩展名（小写，无点） */
export function extFromPath(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx < 0 || idx === path.length - 1) return '';
  return path.slice(idx + 1).toLowerCase();
}

/** 从路径推断 DocumentKind */
export function kindFromPath(path: string): DocumentKind {
  const ext = extFromPath(path);
  if (!ext) return 'code';
  return KIND_BY_EXT[ext] ?? 'code';
}

/** 从路径推断 LanguageId */
export function languageFromPath(path: string): LanguageId {
  const ext = extFromPath(path);
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

/** 从 kind 推导保存策略 */
export function savePolicyOf(kind: DocumentKind): SavePolicy {
  switch (kind) {
    case 'markdown':
    case 'board':
    case 'mindmap':
    case 'drawio':
      return 'auto';
    case 'code':
    case 'image':
    case 'unsupported':
      return 'manual';
  }
}

/** 判断是否为受支持的可编辑类型 */
export function isEditable(kind: DocumentKind): boolean {
  // 图片为专用预览查看模式，不支持直接文本/画板编辑
  return kind !== 'unsupported' && kind !== 'image';
}
