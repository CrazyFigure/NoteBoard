// NoteBoard HTML 安全预览文档构建
// 把 .html 源码整理成 iframe srcdoc：移除脚本与自动跳转，本地相对资源改写为 webview 可加载的地址，
// 本地样式表读出后内联（应用 CSP 不允许从 asset 协议加载样式表）。
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
}

// 带协议头（http:、data:、blob:、mailto: 等）或协议相对（//cdn）的地址不是本地相对路径
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
// CSS 中的 url(...) 引用
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
// 需要改写 src 的媒体元素
const SRC_SELECTOR = 'img[src], source[src], video[src], audio[src], track[src], input[type="image"][src], embed[src]';

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
    doc.querySelectorAll('style').forEach((el) => {
      if (el.textContent?.includes('url(')) el.textContent = rewriteCssUrls(el.textContent, baseDir, env);
    });

    // 本地样式表读出后替换为 <style>（保持原有顺序与 media 条件）
    const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]'));
    await Promise.all(
      links.map(async (link) => {
        const href = link.getAttribute('href') ?? '';
        if (!isLocalReference(href)) return;
        const path = stripQuery(href);
        if (!path) return;
        let absPath: string;
        try {
          absPath = env.resolvePath(baseDir, path);
        } catch {
          return;
        }
        const css = await env.readText(absPath);
        if (css === null) return;
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.setAttribute('data-nb-source', href);
        style.textContent = rewriteCssUrls(css, dirOf(absPath), env);
        link.replaceWith(style);
      }),
    );
  }

  // 保留原文档的渲染模式：有 doctype 走标准模式，没有则与浏览器一样进入怪异模式
  const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
  return doctype + doc.documentElement.outerHTML;
}
