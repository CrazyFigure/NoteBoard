// 大文档准备回归：完整语法往返、可中断装载、程序事务保护以及后台线程的清理。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { mountVisualDocument, prepareVisualDocument } from '../../src/features/editor-md/visualPreparation';
import { prepareVisualDocumentData } from '../../src/features/editor-md/visualPreparationData';

const editors: Editor[] = [];
/** 使用真实 schema 与事务的 headless 内核验证内容；DOM 布局与交互另在真实浏览器验证。 */
function createEditor(): Editor {
  const editor = new Editor({ element: null, extensions: buildExtensions(), content: '' });
  // Tiptap 把“没有真实视图”也视为 isDestroyed；此处仍通过它的官方代理视图分派真实事务。
  Object.defineProperty(editor, 'isDestroyed', { value: false });
  editors.push(editor);
  return editor;
}
afterEach(() => { editors.splice(0).forEach((editor) => editor.destroy()); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('大文档可视化准备', () => {
  it('后台数据与正式编辑器的完整语法、原文属性及序列化结果一致', async () => {
    const content = '# 标题\n\n* 列表一\n* 列表二\n\n| 项目 | 说明 |\n| --- | --- |\n| 一 | **重点** |\n\n> [!TIP]\n> 提示\n\n```ts\nconst x = 1\n```\n\n[[笔记]] 与 $x$\n';
    const stages: string[] = [];
    const prepared = await prepareVisualDocumentData(content, async (stage) => { stages.push(stage); });
    const editor = createEditor();
    expect(parseMarkdown(editor, content)).toBe(true);
    expect(prepared.serialized).toBe(serializeMarkdown(editor));
    expect(prepared.document.attrs?.trailingNewline).toBe('\n');
    expect(prepared.stable).toBe(true);
    expect(prepared.diff?.hunks.length).toBeGreaterThan(0);
    expect(stages).toEqual(['parsing', 'checking', 'comparing']);
  });

  it('分批装载列表和表格，完成后与一次性解析一致，事务始终处于程序锁内', async () => {
    const content = Array.from({ length: 80 }, (_, index) => `## 标题 ${index}\n\n- 一\n- 二\n\n| 项目 | 说明 |\n| --- | --- |\n| 一 | 二 |`).join('\n\n');
    const prepared = await prepareVisualDocumentData(content, async () => {});
    const editor = createEditor();
    const initializing = { current: false };
    const progress: number[] = [];
    const unsafeTransactions: unknown[] = [];
    editor.on('transaction', ({ transaction }) => {
      if (!initializing.current || transaction.getMeta('addToHistory') !== false) unsafeTransactions.push(transaction);
    });
    await mountVisualDocument(editor, prepared.document, new AbortController().signal, (loaded) => progress.push(loaded), initializing);
    expect(progress.length).toBeGreaterThan(1);
    expect(unsafeTransactions).toEqual([]);
    expect(initializing.current).toBe(false);
    expect(editor.state.selection.from).toBe(1);
    expect(serializeMarkdown(editor)).toBe(prepared.serialized);
  });

  it('取消后停止后续批次，不把部分正文当作完成', async () => {
    const content = Array.from({ length: 1_000 }, (_, index) => `段落 ${index}`).join('\n\n');
    const prepared = await prepareVisualDocumentData(content, async () => {});
    const editor = createEditor();
    const controller = new AbortController();
    const progress = vi.fn(() => controller.abort());
    await expect(mountVisualDocument(editor, prepared.document, controller.signal, progress, { current: false })).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(editor.state.doc.childCount).toBeLessThan(1_000);
  });

  it.each(['list', 'table'])('单个超长 %s 按项或行分批，完成后仍为同一个容器', async (kind) => {
    const container = kind === 'list'
      ? Array.from({ length: 1_000 }, (_, index) => `${index + 7}. 条目 ${index}`).join('\n')
      : '| 项目 | 说明 |\n| --- | --- |\n' + Array.from({ length: 1_000 }, (_, index) => `| ${index} | 正文 |`).join('\n');
    const prepared = await prepareVisualDocumentData(`开头\n\n${container}\n\n结尾\n`, async () => {});
    const editor = createEditor();
    const progress = vi.fn();
    await mountVisualDocument(editor, prepared.document, new AbortController().signal, progress, { current: false });
    expect(progress.mock.calls.length).toBeGreaterThan(2);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe(kind === 'list' ? 'orderedList' : 'table');
    expect(editor.state.doc.child(1).childCount).toBe(kind === 'list' ? 1_000 : 1_001);
    expect(serializeMarkdown(editor)).toBe(prepared.serialized);
  });

  it('超大单块在生成 DOM 前拒绝，保留已有编辑器文档', async () => {
    const editor = createEditor();
    parseMarkdown(editor, '原文');
    const before = editor.state.doc;
    const item = { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '条目' }] }] };
    await expect(mountVisualDocument(editor, { type: 'doc', content: [{ type: 'bulletList', content: Array.from({ length: 34_000 }, () => item) }] }, new AbortController().signal, () => {}, { current: false })).rejects.toThrow('结构过于密集');
    expect(editor.state.doc).toBe(before);
  });
});

describe('正式构建的后台线程生命周期', () => {
  class WorkerStub {
    static instances: WorkerStub[] = [];
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { preventDefault(): void }) => void;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { WorkerStub.instances.push(this); }
  }
  /** 模拟正式构建，必须覆盖真实 Worker 分支，不能只测 Vite 开发兼容路径。 */
  function start() {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('Worker', WorkerStub);
    const controller = new AbortController();
    const onStage = vi.fn();
    const promise = prepareVisualDocument('原文', controller.signal, onStage);
    return { controller, promise, onStage, worker: WorkerStub.instances.at(-1)! };
  }
  it('取消会终止线程，迟到的结果不会继续处理', async () => {
    const { controller, promise, worker, onStage } = start();
    const lateMessage = worker.onmessage!;
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    // 即使浏览器已经排入一条消息，取消后也不能继续持有回调或接受结果。
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    lateMessage({ data: { stage: 'checking' } });
    expect(onStage).not.toHaveBeenCalled();
  });
  it('超时会终止线程并给出源码回退说明', async () => {
    vi.useFakeTimers();
    const { promise, worker } = start();
    const check = expect(promise).rejects.toThrow('准备时间过长');
    await vi.advanceTimersByTimeAsync(60_000);
    await check;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('阶段通知、成功与异常均释放线程和超时计时器', async () => {
    vi.useFakeTimers();
    const task = start();
    task.worker.onmessage!({ data: { stage: 'checking' } });
    expect(task.onStage).toHaveBeenCalledWith('checking');
    task.worker.onmessage!({ data: { result: { serialized: '完成' } } });
    await expect(task.promise).resolves.toMatchObject({ serialized: '完成' });
    expect(task.worker.terminate).toHaveBeenCalledOnce();
    expect(task.worker.onmessage).toBeNull();
    expect(task.worker.postMessage).toHaveBeenCalledWith({ content: '原文' });
    expect(vi.getTimerCount()).toBe(0);
    const failed = start();
    failed.worker.onerror!({ preventDefault() {} });
    await expect(failed.promise).rejects.toThrow('已保留源码');
    expect(failed.worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
