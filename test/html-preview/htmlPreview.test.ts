// NoteBoard HTML 安全预览文档构建测试
// 覆盖：脚本与自动跳转移除、本地相对资源改写、本地样式表内联、网络地址保持原样、未保存文档不改写

import { describe, it, expect, vi } from 'vitest';
import { buildHtmlPreviewDocument, isLocalReference, rewriteCssUrls, type HtmlPreviewEnv } from '@/features/html-preview/htmlPreview';

/** 简化的 POSIX 路径解析，便于断言 */
function resolvePath(baseDir: string, rel: string): string {
  if (rel.startsWith('/')) return rel;
  const parts = baseDir.split('/').filter(Boolean);
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function createEnv(overrides: Partial<HtmlPreviewEnv> = {}): HtmlPreviewEnv {
  return {
    baseDir: '/site/pages',
    resolvePath,
    toResourceUrl: (abs) => `asset://${abs}`,
    readText: vi.fn(async () => null),
    ...overrides,
  };
}

describe('isLocalReference', () => {
  it('区分本地路径与网络 / 内联地址', () => {
    expect(isLocalReference('img/a.png')).toBe(true);
    expect(isLocalReference('../a.png')).toBe(true);
    expect(isLocalReference('C:\\pics\\a.png')).toBe(true);
    expect(isLocalReference('file:///C:/a.png')).toBe(true);
    expect(isLocalReference('https://example.com/a.png')).toBe(false);
    expect(isLocalReference('//cdn.example.com/a.png')).toBe(false);
    expect(isLocalReference('data:image/png;base64,AAA')).toBe(false);
    expect(isLocalReference('#top')).toBe(false);
    expect(isLocalReference('')).toBe(false);
  });
});

describe('buildHtmlPreviewDocument', () => {
  it('移除脚本、自动跳转与源码自带的 base', async () => {
    const html = await buildHtmlPreviewDocument(
      '<!DOCTYPE html><html><head><base href="https://x/"><meta http-equiv="refresh" content="0;url=https://x"><script>alert(1)</script></head><body><p onclick="x()">hi</p><script src="a.js"></script></body></html>',
      createEnv(),
    );
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http-equiv');
    expect(html).not.toContain('<base');
    expect(html).toContain('<p onclick="x()">hi</p>');
  });

  it('没有 doctype 的源码保持怪异模式（不补 doctype）', async () => {
    const html = await buildHtmlPreviewDocument('<p>plain</p>', createEnv());
    expect(html.startsWith('<html>')).toBe(true);
    expect(html).toContain('<p>plain</p>');
  });

  it('本地相对图片、srcset、poster 与行内背景改写为资源地址，网络地址保持原样', async () => {
    const html = await buildHtmlPreviewDocument(
      [
        '<img id="a" src="img/a.png?v=2">',
        '<img id="b" src="https://example.com/b.png">',
        '<img id="c" srcset="img/c.png 1x, ../d.png 2x">',
        '<video poster="cover.jpg"></video>',
        '<div style="background: url(\'bg.png\')"></div>',
        '<style>body { background: url(../bg2.png); } .x { background: url(data:image/png;base64,AA); }</style>',
      ].join(''),
      createEnv(),
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.getElementById('a')?.getAttribute('src')).toBe('asset:///site/pages/img/a.png');
    expect(doc.getElementById('b')?.getAttribute('src')).toBe('https://example.com/b.png');
    expect(doc.getElementById('c')?.getAttribute('srcset')).toBe('asset:///site/pages/img/c.png 1x, asset:///site/d.png 2x');
    expect(doc.querySelector('video')?.getAttribute('poster')).toBe('asset:///site/pages/cover.jpg');
    expect(doc.querySelector('div')?.getAttribute('style')).toContain("url('asset:///site/pages/bg.png')");
    const css = doc.querySelector('style')?.textContent ?? '';
    expect(css).toContain('url(asset:///site/bg2.png)');
    expect(css).toContain('url(data:image/png;base64,AA)');
  });

  it('本地样式表读出后内联，其中的 url() 以样式表所在目录为基准；读取失败与网络样式表保留 link', async () => {
    const readText = vi.fn(async (abs: string) => (abs === '/site/css/main.css' ? '.logo { background: url(img/logo.png); }' : null));
    const html = await buildHtmlPreviewDocument(
      '<html><head><link rel="stylesheet" href="../css/main.css" media="screen"><link rel="stylesheet" href="missing.css"><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body></body></html>',
      createEnv({ readText }),
    );
    expect(readText).toHaveBeenCalledWith('/site/css/main.css');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const style = doc.querySelector('style[data-nb-source="../css/main.css"]');
    expect(style?.getAttribute('media')).toBe('screen');
    expect(style?.textContent).toContain('url(asset:///site/css/img/logo.png)');
    expect(doc.querySelector('link[href="missing.css"]')).not.toBeNull();
    expect(doc.querySelector('link[href="https://cdn.example.com/x.css"]')).not.toBeNull();
  });

  it('未保存的文档没有基准目录：相对资源保持原样且不读取文件', async () => {
    const readText = vi.fn(async () => 'body{}');
    const html = await buildHtmlPreviewDocument(
      '<link rel="stylesheet" href="a.css"><img src="a.png">',
      createEnv({ baseDir: null, readText }),
    );
    expect(readText).not.toHaveBeenCalled();
    expect(html).toContain('src="a.png"');
    expect(html).toContain('href="a.css"');
  });
});

describe('rewriteCssUrls', () => {
  it('保留引号写法并跳过锚点引用', () => {
    const env = createEnv();
    expect(rewriteCssUrls('a{b:url("x.png")} c{fill:url(#grad)}', '/root', env)).toBe('a{b:url("asset:///root/x.png")} c{fill:url(#grad)}');
  });
});
