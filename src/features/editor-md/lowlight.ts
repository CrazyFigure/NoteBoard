// NoteBoard lowlight 配置
// 为代码块提供语法高亮（基于 highlight.js）
// 详见 docs/09-开发路线图.md 7.9/7.10
//
// 参数限制：
// - highlightAuto 上限 5k 字符
// - 单块 >20k 跳过高亮
// - ±2000 position 裁剪

import { createLowlight } from 'lowlight';
import type { LanguageFn } from 'lowlight';

import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import shell from 'highlight.js/lib/languages/shell';
import plaintext from 'highlight.js/lib/languages/plaintext';

// 语言定义函数表（用于别名注册）
const LANGUAGE_DEFS: Record<string, LanguageFn> = {
  sql,
  json,
  yaml,
  xml,
  markdown,
  javascript,
  typescript,
  python,
  bash,
  css,
  rust,
  go,
  java,
  c,
  cpp,
  csharp,
  shell,
  plaintext,
};

// 名称映射与实际语法注册分离，避免规范化语言名触发运行时初始化。
import { LANGUAGE_ALIASES } from './codeLanguages';

/** 创建配置好的 lowlight 实例 */
export function createConfiguredLowlight() {
  const ll = createLowlight();

  // 注册所有语言定义
  for (const [name, fn] of Object.entries(LANGUAGE_DEFS)) {
    ll.register(name, fn);
  }

  // 注册别名（直接引用原始语言定义函数）
  for (const [alias, real] of Object.entries(LANGUAGE_ALIASES)) {
    if (alias !== real) {
      const langFn = LANGUAGE_DEFS[real];
      if (langFn) {
        ll.register(alias, langFn);
      }
    }
  }

  return ll;
}

/** 全局共享的 lowlight 实例（延迟创建） */
let _lowlight: ReturnType<typeof createLowlight> | null = null;

/** 获取共享 lowlight 实例 */
export function getLowlight() {
  if (!_lowlight) {
    _lowlight = createConfiguredLowlight();
  }
  return _lowlight;
}

/** 导出供 CodeBlockView 使用的实例 */
export const lowlight = getLowlight();

// 保留既有导出接口；仅实际高亮消费者才需要加载本模块。
export { normalizeLanguage, HIGHLIGHT_AUTO_LIMIT, SINGLE_BLOCK_LIMIT } from './codeLanguages';
