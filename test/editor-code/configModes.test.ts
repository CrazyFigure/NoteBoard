// NoteBoard 配置类文件高亮测试
// 方言识别（文件名 / 扩展名 / 内容嗅探）与通用配置解析器的着色

import { describe, it, expect } from 'vitest';
import { StringStream, type StreamParser } from '@codemirror/language';
import {
  configParser,
  ignoreParser,
  loadConfigDialect,
  resolveConfigDialect,
} from '../../src/features/editor-code/configModes';
import { loadEditorLanguage } from '../../src/features/editor-code/languages';

/** 逐行跑解析器，返回 [文本, 着色] 列表（跳过空白与无着色片段） */
function tokenize<S>(parser: StreamParser<S>, text: string): Array<[string, string]> {
  const state = parser.startState!(2);
  const out: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      const style = parser.token(stream, state);
      const piece = stream.current();
      if (style) out.push([piece, style]);
      stream.start = stream.pos;
    }
  }
  return out;
}

describe('resolveConfigDialect', () => {
  it.each([
    ['C:\\etc\\app.conf', 'config'],
    ['settings.ini', 'config'],
    ['.env', 'config'],
    ['.env.local', 'config'],
    ['.editorconfig', 'config'],
    ['nginx.conf', 'nginx'],
    ['sites/nginx-default.conf', 'nginx'],
    ['Cargo.toml', 'toml'],
    ['Cargo.lock', 'toml'],
    ['deploy.sh', 'shell'],
    ['.bashrc', 'shell'],
    ['build.ps1', 'powershell'],
    ['Dockerfile', 'dockerfile'],
    ['Dockerfile.dev', 'dockerfile'],
    ['fix.patch', 'diff'],
    ['CMakeLists.txt', 'cmake'],
    ['.gitignore', 'ignore'],
    ['sshd_config', 'config'],
  ])('%s → %s', (name, dialect) => {
    expect(resolveConfigDialect(name)).toBe(dialect);
  });

  it('未知或纯文本文件返回 null', () => {
    expect(resolveConfigDialect('notes.txt')).toBeNull();
    expect(resolveConfigDialect('server.log')).toBeNull();
    expect(resolveConfigDialect('README')).toBeNull();
  });

  it('.conf 内容像 nginx 时识别为 nginx', () => {
    expect(resolveConfigDialect('site.conf', 'server {\n  listen 80;\n}\n')).toBe('nginx');
    expect(resolveConfigDialect('site.conf', 'worker_processes auto;\n')).toBe('nginx');
  });

  it('.config 为 XML 时按 XML 高亮，Apache 的 <VirtualHost> 不误判', () => {
    expect(resolveConfigDialect('web.config', '<?xml version="1.0"?>\n<configuration/>')).toBe('xml');
    expect(resolveConfigDialect('app.config', '<configuration>\n</configuration>')).toBe('xml');
    expect(resolveConfigDialect('vhost.conf', '<VirtualHost *:80>\n</VirtualHost>')).toBe('config');
  });
});

describe('configParser', () => {
  it('INI：段落头、键、值、注释', () => {
    const tokens = tokenize(configParser, '; 注释\n[server]\nport = 8080\nname = demo\ndebug = true');
    expect(tokens).toEqual([
      ['; 注释', 'comment'],
      ['[server]', 'heading'],
      ['port', 'propertyName'],
      ['=', 'operator'],
      ['8080', 'number'],
      ['name', 'propertyName'],
      ['=', 'operator'],
      ['demo', 'string'],
      ['debug', 'propertyName'],
      ['=', 'operator'],
      ['true', 'bool'],
    ]);
  });

  it('.env：export 关键字与变量引用', () => {
    const tokens = tokenize(configParser, 'export API_URL=https://a.com\nHOME_DIR=${HOME}/x');
    expect(tokens).toEqual([
      ['export', 'keyword'],
      ['API_URL', 'propertyName'],
      ['=', 'operator'],
      ['https://a.com', 'url'],
      ['HOME_DIR', 'propertyName'],
      ['=', 'operator'],
      ['${HOME}', 'variableName.special'],
      ['/x', 'string'],
    ]);
  });

  it('空格分隔的指令式配置（redis / sshd）', () => {
    const tokens = tokenize(configParser, 'maxmemory 2gb\nPermitRootLogin no  # 禁止 root');
    expect(tokens).toEqual([
      ['maxmemory', 'propertyName'],
      ['2gb', 'number'],
      ['PermitRootLogin', 'propertyName'],
      ['no', 'bool'],
      ['# 禁止 root', 'comment'],
    ]);
  });

  it('行内 #fff 与 URL 中的 // 不当作注释', () => {
    const tokens = tokenize(configParser, 'color = #fff\nurl = http://x.com/a');
    expect(tokens.find(([, s]) => s === 'comment')).toBeUndefined();
  });

  it('花括号块内每条指令都识别为键名，引号串紧跟 = 时为键', () => {
    const tokens = tokenize(configParser, 'resource "a" {\n  count = 2\n}\n"Name"="v"');
    expect(tokens).toContainEqual(['count', 'propertyName']);
    expect(tokens).toContainEqual(['"a"', 'string']);
    expect(tokens).toContainEqual(['"Name"', 'propertyName']);
    expect(tokens).toContainEqual(['"v"', 'string']);
  });

  it('Apache 区段标签的尖括号单独着色', () => {
    const tokens = tokenize(configParser, '<VirtualHost *:80>\n</VirtualHost>');
    expect(tokens).toEqual([
      ['<VirtualHost', 'tagName'],
      ['>', 'bracket'],
      ['</VirtualHost', 'tagName'],
      ['>', 'bracket'],
    ]);
  });

  it('块注释跨行', () => {
    const tokens = tokenize(configParser, '/* a\nb */ key = 1');
    expect(tokens.slice(0, 2)).toEqual([['/* a', 'comment'], ['b */', 'comment']]);
    expect(tokens).toContainEqual(['key', 'propertyName']);
  });
});

describe('ignoreParser', () => {
  it('注释、取反与通配符', () => {
    const tokens = tokenize(ignoreParser, '# deps\nnode_modules/\n!keep.log\n**/*.tmp');
    expect(tokens).toEqual([
      ['# deps', 'comment'],
      ['/', 'punctuation'],
      ['!', 'keyword'],
      ['**', 'regexp'],
      ['/', 'punctuation'],
      ['*', 'regexp'],
    ]);
  });
});

describe('懒加载', () => {
  it.each(['config', 'ignore', 'nginx', 'toml', 'shell', 'powershell', 'dockerfile', 'diff', 'cmake', 'xml'] as const)(
    '%s 方言可加载',
    async (dialect) => {
      await expect(loadConfigDialect(dialect)).resolves.toBeDefined();
    },
  );

  it('纯文本按文件名走方言，非纯文本语言不受影响', async () => {
    const conf = await loadEditorLanguage('plaintext', 'a.conf');
    expect(conf).toBe(await loadConfigDialect('config'));
    const txt = await loadEditorLanguage('plaintext', 'a.txt');
    expect(txt).not.toBe(conf);
  });
});
