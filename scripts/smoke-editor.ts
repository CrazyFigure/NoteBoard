// 冒烟测试：真实复现"新建 MD 文档"路径（Node + jsdom，esbuild 单 bundle）
// 用法：见脚本尾部注释；先设置 jsdom 全局，再创建 TipTap 编辑器
import { JSDOM } from 'jsdom';

// 设置浏览器全局环境（TipTap 需要 document/window）
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;
// node 22 的 globalThis.navigator 只有 getter，需用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
(globalThis as Record<string, unknown>).MutationObserver = dom.window.MutationObserver;
(globalThis as Record<string, unknown>).getSelection = dom.window.getSelection.bind(dom.window);

async function main() {
  const { Editor } = await import('@tiptap/core');
  const { buildExtensions } = await import('../src/features/editor-md/extensions');
  const { parseMarkdown, serializeMarkdown } = await import('../src/features/editor-md/serialize');

  // 1. 模拟新建文档：完整扩展集创建编辑器
  console.log('[1] 创建编辑器（完整 buildExtensions）…');
  const mountEl = document.createElement('div');
  document.body.appendChild(mountEl);
  const editor = new Editor({
    element: mountEl,
    extensions: buildExtensions(),
    content: '',
  });
  console.log('[1] ✅ 编辑器创建成功');

  // 2. 模拟 useEffect 中的 parseMarkdown(editor, '')
  console.log('[2] parseMarkdown(editor, "")…');
  parseMarkdown(editor, '');
  console.log('[2] ✅ 空内容解析成功');

  // 3. 模拟输入 H1
  console.log('[3] 设置 H1 内容…');
  parseMarkdown(editor, '# 一级标题\n\n正文段落\n');
  const out = serializeMarkdown(editor);
  console.log('[3] 序列化结果:', JSON.stringify(out));
  console.log('[3] ✅ H1 往返', out.includes('# 一级标题') ? '保留' : '❌ 丢失');

  editor.destroy();
  console.log('\n=== 冒烟测试全部通过 ===');
}

main().catch((e) => {
  console.error('\n=== 冒烟测试失败 ===');
  console.error(e);
  process.exit(1);
});
