// NoteBoard 块级原始 HTML 渲染预览测试
// 约束：渲染只影响显示——危险内容被过滤、不完整片段按源码展示，raw 原文往返逐字不变。

import { afterAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { isBalancedHtml, renderRawHtmlPreview } from '../../src/features/editor-md/rawHtmlRender';

/** 取渲染结果 HTML，非渲染结果时测试失败 */
function renderedHtml(raw: string, resolveSrc?: (src: string) => string): string {
  const preview = renderRawHtmlPreview(raw, resolveSrc);
  if (preview.kind !== 'render') throw new Error(`期望渲染，实际为：${preview.kind === 'source' ? preview.reason : preview.kind}`);
  return preview.html;
}

describe('块级 HTML：可渲染内容', () => {
  it('README 常见的居中标题与换行', () => {
    const html = renderedHtml('<p align="center"><b>在你自己的电脑上运行</b><br>\nNVIDIA 或 AMD 显卡</p>');
    expect(html).toContain('<p align="center"><b>在你自己的电脑上运行</b><br>');
  });

  it('链接 + 图片 + sub，本地图片地址经解析器改写，链接地址保持原文', () => {
    const raw = '<p align="center"><a href="https://example.com/v.mp4"><img src="docs/media/a.webp" width="720" alt="预览"></a><br>\n<sub>说明 · <a href="https://example.com/v.mp4">完整视频</a></sub></p>';
    const html = renderedHtml(raw, (src) => `asset://${src}`);
    expect(html).toContain('src="asset://docs/media/a.webp"');
    expect(html).toContain('width="720"');
    expect(html).toContain('draggable="false"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('href="https://example.com/v.mp4"');
    expect(html).toContain('<sub>');
  });

  it('picture/source 的 srcset 逐项解析并保留描述符', () => {
    const raw = '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png 1x, dark@2x.png 2x"><img src="light.png"></picture>';
    const html = renderedHtml(raw, (src) => `r/${src}`);
    expect(html).toContain('srcset="r/dark.png 1x, r/dark@2x.png 2x"');
    expect(html).toContain('src="r/light.png"');
  });

  it('height 属性改写为内联尺寸，已有内联高度时不覆盖', () => {
    expect(renderedHtml('<a href="https://a.example"><img src="b.svg" height="40"></a>')).toContain('style="height: 40px;"');
    expect(renderedHtml('<p><img src="b.svg" height="50%"></p>')).toContain('style="height: 50%;"');
    expect(renderedHtml('<p><img src="b.svg" height="40" style="height: 10px"></p>')).toContain('height: 10px');
  });

  it('只有图片、没有文字也算可见内容', () => {
    expect(renderRawHtmlPreview('<div align="center"><img src="a.png"></div>').kind).toBe('render');
  });
});

describe('块级 HTML：安全过滤', () => {
  it.each([
    ['脚本标签', '<div>x<script>alert(1)</script></div>', '<script'],
    ['事件属性', '<div><img src="a.png" onerror="alert(1)"></div>', 'onerror'],
    ['javascript 链接', '<p><a href="javascript:alert(1)">x</a></p>', 'javascript:'],
    ['iframe', '<div>x<iframe src="https://evil.example"></iframe></div>', '<iframe'],
    ['表单控件', '<div>x<form><input value="1"><button>b</button></form></div>', '<input'],
    ['style 标签', '<div>x<style>body{display:none}</style></div>', '<style'],
    ['target 属性', '<p><a href="https://a.example" target="_blank">x</a></p>', 'target='],
  ])('%s被移除', (_name, raw, forbidden) => {
    expect(renderedHtml(raw)).not.toContain(forbidden);
  });

  it('过滤后无可见内容时按源码展示', () => {
    expect(renderRawHtmlPreview('<script>alert(1)</script>')).toEqual({ kind: 'source', reason: 'empty' });
  });
});

describe('块级 HTML：按源码展示的情形', () => {
  it('纯注释块', () => {
    expect(renderRawHtmlPreview('<!-- 注释 -->\n<!-- 第二条 -->')).toEqual({ kind: 'source', reason: 'comment' });
  });

  it.each([
    ['只有开始标签', '<div align="center">'],
    ['只有结束标签', '</div>'],
    ['非标准折叠块的头部', '<details>\n<summary><b>x</b></summary>'],
  ])('%s', (_name, raw) => {
    expect(renderRawHtmlPreview(raw)).toEqual({ kind: 'source', reason: 'fragment' });
  });
});

describe('标签配对判断', () => {
  it.each([
    ['空元素与自闭合', '<p>a<br>b<img src="x"/><hr></p>', true],
    ['可省略结束标签', '<ul><li>a<li>b</ul>', true],
    ['属性值含 >', '<p title="a > b">x</p>', true],
    ['注释中的标签不计', '<div><!-- <span> --></div>', true],
    ['交叉嵌套', '<div><span></div></span>', false],
    ['缺少结束标签', '<div><span>x</div>', false],
  ])('%s', (_name, raw, expected) => {
    expect(isBalancedHtml(raw)).toBe(expected);
  });
});

describe('块级 HTML：往返逐字不变', () => {
  const editor = new Editor({ element: null, extensions: buildExtensions('raw-html-test'), content: '' });
  afterAll(() => editor.destroy());

  it.each([
    ['居中段落', '<p align="center"><b>标题</b><br>\n副标题</p>\n\n正文'],
    ['含危险内容的块', '<div>x<script>alert(1)</script></div>\n\nafter'],
    ['拆开的 div 包裹 Markdown', '<div align="center">\n\n# 标题\n\n</div>'],
  ])('%s', (_name, markdown) => {
    expect(parseMarkdown(editor, markdown)).toBe(true);
    expect(serializeMarkdown(editor)).toBe(markdown);
  });

  // 此前段落内的 <img> 与 `<a><img></a>` 会被整个丢弃，规范化后变成空行
  it.each([
    ['行首链接包裹图片', 'before\n\n<a href="https://x.example"><img src="https://y.example/a.png" alt="A" width="150"></a>\n\nafter', 1],
    ['同一段落两个徽章', '<a href="https://x.example"><img src="a.png"></a> <a href="https://z.example"><img src="b.png"></a>', 2],
    ['文字中的图片', 'text <img src="a.png" alt="A"> more', 1],
    ['文字中的链接图片', 'text <a href="https://x.example"><img src="a.png"></a> more', 1],
  ])('段落内图片：%s', (_name, markdown, count) => {
    expect(parseMarkdown(editor, markdown)).toBe(true);
    expect(serializeMarkdown(editor)).toBe(markdown);
    const raws: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'rawHtmlInline') raws.push(String(node.attrs.raw));
    });
    expect(raws.filter((raw) => raw.includes('<img'))).toHaveLength(count);
  });

  it('不含图片的 <a> 仍转为普通链接', () => {
    expect(parseMarkdown(editor, '<a href="https://x.example">文字</a> tail')).toBe(true);
    expect(serializeMarkdown(editor)).toBe('[文字](https://x.example) tail');
  });
});

describe('块级 HTML：复杂内容隔离渲染', () => {
  /** 取隔离渲染结果，非隔离结果时测试失败 */
  function isolated(raw: string, resolveSrc?: (src: string) => string) {
    const preview = renderRawHtmlPreview(raw, resolveSrc, { isolate: true });
    if (preview.kind !== 'isolated') throw new Error(`期望隔离渲染，实际为：${preview.kind}`);
    return preview;
  }

  it('自带样式表时保留 <style> 与 class', () => {
    const preview = isolated('<style>.card { color: red; }</style>\n<div class="card" id="c">x</div>');
    expect(preview.styles).toEqual(['.card { color: red; }']);
    expect(preview.html).toContain('class="card"');
    expect(preview.html).toContain('id="c"');
    expect(preview.html).not.toContain('<style');
  });

  it('整页文档：head 样式提取，body 改写为容器并保留属性，html/body 选择器指向宿主与容器', () => {
    const preview = isolated('<!DOCTYPE html>\n<html><head><title>T</title><style>body { margin: 0 } html, :root { color: red } .body-x { color: blue }</style></head>\n<body class="dark" style="padding: 8px"><p>x</p></body></html>');
    expect(preview.html).toMatch(/^<div class="dark nb-html-body" style="padding: 8px;?">/);
    expect(preview.html).toContain('<p>x</p>');
    expect(preview.html).not.toContain('<title');
    const css = preview.styles.join('\n');
    expect(css).toContain('.nb-html-body { margin: 0');
    expect(css).toContain(':host, :host { color: red');
    expect(css).toContain('.body-x');
  });

  it('SVG 内联图形可渲染', () => {
    const preview = isolated('<div><svg viewBox="0 0 10 10" width="10"><circle cx="5" cy="5" r="4" fill="red"/></svg></div>');
    expect(preview.html).toContain('<circle');
  });

  it.each([
    ['脚本', '<style>a{}</style><div>x<script>alert(1)</script></div>', '<script'],
    ['事件属性', '<style>a{}</style><div><img src="a.png" onerror="alert(1)"></div>', 'onerror'],
    ['javascript 链接', '<style>a{}</style><p><a href="javascript:alert(1)">x</a></p>', 'javascript:'],
    ['iframe', '<style>a{}</style><div>x<iframe src="https://evil.example"></iframe></div>', '<iframe'],
    ['表单输入', '<style>a{}</style><div>x<form><input value="1"><textarea></textarea></form></div>', '<input'],
    ['popover 调用者', '<style>a{}</style><div><button popovertarget="p">b</button><div popover id="p">x</div></div>', 'popovertarget'],
    ['悬停调用者', '<style>a{}</style><div><a href="#" interestfor="p">b</a><div popover id="p">x</div></div>', 'interestfor'],
    ['命令调用', '<style>a{}</style><div><button commandfor="d" command="show-modal">b</button></div>', 'command'],
    ['图像热区链接', '<style>a{}</style><div><img src="a.png" usemap="#m"><map name="m"><area href="https://a.example"></map></div>', '<area'],
    ['自动播放', '<style>a{}</style><div><video src="a.mp4" autoplay></video></div>', 'autoplay'],
    ['meta 跳转', '<head><meta http-equiv="refresh" content="0;url=https://a.example"><style>a{}</style></head><body>x</body>', '<meta'],
  ])('%s被移除', (_name, raw, forbidden) => {
    const preview = isolated(raw);
    expect(preview.html).not.toContain(forbidden);
  });

  it('样式表中的 </style> 不会逃逸为 HTML', () => {
    const preview = isolated('<style>p::after { content: "</sty" "le><img src=x onerror=alert(1)>" }</style><p>x</p>');
    expect(preview.html).not.toContain('onerror');
  });

  it('本地媒体地址经解析器改写', () => {
    const preview = isolated('<style>a{}</style><div><img src="a.png"><video src="v.mp4" poster="p.png"></video></div>', (src) => `asset://${src}`);
    expect(preview.html).toContain('src="asset://a.png"');
    expect(preview.html).toContain('src="asset://v.mp4"');
    expect(preview.html).toContain('poster="asset://p.png"');
  });

  it('未开启隔离时维持原有白名单渲染', () => {
    expect(renderRawHtmlPreview('<div class="x">a<style>p{}</style></div>').kind).toBe('render');
  });

  it('普通 README 写法不走隔离渲染', () => {
    expect(renderRawHtmlPreview('<p align="center"><b>标题</b></p>', undefined, { isolate: true }).kind).toBe('render');
  });

  it('过滤后无可见内容时按源码展示', () => {
    expect(renderRawHtmlPreview('<style>a{}</style>', undefined, { isolate: true })).toEqual({ kind: 'source', reason: 'empty' });
  });
});
