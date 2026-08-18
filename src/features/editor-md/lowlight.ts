// NoteBoard lowlight 配置
// 为代码块提供语法高亮（基于 highlight.js）
// 详见 docs/09-开发路线图.md 7.9/7.10
//
// 魔法值来自 note-gen 的经验值，非推导值：
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

// 语言别名映射
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  html: 'xml',
  rs: 'rust',
  golang: 'go',
  cs: 'csharp',
  'c++': 'cpp',
  'c#': 'csharp',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
};

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

/** 规范化语言名（别名 → 标准名） */
export function normalizeLanguage(lang: string | null): string {
  if (!lang || lang.trim() === '') return 'plaintext';
  const normalized = lang.toLowerCase().trim();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

/** highlightAuto 的字符上限（来自 note-gen 经验值） */
export const HIGHLIGHT_AUTO_LIMIT = 5000;

/** 单个代码块高亮的字符上限（超过则跳过） */
export const SINGLE_BLOCK_LIMIT = 20000;
