// NoteBoard HTML 安全预览文档构建
// 把 .html 源码整理成 iframe srcdoc：移除脚本与自动跳转，本地相对资源改写为 webview 可加载的地址，
// 本地样式表（含嵌套 @import）读出后内联（应用 CSP 不允许从 asset 协议加载样式表）。
// 纯函数：路径解析、地址转换与文件读取由调用方注入，桌面 / 移动 / 网页端各自提供实现。

/** 预览构建所需的平台能力 */
export interface HtmlPreviewEnv {
  /** HTML 文件所在目录；未保存的文档为 null，此时相对资源保持原样 */
  baseDir: string | null;
  /** 基于目录解析相对路径为绝对路径 */
  resolvePath: (baseDir: string, relativePath: string) => string;
  /** 本地绝对路径 → webview 可加载的地址（桌面 asset 协议 / 网页 /api/file） */
  toResourceUrl: (absPath: string) => string;
  /** 读取本地文本文件（内联样式表用）；失败返回 null */
  readText: (absPath: string) => Promise<string | null>;
  /** 本地样式表（含 @import）读取失败时回调原始引用地址，供界面提示 */
  onStyleMissing?: (ref: string) => void;
}

// 带协议头（http:、data:、blob:、mailto: 等）或协议相对（//cdn）的地址不是本地相对路径
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
// CSS 中的 url(...) 引用
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
// 需要改写 src 的媒体元素
const SRC_SELECTOR = 'img[src], source[src], video[src], audio[src], track[src], input[type="image"][src], embed[src]';
// @import 最大嵌套层数，防止异常深的引用链拖慢预览
const MAX_IMPORT_DEPTH = 8;
// 样式表开头的前导语句：空白、注释、@charset、@layer 声明与 @import（按规范 @import 只能出现在这一段）
// 分组：3 = url() 形式地址，5 = 字符串形式地址，6 = layer / supports / 媒体查询条件
const CSS_PRELUDE_PATTERN =
  /^(?:\s+|\/\*[\s\S]*?\*\/|@charset\s+(['"]).*?\1\s*;|@layer\s+[^;{]+;|@import\s+(?:url\(\s*(['"]?)([^'")]+?)\2\s*\)|(['"])(.+?)\4)([^;]*);)/i;

/** 是否为需要解析的本地路径（相对路径、本地绝对路径或 file: 地址） */
export function isLocalReference(url: string): boolean {
  const value = url.trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return false;
  // Windows 盘符路径（C:\ 或 C:/）形似协议头，单独放行
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (/^file:/i.test(value)) return true;
  return !SCHEME_PATTERN.test(value);
}

/** 去掉 ?query 与 #hash，只保留文件路径部分 */
function stripQuery(url: string): string {
  return url.trim().replace(/[?#].*$/, '');
}

/** 取绝对路径所在目录（兼容 \ 与 / 分隔） */
function dirOf(absPath: string): string {
  const index = Math.max(absPath.lastIndexOf('\\'), absPath.lastIndexOf('/'));
  return index > 0 ? absPath.slice(0, index) : absPath;
}

/** 本地引用 → 资源地址；无法解析时返回原值 */
function resolveResource(url: string, baseDir: string | null, env: HtmlPreviewEnv): string {
  if (!baseDir || !isLocalReference(url)) return url;
  const path = stripQuery(url);
  if (!path) return url;
  try {
    return env.toResourceUrl(env.resolvePath(baseDir, path));
  } catch {
    return url;
  }
}

/** 改写 CSS 文本中的本地 url() 引用（相对路径以样式所在目录为基准） */
export function rewriteCssUrls(css: string, baseDir: string | null, env: HtmlPreviewEnv): string {
  if (!baseDir) return css;
  return css.replace(CSS_URL_PATTERN, (match, quote: string, url: string) => {
    const resolved = resolveResource(url, baseDir, env);
    return resolved === url ? match : `url(${quote}${resolved}${quote})`;
  });
}

/** 改写 srcset 中每个候选地址（"a.png 1x, b.png 2x"） */
function rewriteSrcset(srcset: string, baseDir: string, env: HtmlPreviewEnv): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (!parts[0]) return candidate;
      parts[0] = resolveResource(parts[0], baseDir, env);
      return parts.join(' ');
    })
    .join(', ');
}

/** 把 @import 的条件（layer / supports / 媒体查询）还原为包裹内联内容的规则块 */
function wrapImportConditions(css: string, conditions: string): string {
  let rest = conditions.trim();
  let layer: string | null = null;
  let supports: string | null = null;

  // layer 或 layer(name)：不带名称为匿名层
  const layerMatch = /^layer(?:\(([^)]*)\)|\b)/i.exec(rest);
  if (layerMatch) {
    layer = layerMatch[1]?.trim() ?? '';
    rest = rest.slice(layerMatch[0].length).trim();
  }

  // supports(...) 条件内可能嵌套括号，按括号配对截取
  if (/^supports\(/i.test(rest)) {
    let depth = 0;
    for (let i = 'supports'.length; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) {
        supports = rest.slice('supports('.length, i).trim();
        rest = rest.slice(i + 1).trim();
        break;
      }
    }
  }

  // 由内向外：层 → 特性查询 → 媒体查询
  let result = css;
  if (layer !== null) result = `@layer ${layer ? `${layer} ` : ''}{\n${result}\n}`;
  if (supports) result = `@supports (${supports}) {\n${result}\n}`;
  if (rest) result = `@media ${rest} {\n${result}\n}`;
  return result;
}

/**
 * 递归内联样式文本中的本地 @import，并以 cssDir 为基准改写 url()。
 * ancestors 为当前引用链上的样式表绝对路径，用于识别循环引用。
 */
async function inlineCss(css: string, cssDir: string, env: HtmlPreviewEnv, ancestors: string[]): Promise<string> {
  // 保留的前导语句（网络 @import、@layer 声明）必须位于内联内容之前，否则浏览器会忽略
  const kept: string[] = [];
  const imported: string[] = [];
  let rest = css;
  for (let match = CSS_PRELUDE_PATTERN.exec(rest); match; match = CSS_PRELUDE_PATTERN.exec(rest)) {
    rest = rest.slice(match[0].length);
    const ref = match[3] ?? match[5];
    if (ref === undefined) {
      // 空白、注释与 @charset 丢弃（内联后 @charset 不再生效），@layer 顺序声明保留
      if (/^@layer/i.test(match[0])) kept.push(match[0]);
      continue;
    }
    if (!isLocalReference(ref)) {
      kept.push(match[0]);
      continue;
    }
    const inlined = await loadStylesheet(ref, cssDir, env, ancestors);
    if (inlined !== null) imported.push(wrapImportConditions(inlined, match[6] ?? ''));
  }
  return [...kept, ...imported, rewriteCssUrls(rest, cssDir, env)].filter(Boolean).join('\n');
}

/** 读取本地样式表并递归内联；读取失败、循环引用或嵌套过深时返回 null */
async function loadStylesheet(
  ref: string,
  fromDir: string,
  env: HtmlPreviewEnv,
  ancestors: string[],
): Promise<string | null> {
  const path = stripQuery(ref);
  if (!path) return null;
  let absPath: string;
  try {
    absPath = env.resolvePath(fromDir, path);
  } catch {
    env.onStyleMissing?.(ref);
    return null;
  }
  // 循环引用与过深嵌套直接跳过，与浏览器忽略循环 @import 的行为一致，不算缺失
  if (ancestors.includes(absPath) || ancestors.length >= MAX_IMPORT_DEPTH) return null;
  const css = await env.readText(absPath);
  if (css === null) {
    env.onStyleMissing?.(ref);
    return null;
  }
  return inlineCss(css, dirOf(absPath), env, [...ancestors, absPath]);
}

/**
 * 构建安全预览用的完整 HTML 文档字符串。
 * 预览 iframe 已禁用脚本，这里仍移除 <script>，避免应用 CSP 拦截时刷出控制台报错。
 */
export async function buildHtmlPreviewDocument(source: string, env: HtmlPreviewEnv): Promise<string> {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const { baseDir } = env;

  // 脚本、自动跳转与源码自带的 <base> 一律移除：前两者在预览中不应生效，<base> 会干扰相对路径解析
  doc.querySelectorAll('script, noscript, base, meta[http-equiv="refresh" i]').forEach((el) => el.remove());

  if (baseDir) {
    // 媒体资源
    doc.querySelectorAll(SRC_SELECTOR).forEach((el) => {
      const src = el.getAttribute('src');
      if (src) el.setAttribute('src', resolveResource(src, baseDir, env));
    });
    doc.querySelectorAll('img[srcset], source[srcset]').forEach((el) => {
      const srcset = el.getAttribute('srcset');
      if (srcset) el.setAttribute('srcset', rewriteSrcset(srcset, baseDir, env));
    });
    doc.querySelectorAll('video[poster]').forEach((el) => {
      const poster = el.getAttribute('poster');
      if (poster) el.setAttribute('poster', resolveResource(poster, baseDir, env));
    });

    // 行内样式与 <style> 中的背景图、字体等
    doc.querySelectorAll('[style]').forEach((el) => {
      const style = el.getAttribute('style');
      if (style && style.includes('url(')) el.setAttribute('style', rewriteCssUrls(style, baseDir, env));
    });
    // <style> 中的 @import 同样内联（以 HTML 所在目录为基准）
    const styles = Array.from(doc.querySelectorAll('style'));
    await Promise.all(
      styles.map(async (el) => {
        const text = el.textContent ?? '';
        if (text.includes('url(') || /@import/i.test(text)) el.textContent = await inlineCss(text, baseDir, env, []);
      }),
    );

    // 本地样式表读出后替换为 <style>（保持原有顺序与 media 条件）；读取失败保留 link
    const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]'));
    await Promise.all(
      links.map(async (link) => {
        const href = link.getAttribute('href') ?? '';
        if (!isLocalReference(href)) return;
        const css = await loadStylesheet(href, baseDir, env, []);
        if (css === null) return;
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.setAttribute('data-nb-source', href);
        style.textContent = css;
        link.replaceWith(style);
      }),
    );
  }

  // 保留原文档的渲染模式：有 doctype 走标准模式，没有则与浏览器一样进入怪异模式
  const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
  return doctype + doc.documentElement.outerHTML;
}
