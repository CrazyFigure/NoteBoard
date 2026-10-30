/// <reference types="vite/client" />
// 可视化准备任务的生命周期：正式构建中的大文档只在 Worker 中处理，取消、超时或失败都保留源码。
import type { PreparedVisualDocument, PreparationStage } from './visualPreparation.worker';
import type { Editor, JSONContent } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

/** 后台准备超过一分钟通常表示解析器遇到异常复杂内容，应允许继续使用源码而不是无限等待。 */
const PREPARATION_TIMEOUT_MS = 60_000;
/** 5 万字符起分离准备和装载；普通短文档继续保留原内核的轻量切换与撤销栈。 */
export const VISUAL_PREPARATION_THRESHOLD = 50_000;

/** 创建独占 Worker；所有结束分支都释放线程、计时器及取消监听。 */
export function prepareVisualDocument(content: string, signal: AbortSignal, onStage: (stage: PreparationStage) => void): Promise<PreparedVisualDocument> {
  // 核心扩展不依赖 React 热更新；开发与正式环境均使用可终止的独占线程，不缓存解析器或整篇文档。
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const worker = new Worker(new URL('./visualPreparation.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error?: Error, result?: PreparedVisualDocument) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      // 释放事件闭包对正文和回调的引用，任务完成或取消后不留下常驻 Worker 状态。
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result!);
    };
    const cancel = () => finish(new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('文档准备时间过长，已返回源码模式。可以继续阅读或编辑原文。')), PREPARATION_TIMEOUT_MS);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<{ stage?: PreparationStage; error?: string; result?: PreparedVisualDocument }>) => {
      if (settled) return;
      if (data.error) finish(new Error(data.error));
      else if (data.result) finish(undefined, data.result);
      else if (data.stage) onStage(data.stage);
    };
    worker.onerror = (event) => { event.preventDefault(); finish(new Error('无法准备可视化文档，已保留源码。')); };
    worker.onmessageerror = () => finish(new Error('无法读取可视化准备结果，已保留源码。'));
    // 解析不依赖界面设置；只复制正文，避免向线程克隆整个应用配置。
    try { worker.postMessage({ content }); }
    catch { finish(new Error('无法启动可视化准备任务，已保留源码。')); }
  });
}

/** 让已提交的等待界面先绘制，并在继续下一阶段前核对取消信号。 */
export function yieldVisualTask(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    // 后台窗口的 setTimeout 会被 Chromium 限速到每秒一次；不能让几十批正文平白等待几十秒。
    // MessageChannel 交还任务队列，前台额外跨过一帧，确保阶段文字和取消按钮先完成绘制。
    const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
    let frame: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
      channel?.port1.close();
      channel?.port2.close();
      signal.removeEventListener('abort', finish);
      if (signal.aborted) reject(new DOMException('已取消', 'AbortError'));
      else resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    if (channel) channel.port1.onmessage = finish;
    const post = () => { if (channel) channel.port2.postMessage(null); else fallback = setTimeout(finish, 0); };
    if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(post);
    else post();
  });
}

/** 按节点量限制每批 DOM 工作；长列表和长表格可在合法的项/行边界追加。 */
const MOUNT_BATCH_NODES = 600;
/** 极端密集结构不能创建数十万个 DOM 后再尝试取消，先保留源码并说明原因。 */
const MAX_VISUAL_NODES = 100_000;
const MAX_BLOCK_NODES = 20_000;

/** 只计 schema 节点，不按文字长度误判长段落；容器子项用于进一步划分装载批次。 */
function nodeWeight(node: ProseMirrorNode): number {
  let count = 1;
  node.descendants(() => { count += 1; });
  return count;
}

/** 分批装载已校验的 JSON，保持隐藏直到 React 节点视图挂载完成；过程中不改文件、不生成撤销步骤。 */
export async function mountVisualDocument(editor: Editor, document: JSONContent, signal: AbortSignal, onProgress: (loaded: number, total: number) => void, initializing: { current: boolean }): Promise<void> {
  const blocks = (document.content ?? []).map((json) => editor.schema.nodeFromJSON(json));
  const weights = blocks.map(nodeWeight);
  const total = weights.reduce((sum, count) => sum + count, 0);
  const tooDense = () => new Error('此文档的表格或列表结构过于密集，已保留源码模式，避免长时间无响应。');
  if (total > MAX_VISUAL_NODES) throw tooDense();
  const batches: Array<{ nodes: ProseMirrorNode[]; position?: number; weight: number }> = [];
  let rootPosition = 0;
  blocks.forEach((block, index) => {
    const weight = weights[index];
    if (weight > MOUNT_BATCH_NODES && ['bulletList', 'orderedList', 'taskList', 'table'].includes(block.type.name)) {
      // 先插入容器前缀，再在同一个容器末端追加项/行；最终仍是原来的一个列表或表格。
      const children: ProseMirrorNode[] = [];
      block.forEach((child) => children.push(child));
      let insertedSize = 0;
      for (let start = 0; start < children.length;) {
        let end = start;
        let batchWeight = start === 0 ? 1 : 0;
        while (end < children.length) {
          const childWeight = nodeWeight(children[end]);
          if (childWeight > MAX_BLOCK_NODES) throw tooDense();
          if (end > start && batchWeight + childWeight > MOUNT_BATCH_NODES) break;
          batchWeight += childWeight;
          end += 1;
        }
        const nodes = children.slice(start, end);
        batches.push(start === 0
          ? { nodes: [block.copy(Fragment.fromArray(nodes))], weight: batchWeight }
          : { nodes, position: rootPosition + 1 + insertedSize, weight: batchWeight });
        insertedSize += nodes.reduce((sum, node) => sum + node.nodeSize, 0);
        start = end;
      }
    } else {
      if (weight > MAX_BLOCK_NODES) throw tooDense();
      const last = batches[batches.length - 1];
      if (last && last.position === undefined && last.weight + weight <= MOUNT_BATCH_NODES) {
        last.nodes.push(block);
        last.weight += weight;
      } else batches.push({ nodes: [block], weight });
    }
    rootPosition += block.nodeSize;
  });
  let loaded = 0;
  for (const [index, batch] of batches.entries()) {
    await yieldVisualTask(signal);
    if (editor.isDestroyed) throw new DOMException('编辑器已关闭', 'AbortError');
    const wasInitializing = initializing.current;
    initializing.current = true;
    try {
      const tr = editor.state.tr;
      if (index === 0) {
        tr.replaceWith(0, tr.doc.content.size, batch.nodes);
        // 文档属性不随 replaceWith 自动更新，必须在首批沿用后台解析的源文件属性。
        for (const [name, value] of Object.entries(document.attrs ?? {})) tr.setDocAttribute(name, value);
      } else tr.insert(batch.position ?? tr.doc.content.size, batch.nodes);
      tr.setMeta('addToHistory', false).setMeta('skipTrailingNode', index < batches.length - 1);
      tr.setSelection(Selection.atStart(tr.doc));
      editor.view.dispatch(tr);
    } finally {
      initializing.current = wasInitializing;
    }
    loaded += batch.weight;
    onProgress(loaded, total);
  }
  // React NodeViewContent 在事务后挂载；让出宏任务再显示，所有入口都遵守同一约束。
  await yieldVisualTask(signal);
}
