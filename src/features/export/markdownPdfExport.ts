// NoteBoard Markdown 文档导出 PDF
//
// 设计要点：
// 1. 不另起渲染管线：直接克隆可视化编辑器已渲染的正文 DOM（含公式、图表、代码高亮），
//    挂到 body 下的独立打印容器，配合仅在导出期间生效的 @media print 样式隐藏应用界面。
// 2. Windows 桌面端走 Rust print_window_to_pdf（WebView2 PrintToPdf），选好路径后直接写盘；
//    网页端与其他平台回退到 window.print()，由用户在系统打印对话框中选择「另存为 PDF」。
// 3. 公式与图表平时只在进入视口时渲染，导出前先强制激活全部离屏块并等待渲染静止，
//    否则 PDF 里会残留未渲染的占位。
// 4. 暗色主题导出时改用亮色主题变量：纸张页边距固定为白色，深色正文铺在白纸上观感很差。

import type { Editor } from '@tiptap/core';
import { isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import * as ipc from '../../core/ipc/commands';
import { TARGET_PLATFORM } from '../../core/platform';
import { THEMES } from '../../core/theme/themes';
import type { ThemeId } from '../../core/ipc/types';
import { activateWithin } from '../editor-md/viewportActivation';
import { hasPending } from '../editor-md/viewportWorkScheduler';

/** 打印容器与样式节点 ID */
const PRINT_ROOT_ID = 'nb-pdf-root';
const PRINT_STYLE_ID = 'nb-pdf-print-style';
/** 导出期间挂在 <html> 上的标记类，打印样式只在此期间生效 */
const EXPORTING_CLASS = 'nb-pdf-exporting';
/** 暗色主题导出时借用的亮色主题 */
const LIGHT_THEME_ID: ThemeId = 'chen-guang';

/** 等待离屏块渲染的上限与判定静止的时长 */
const RENDER_SETTLE_TIMEOUT_MS = 8000;
const RENDER_QUIET_MS = 300;
/** 单张图片加载等待上限 */
const IMAGE_LOAD_TIMEOUT_MS = 5000;

/** 屏幕上隐藏的打印容器宽度：A4 去掉左右页边距后的近似宽度，供图表等按宽度布局 */
const SCREEN_LAYOUT_WIDTH = 688;

const PRINT_STYLE_TEXT = `
#${PRINT_ROOT_ID} {
  position: fixed;
  left: -100000px;
  top: 0;
  width: ${SCREEN_LAYOUT_WIDTH}px;
  pointer-events: none;
  color: var(--editor-text);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
#${PRINT_ROOT_ID} .ProseMirror {
  max-width: none !important;
  margin: 0 !important;
  padding: 0 !important;
  min-height: 0 !important;
}
#${PRINT_ROOT_ID} .ProseMirror-selectednode { outline: none !important; }
#${PRINT_ROOT_ID} pre,
#${PRINT_ROOT_ID} img,
#${PRINT_ROOT_ID} tr,
#${PRINT_ROOT_ID} .nb-diagram-container,
#${PRINT_ROOT_ID} .nb-infographic-container { break-inside: avoid; }
#${PRINT_ROOT_ID} h1, #${PRINT_ROOT_ID} h2, #${PRINT_ROOT_ID} h3,
#${PRINT_ROOT_ID} h4, #${PRINT_ROOT_ID} h5, #${PRINT_ROOT_ID} h6 { break-after: avoid; }
@media print {
  html.${EXPORTING_CLASS},
  html.${EXPORTING_CLASS} body {
    /* 页边距区域的底色取自 color-scheme 而非 body 背景，暗色主题下必须改回 light 才是白纸 */
    color-scheme: light !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
    background: #ffffff !important;
  }
  html.${EXPORTING_CLASS} body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
  html.${EXPORTING_CLASS} #${PRINT_ROOT_ID} {
    position: static;
    left: auto;
    width: auto;
  }
}
`;

/** 导出参数 */
export interface MarkdownPdfExportOptions {
  /** 另存为对话框的默认路径或文件名（不含扩展名时自动补 .pdf） */
  defaultPath: string;
}

/**
 * 把 Markdown 可视化编辑器的正文导出为 PDF
 * @returns 用户取消另存为时返回 false；回退到系统打印时返回 true（结果由用户在对话框中决定）
 */
export async function exportMarkdownPdf(editor: Editor, options: MarkdownPdfExportOptions): Promise<boolean> {
  const direct = isTauri() && TARGET_PLATFORM === 'windows';

  // 1. 直出模式先选保存路径，用户取消则不做任何渲染准备
  let targetPath: string | null = null;
  if (direct) {
    const defaultPath = /\.pdf$/i.test(options.defaultPath) ? options.defaultPath : `${options.defaultPath}.pdf`;
    targetPath = await save({
      defaultPath,
      filters: [{ name: 'PDF 文档 (*.pdf)', extensions: ['pdf'] }],
    });
    if (!targetPath) return false;
  }

  // 2. 强制渲染全部离屏公式与图表，等待 DOM 静止后再克隆
  const source = editor.view.dom as HTMLElement;
  activateWithin(source);
  await waitForRenderSettled(source);

  // 3. 挂载打印容器
  const root = mountPrintRoot(source);
  try {
    await waitForPrintAssets(root);

    // 4. 输出 PDF
    if (direct && targetPath) {
      await ipc.printWindowToPdf(targetPath);
    } else {
      await printWithDialog();
    }
    return true;
  } finally {
    unmountPrintRoot(root);
  }
}

/** 根据标签页信息生成默认导出路径：已保存文件放在原文件旁，未命名文档只给文件名 */
export function defaultPdfPath(displayName: string, path: string | null): string {
  const base = (path ?? displayName).replace(/\.(md|markdown|mdx|txt)$/i, '');
  return `${base || '未命名'}.pdf`;
}

// ── 渲染就绪等待 ──

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * 等待离屏块渲染完成：视口任务队列清空，且正文 DOM 在一段时间内不再变化
 * 图表渲染是异步的（Mermaid 等），只看任务队列不够，需要配合 DOM 静止判定
 */
async function waitForRenderSettled(target: HTMLElement): Promise<void> {
  const start = performance.now();
  let lastMutation = start;
  const observer = new MutationObserver(() => {
    lastMutation = performance.now();
  });
  observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    while (performance.now() - start < RENDER_SETTLE_TIMEOUT_MS) {
      await delay(100);
      if (!hasPending() && performance.now() - lastMutation >= RENDER_QUIET_MS) break;
    }
  } finally {
    observer.disconnect();
  }
}

/** 等待克隆内容中的图片与字体加载完成，避免 PDF 中出现空白图片 */
async function waitForPrintAssets(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map((img) => {
      if (img.complete) return Promise.resolve();
      return Promise.race([
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
        delay(IMAGE_LOAD_TIMEOUT_MS),
      ]);
    }),
  );
  try {
    await document.fonts.ready;
  } catch {
    // 字体加载失败不阻断导出，使用回退字体
  }
  // 再等两帧，确保新挂载的容器完成布局与绘制
  await nextFrame();
  await nextFrame();
}

// ── 打印容器 ──

/** 克隆正文并清理编辑态控件，挂载到 body 下 */
function mountPrintRoot(source: HTMLElement): HTMLElement {
  ensurePrintStyle();

  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  applyPrintPalette(root);

  const clone = source.cloneNode(true) as HTMLElement;
  syncLiveState(source, clone);
  cleanupClone(clone);
  root.appendChild(clone);

  document.body.appendChild(root);
  document.documentElement.classList.add(EXPORTING_CLASS);
  return root;
}

function unmountPrintRoot(root: HTMLElement): void {
  document.documentElement.classList.remove(EXPORTING_CLASS);
  root.remove();
}

function ensurePrintStyle(): void {
  if (document.getElementById(PRINT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = PRINT_STYLE_TEXT;
  document.head.appendChild(style);
}

/**
 * 同步 cloneNode 带不过去的运行时状态
 * - 复选框：TipTap 任务列表用 checked 属性（property）而非 attribute 记录勾选
 * - canvas：像素内容不随克隆复制，转成图片
 */
function syncLiveState(source: HTMLElement, clone: HTMLElement): void {
  const sourceInputs = source.querySelectorAll('input');
  const cloneInputs = clone.querySelectorAll('input');
  sourceInputs.forEach((input, index) => {
    const target = cloneInputs[index];
    if (!target) return;
    if (input.checked) {
      target.setAttribute('checked', '');
    } else {
      target.removeAttribute('checked');
    }
  });

  const sourceCanvases = source.querySelectorAll('canvas');
  const cloneCanvases = clone.querySelectorAll('canvas');
  sourceCanvases.forEach((canvas, index) => {
    const target = cloneCanvases[index];
    if (!target) return;
    try {
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      img.style.cssText = canvas.style.cssText;
      img.style.width = `${canvas.clientWidth || canvas.width}px`;
      img.style.maxWidth = '100%';
      target.replaceWith(img);
    } catch {
      // 跨域污染的 canvas 无法导出像素，保留原节点
    }
  });
}

/** 去掉编辑态专属的按钮、拖拽柄、选区装饰等，使 PDF 只保留正文内容 */
function cleanupClone(clone: HTMLElement): void {
  clone.removeAttribute('contenteditable');
  clone.removeAttribute('tabindex');
  clone.classList.remove('ProseMirror-focused');

  // 图表块顶部是纯操作条（标题 + 编辑/复制/导出按钮），整条移除
  clone.querySelectorAll('.nb-diagram-container, .nb-infographic-container').forEach((container) => {
    const header = container.firstElementChild;
    if (header && header.querySelector('button')) header.remove();
  });

  clone
    .querySelectorAll(
      'button, .nb-block-drag-handle, .nb-block-drop-indicator, .ProseMirror-gapcursor, input[type="file"]',
    )
    .forEach((el) => el.remove());
  // 代码块头部只保留语言名称，去掉语言选择的下拉箭头
  clone.querySelectorAll('.nb-code-block-header svg').forEach((el) => el.remove());

  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  clone.querySelectorAll('.ProseMirror-selectednode').forEach((el) => el.classList.remove('ProseMirror-selectednode'));

  // 懒加载图片在离屏容器中不会触发加载，改为立即加载
  clone.querySelectorAll('img').forEach((img) => img.setAttribute('loading', 'eager'));
}

/**
 * 暗色主题下在打印容器上覆盖亮色主题变量
 * 主题变量挂在 :root[data-theme] 上，无法按子树切换；这里从样式表中取出基础 :root
 * 与亮色主题的变量声明，写到容器内联样式上，让派生变量（color-mix 等）按亮色重新求值。
 * 用户自定义排版变量写在 <html> 内联样式上，需跳过以免被默认值覆盖。
 */
function applyPrintPalette(root: HTMLElement): void {
  const currentTheme = document.documentElement.dataset.theme as ThemeId | undefined;
  if (!currentTheme || THEMES[currentTheme]?.scheme !== 'dark') return;

  const lightSelector = `:root[data-theme="${LIGHT_THEME_ID}"]`;
  const inlineRootStyle = document.documentElement.style;
  const base: Array<[string, string]> = [];
  const light: Array<[string, string]> = [];

  const collect = (rule: CSSStyleRule, into: Array<[string, string]>) => {
    for (let i = 0; i < rule.style.length; i += 1) {
      const prop = rule.style[i];
      if (!prop.startsWith('--') && prop !== 'color-scheme') continue;
      if (inlineRootStyle.getPropertyValue(prop)) continue;
      into.push([prop, rule.style.getPropertyValue(prop)]);
    }
  };

  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const selectors = rule.selectorText.split(',').map((s) => s.trim());
        if (selectors.includes(':root')) collect(rule, base);
        if (selectors.includes(lightSelector)) collect(rule, light);
      } else if ('cssRules' in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // 跨域样式表不可读，跳过
    }
  }

  // 先基础变量后亮色主题变量，后写入的覆盖先写入的
  for (const [prop, value] of [...base, ...light]) {
    root.style.setProperty(prop, value);
  }
}

// ── 系统打印回退 ──

/** 唤起系统打印对话框，等待打印流程结束后再清理容器 */
function printWithDialog(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('afterprint', finish);
      resolve();
    };
    window.addEventListener('afterprint', finish);
    window.print();
    // 多数浏览器 print() 会阻塞到对话框关闭；不阻塞且不触发 afterprint 的环境给足时间再清理
    setTimeout(finish, 60_000);
  });
}
