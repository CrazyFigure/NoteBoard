// 代码语言名称与长度约束为纯元数据，不引入高亮运行时；Markdown 普通正文无需初始化语法库。
// 语言别名映射
export const LANGUAGE_ALIASES: Record<string, string> = {
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

/** 规范化语言名（别名 → 标准名） */
export function normalizeLanguage(lang: string | null): string {
  if (!lang || lang.trim() === '') return 'plaintext';
  const normalized = lang.toLowerCase().trim();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

/** highlightAuto 的字符上限 */
export const HIGHLIGHT_AUTO_LIMIT = 5000;

/** 单个代码块高亮的字符上限（超过则跳过） */
export const SINGLE_BLOCK_LIMIT = 20000;
