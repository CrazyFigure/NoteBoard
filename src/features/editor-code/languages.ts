// NoteBoard CM6 语言包动态加载
// 5 个语言各自动态 import()，按需装载
// 详见 docs/09-开发路线图.md 4.4

import type { Extension } from '@codemirror/state';
import type { LanguageId } from '../../core/ipc/types';

// ── 语言模块缓存 ──

const cache = new Map<LanguageId, Promise<Extension>>();

/**
 * 按语言 ID 动态加载 CM6 语言扩展
 * 已加载的语言会被缓存
 */
export async function loadLanguageExtension(lang: LanguageId): Promise<Extension> {
  const cached = cache.get(lang);
  if (cached) return cached;

  let promise: Promise<Extension>;

  switch (lang) {
    case 'markdown':
      promise = import('@codemirror/lang-markdown').then((m) => m.markdown());
      break;
    case 'sql':
      promise = import('@codemirror/lang-sql').then((m) => m.sql());
      break;
    case 'json':
      promise = import('@codemirror/lang-json').then((m) => m.json());
      break;
    case 'yaml':
      promise = import('@codemirror/lang-yaml').then((m) => m.yaml());
      break;
    // 信息图源码以 YAML 为主（兼容 JSON 写法），复用 YAML 语法高亮
    case 'infographic':
      promise = import('@codemirror/lang-yaml').then((m) => m.yaml());
      break;
    case 'xml':
      promise = import('@codemirror/lang-xml').then((m) => m.xml());
      break;
    // HTML 自带内嵌 <style> / <script> 的 CSS 与 JS 高亮
    case 'html':
      promise = import('@codemirror/lang-html').then((m) => m.html());
      break;
    // 纯文本：识别文中 JSON 块并按 JSON 配色高亮键/值
    case 'plaintext':
      promise = import('./plainJsonHighlight').then((m) => m.plainJsonHighlight());
      break;
    case 'mermaid':
    case 'plantuml':
    default:
      // 纯文本/图表脚本基础扩展
      promise = Promise.resolve<Extension>([]);
      break;
  }

  cache.set(lang, promise);
  return promise;
}

/**
 * 按语言 ID 加载，纯文本再按文件名 / 内容细分配置方言（.conf / .ini / .env / nginx / toml 等）
 */
export async function loadEditorLanguage(
  lang: LanguageId,
  fileName: string,
  content?: string | null,
): Promise<Extension> {
  if (lang === 'plaintext') {
    const { resolveConfigDialect, loadConfigDialect } = await import('./configModes');
    const dialect = resolveConfigDialect(fileName, content);
    if (dialect) return loadConfigDialect(dialect);
  }
  return loadLanguageExtension(lang);
}

/**
 * 从文件路径推断语言并加载
 */
export async function loadLanguageFromPath(path: string, content?: string | null): Promise<Extension> {
  const { languageFromPath } = await import('../../core/docKind');
  const lang = languageFromPath(path);
  return loadEditorLanguage(lang, path, content);
}
