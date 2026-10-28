// NoteBoard 配置类文件语法高亮
// 这些文件的 LanguageId 仍为 plaintext（不扩充前后端共享枚举），
// 打开时再按文件名 / 内容识别“方言”，按需懒加载 StreamLanguage 高亮

import type { Extension } from '@codemirror/state';
import type { StreamParser, StringStream } from '@codemirror/language';
import { extFromPath } from '../../core/docKind';

/** 可识别的配置方言 */
export type ConfigDialect =
  | 'config'
  | 'nginx'
  | 'toml'
  | 'shell'
  | 'powershell'
  | 'dockerfile'
  | 'diff'
  | 'cmake'
  | 'ignore'
  | 'xml';

// ── 方言识别表 ──

/** 完整文件名（小写）→ 方言，优先级最高 */
const DIALECT_BY_NAME: Record<string, ConfigDialect> = {
  'nginx.conf': 'nginx',
  'cmakelists.txt': 'cmake',
  'cargo.lock': 'toml',
  'poetry.lock': 'toml',
  'uv.lock': 'toml',
  pipfile: 'toml',
  ssh_config: 'config',
  sshd_config: 'config',
  hosts: 'config',
  '.htaccess': 'config',
};

/** 扩展名 → 方言（以点开头的文件如 .gitignore 取点后部分作扩展名） */
const DIALECT_BY_EXT: Record<string, ConfigDialect> = {
  // INI / 通用键值配置
  ini: 'config',
  conf: 'config',
  cfg: 'config',
  cnf: 'config',
  config: 'config',
  properties: 'config',
  prefs: 'config',
  inf: 'config',
  reg: 'config',
  env: 'config',
  editorconfig: 'config',
  gitconfig: 'config',
  gitmodules: 'config',
  gitattributes: 'config',
  npmrc: 'config',
  yarnrc: 'config',
  wslconfig: 'config',
  desktop: 'config',
  // systemd 单元文件为 INI 结构
  service: 'config',
  socket: 'config',
  timer: 'config',
  mount: 'config',
  target: 'config',
  // HCL / Terraform 与通用配置写法接近（键 = 值、花括号块）
  tf: 'config',
  tfvars: 'config',
  hcl: 'config',
  nginx: 'nginx',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  bashrc: 'shell',
  zshrc: 'shell',
  profile: 'shell',
  bash_profile: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  dockerfile: 'dockerfile',
  diff: 'diff',
  patch: 'diff',
  cmake: 'cmake',
  gitignore: 'ignore',
  dockerignore: 'ignore',
  npmignore: 'ignore',
  prettierignore: 'ignore',
  eslintignore: 'ignore',
  vscodeignore: 'ignore',
};

/** 内容嗅探只看开头这一段，避免大文件扫描 */
const SNIFF_LENGTH = 4096;
const NGINX_SNIFF = /^\s*(?:(?:http|events|stream|upstream\s+\S+|server|location\s+[^{\n]+)\s*\{|(?:worker_processes|server_name|proxy_pass|listen)\s+[^;\n]+;)/m;
// 仅认 XML 声明与 .NET 的 <configuration>，避免误伤以 <VirtualHost> 开头的 Apache 配置
const XML_SNIFF = /^\s*<(?:\?xml|configuration\b)/i;

function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(idx + 1).toLowerCase();
}

/**
 * 按文件名与（可选）内容识别配置方言；无法识别返回 null，沿用纯文本高亮
 */
export function resolveConfigDialect(fileName: string, content?: string | null): ConfigDialect | null {
  const name = baseName(fileName);
  const byName = DIALECT_BY_NAME[name];
  if (byName) return byName;
  // Dockerfile.dev、Containerfile 等变体
  if (name.startsWith('dockerfile') || name.startsWith('containerfile')) return 'dockerfile';
  // .env.local / .env.production 等
  if (name.startsWith('.env.')) return 'config';

  const dialect = DIALECT_BY_EXT[extFromPath(name)];
  if (dialect !== 'config') return dialect ?? null;

  // .conf / .config 可能是 nginx 配置或 XML（如 web.config），按文件名与开头内容细分
  if (name.includes('nginx')) return 'nginx';
  if (content) {
    const head = content.slice(0, SNIFF_LENGTH);
    if (XML_SNIFF.test(head)) return 'xml';
    if (NGINX_SNIFF.test(head)) return 'nginx';
  }
  return 'config';
}

// ── 通用配置解析器 ──
// 覆盖 INI / properties / .env / Apache / redis / sshd / HCL 等“键 值”或“键 = 值”写法

interface ConfigState {
  /** 当前处于键名（或块内指令名）位置 */
  atKey: boolean;
  /** 本行已出现 = 或 :，其后的裸词按值着色 */
  afterAssign: boolean;
  inBlockComment: boolean;
  /** 上一行以反斜杠续行，新行不重置键值状态 */
  continued: boolean;
}

const BOOL_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', 'none', 'nil', 'enabled', 'disabled']);
/** 整词为数字（含十六进制、版本/IP 式点分、带单位如 10m / 2gb / 50%） */
const NUMBER_WORD = /^[-+]?(?:0x[\da-f]+|\d+(?:\.\d+)*)(?:[a-z%]{1,3})?$/i;
const URL_WORD = /^[a-z][\w+.-]*:\/\//i;
const KEY_WORD = /^[^\s=:{};,"'`#[\]()<>]+/;
const VALUE_WORD = /^[^\s;{}(),"'`$[\]<>]+/;
const VARIABLE = /^(?:\$\{[^}\n]*\}|\$[A-Za-z_]\w*|%\([^)\n]+\)[sd]|%[A-Za-z_]\w*%)/;

function readString(stream: StringStream, quote: string): void {
  let escaped = false;
  let ch: string | void;
  while ((ch = stream.next()) != null) {
    if (ch === quote && !escaped) return;
    escaped = !escaped && ch === '\\';
  }
}

function configToken(stream: StringStream, state: ConfigState): string | null {
  if (stream.sol()) {
    if (!state.continued) {
      state.atKey = true;
      state.afterAssign = false;
    }
    state.continued = false;
  }

  if (state.inBlockComment) {
    if (stream.skipTo('*/')) {
      stream.pos += 2;
      state.inBlockComment = false;
    } else {
      stream.skipToEnd();
    }
    return 'comment';
  }
  if (stream.eatSpace()) return null;

  const ch = stream.peek() ?? '';
  const lineStart = stream.string.slice(0, stream.pos).trim() === '';
  const prev = stream.string.charAt(stream.pos - 1);

  // 注释：行首 # / ;，行内空白后的 “# ” 与 //（避免把 #fff、http:// 当注释）
  if (
    (lineStart && (ch === '#' || ch === ';'))
    || (ch === '#' && /\s/.test(prev) && /^#(?:\s|#|$)/.test(stream.string.slice(stream.pos)))
    || ((lineStart || /\s/.test(prev)) && stream.match('//', false))
  ) {
    stream.skipToEnd();
    return 'comment';
  }
  if (stream.match('/*')) {
    state.inBlockComment = true;
    return configToken(stream, state);
  }

  // [section] / [[array]] 段落头
  if (lineStart && stream.match(/^\[\[?[^\]\n]*\]\]?/)) {
    state.atKey = true;
    return 'heading';
  }
  // Apache 风格 <VirtualHost *:80> / </Directory>
  if (stream.match(/^<\/?[A-Za-z][\w.:-]*/)) {
    state.atKey = false;
    return 'tagName';
  }
  if (stream.match(/^\/?>/)) return 'bracket';

  if (ch === '"' || ch === "'" || ch === '`') {
    stream.next();
    readString(stream, ch);
    // 紧跟 = / : 的引号串是键名（如 .reg 的 "Name"="Value"）
    const isKey = state.atKey && !state.afterAssign && stream.match(/^\s*[=:]/, false);
    state.atKey = false;
    return isKey ? 'propertyName' : 'string';
  }
  if (stream.match(VARIABLE)) {
    state.atKey = false;
    return 'variableName.special';
  }

  if (!state.afterAssign && (ch === '=' || ch === ':')) {
    stream.next();
    state.afterAssign = true;
    state.atKey = false;
    return 'operator';
  }
  if ('{}()[]'.includes(ch)) {
    stream.next();
    // 进入/离开块后下一个词是新指令
    if (ch === '{' || ch === '}') {
      state.atKey = true;
      state.afterAssign = false;
    }
    return 'bracket';
  }
  if (ch === ';' || ch === ',') {
    stream.next();
    if (ch === ';') {
      state.atKey = true;
      state.afterAssign = false;
    }
    return 'punctuation';
  }

  if (state.atKey && !state.afterAssign && stream.match(KEY_WORD)) {
    // .env / shell 风格的 export KEY=VALUE：export 后面仍是键名
    if (stream.current() === 'export') return 'keyword';
    state.atKey = false;
    return 'propertyName';
  }
  if (stream.match(VALUE_WORD)) {
    const word = stream.current();
    if (stream.eol() && word.endsWith('\\')) state.continued = true;
    state.atKey = false;
    if (NUMBER_WORD.test(word)) return 'number';
    if (BOOL_WORDS.has(word.toLowerCase())) return 'bool';
    if (URL_WORD.test(word)) return 'url';
    return state.afterAssign ? 'string' : null;
  }

  stream.next();
  return null;
}

export const configParser: StreamParser<ConfigState> = {
  name: 'config',
  startState: () => ({ atKey: true, afterAssign: false, inBlockComment: false, continued: false }),
  copyState: (s) => ({ ...s }),
  token: configToken,
  languageData: { commentTokens: { line: '#' } },
};

// ── .gitignore 类忽略规则解析器 ──

export const ignoreParser: StreamParser<null> = {
  name: 'ignore',
  startState: () => null,
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^\s*#.*/)) return 'comment';
      // ! 取反规则
      if (stream.eat('!')) return 'keyword';
    }
    if (stream.match(/^\\./)) return 'escape';
    // 通配符与字符组
    if (stream.match(/^(?:\*\*|[*?]|\[[^\]\n]*\])/)) return 'regexp';
    if (stream.eat('/')) return 'punctuation';
    if (!stream.match(/^[^\\*?[/]+/)) stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
};

// ── 按方言懒加载 ──

const cache = new Map<ConfigDialect, Promise<Extension>>();

// legacy-modes 的类型来自 @codemirror/streamparser，与 @codemirror/language 的 StreamParser 结构一致但私有字段声明不同，这里统一收窄
async function defineStream(parser: Promise<object>): Promise<Extension> {
  const [{ StreamLanguage }, p] = await Promise.all([import('@codemirror/language'), parser]);
  return StreamLanguage.define(p as StreamParser<unknown>);
}

function load(dialect: ConfigDialect): Promise<Extension> {
  switch (dialect) {
    case 'config':
      return defineStream(Promise.resolve(configParser));
    case 'ignore':
      return defineStream(Promise.resolve(ignoreParser));
    case 'nginx':
      return defineStream(import('@codemirror/legacy-modes/mode/nginx').then((m) => m.nginx));
    case 'toml':
      return defineStream(import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml));
    case 'shell':
      return defineStream(import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell));
    case 'powershell':
      return defineStream(import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell));
    case 'dockerfile':
      return defineStream(import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile));
    case 'diff':
      return defineStream(import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff));
    case 'cmake':
      return defineStream(import('@codemirror/legacy-modes/mode/cmake').then((m) => m.cmake));
    case 'xml':
      return import('@codemirror/lang-xml').then((m) => m.xml());
  }
}

/** 加载方言高亮扩展（按方言缓存） */
export function loadConfigDialect(dialect: ConfigDialect): Promise<Extension> {
  let promise = cache.get(dialect);
  if (!promise) {
    promise = load(dialect);
    cache.set(dialect, promise);
  }
  return promise;
}
