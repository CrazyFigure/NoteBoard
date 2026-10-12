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

/** 代码块语言配置结构定义 */
export interface CodeLanguageItem {
  value: string;
  label: string;
  /** 斜杠命令快捷触发词（不含 /） */
  shortcut: string;
  aliases: string[];
}

/** 支持的代码语言完整列表及检索别名（代码块语言下拉与斜杠命令共用） */
export const CODE_LANGUAGES: CodeLanguageItem[] = [
  { value: 'plaintext', label: '纯文本', shortcut: 'text', aliases: ['text', 'txt', 'plain', 'chunwenben', 'wb'] },
  { value: 'javascript', label: 'JavaScript', shortcut: 'js', aliases: ['js', 'jsx', 'node', 'react'] },
  { value: 'typescript', label: 'TypeScript', shortcut: 'ts', aliases: ['ts', 'tsx'] },
  { value: 'python', label: 'Python', shortcut: 'py', aliases: ['py', 'python3', 'py3'] },
  { value: 'java', label: 'Java', shortcut: 'java', aliases: ['jvm'] },
  { value: 'c', label: 'C', shortcut: 'c', aliases: ['clang'] },
  { value: 'cpp', label: 'C++', shortcut: 'cpp', aliases: ['c++', 'cplusplus', 'cc'] },
  { value: 'csharp', label: 'C#', shortcut: 'cs', aliases: ['c#', 'cs', 'dotnet', '.net'] },
  { value: 'go', label: 'Go', shortcut: 'go', aliases: ['golang'] },
  { value: 'rust', label: 'Rust', shortcut: 'rs', aliases: ['rs', 'cargo'] },
  { value: 'sql', label: 'SQL', shortcut: 'sql', aliases: ['mysql', 'postgres', 'sqlite', 'oracle'] },
  { value: 'json', label: 'JSON', shortcut: 'json', aliases: [] },
  { value: 'yaml', label: 'YAML', shortcut: 'yml', aliases: ['yml'] },
  { value: 'xml', label: 'XML', shortcut: 'xml', aliases: ['html', 'xhtml', 'svg'] },
  { value: 'markdown', label: 'Markdown', shortcut: 'md', aliases: ['md'] },
  // shell / sh 在 normalizeLanguage 中统一归一为 bash，只保留一个条目，避免选 Shell 后显示为 Bash
  { value: 'bash', label: 'Bash / Shell', shortcut: 'sh', aliases: ['sh', 'shell', 'zsh', 'terminal'] },
  { value: 'css', label: 'CSS', shortcut: 'css', aliases: ['scss', 'less', 'style'] },
];

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
