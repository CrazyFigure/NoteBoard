// Markdown 原文保留：不同大小 × 不同组成的正确性与性能测量（耗时较长，默认跳过）。
// 手动执行：NB_PERF=1 npx vitest run test/editor-md/markdownSourcePreserve.perf.test.ts
// 可选：NB_PERF_SIZES=1024,51200 限定大小；NB_PERF_OUT=结果.json 输出测量数据；
// NB_PERF_LEGACY=1 只测量解析与序列化耗时（用于在改动前的版本上跑基线，对照新旧实现）。
//
// 两种模式：
// - real（≤ 5MB）：完整流程——整篇解析、序列化、编辑、撤销，以及后台准备 + 分批装载；
// - chunked（> 5MB）：既有 Markdown 分词器整篇解析的耗时随大小超线性增长（数十 MB 需数小时，
//   应用中超过 20 万字符默认源码打开、后台准备 60 秒超时），因此按节分段解析后拼成一篇文档，
//   专门测量原文保留层（指纹、对齐、拼装、序列化）在该规模下的正确性与耗时。
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { parseMarkdown, parseMarkdownToJson, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { generateSections, type CorpusComposition } from './fixtures/markdownCorpus';

const ENABLED = process.env.NB_PERF === '1';
const LEGACY = process.env.NB_PERF_LEGACY === '1';
const KB = 1024;
const MB = 1024 * KB;
const REAL_LIMIT = 5 * MB;
const SIZES = (process.env.NB_PERF_SIZES?.split(',').map(Number)) ?? [1 * KB, 50 * KB, 1 * MB, 5 * MB, 20 * MB, 50 * MB];
const COMPOSITIONS: CorpusComposition[] = ['canonical', 'noncanonical', 'extreme'];

interface SourceRecord {
  entries: Array<{ raw: string; gap: string; count: number; hashes: number[]; space?: boolean; defs?: string }>;
  tail: string;
  tailDefs?: string;
}

interface Measurement {
  size: number;
  composition: CorpusComposition;
  mode: 'real' | 'chunked';
  chars: number;
  blocks: number;
  parseMs: number;
  firstSerializeMs: number;
  cachedSerializeMs: number;
  editSerializeMs: number;
  undoSerializeMs: number;
  legacySerializeMs?: number;
  roundTripExact: boolean;
  heapDeltaMb: number;
  prepareMs?: number;
  mountMs?: number;
  preparedExact?: boolean;
}

const results: Measurement[] = [];

afterAll(() => {
  if (results.length === 0) return;
  console.table(results);
  if (process.env.NB_PERF_OUT) writeFileSync(process.env.NB_PERF_OUT, JSON.stringify(results, null, 2));
});

/** 顶层中间块的第一个文本块末尾（找不到时向后查找） */
function editPosition(doc: PMNode): number | null {
  const blocks: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((node, pos) => blocks.push({ node, pos }));
  const middle = Math.floor(blocks.length / 2);
  for (let index = middle; index < blocks.length; index += 1) {
    const { node, pos } = blocks[index];
    if (node.isTextblock) return pos + 1 + node.content.size;
    let found: number | null = null;
    node.descendants((child, offset) => {
      if (found !== null) return false;
      if (child.isTextblock) {
        found = pos + 1 + offset + 1 + child.content.size;
        return false;
      }
      return true;
    });
    if (found !== null) return found;
  }
  return null;
}

function timed<T>(run: () => T): [T, number] {
  const start = performance.now();
  const value = run();
  return [value, Math.round((performance.now() - start) * 10) / 10];
}

const heapMb = () => process.memoryUsage().heapUsed / MB;

/** 长时间同步计算之间交还事件循环，让测试进程与主进程的通信及时完成 */
const yieldToRunner = () => new Promise((resolve) => setTimeout(resolve, 0));

function createEditor(name: string): Editor {
  const editor = new Editor({ element: null, extensions: buildExtensions(name), content: '' });
  // headless 编辑器同样通过官方代理视图分派真实事务（与 visualPreparation.test.ts 一致）
  Object.defineProperty(editor, 'isDestroyed', { value: false });
  return editor;
}

/** 按节分段解析（每段约 256KB，段间以空行分隔），拼成一篇带原文记录的文档 */
function loadChunked(editor: Editor, sections: string[]): string {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const section of sections) {
    current.push(section);
    size += section.length;
    if (size >= 256 * KB) {
      chunks.push(current.join('\n\n'));
      current = [];
      size = 0;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));
  const texts = chunks.map((chunk, index) => chunk + (index < chunks.length - 1 ? '\n\n' : '\n'));
  const content: JSONContent[] = [];
  const merged: SourceRecord = { entries: [], tail: '' };
  for (const text of texts) {
    const parsed = parseMarkdownToJson(editor, text, { recordSource: true });
    const record = parsed?.attrs?.sourceBlocks as SourceRecord | null | undefined;
    expect(record).toBeTruthy();
    content.push(...(parsed!.content ?? []));
    const [first, ...rest] = record!.entries;
    // 上一段的文末原文并入本段第一个条目之前的间隔
    merged.entries.push({ ...first, gap: merged.tail + first.gap }, ...rest);
    merged.tail = record!.tail;
  }
  editor.commands.setContent({ type: 'doc', content });
  editor.view.dispatch(editor.state.tr.setDocAttribute('sourceBlocks', merged).setDocAttribute('trailingNewline', '\n'));
  return texts.join('');
}

describe.skipIf(!ENABLED)('原文保留：不同大小与组成', () => {
  const cases = SIZES.flatMap((size) => COMPOSITIONS.map((composition) => [size, composition] as const));

  it.each(cases)('%d 字节 · %s', async (size, composition) => {
    const sections = generateSections(composition, size);
    const mode = size > REAL_LIMIT ? 'chunked' : 'real';
    if (mode === 'chunked' && LEGACY) return;
    const editor = createEditor(`perf-${size}-${composition}`);
    try {
      const heapBefore = heapMb();
      let content = `${sections.join('\n\n')}\n`;
      let parseMs: number;
      if (mode === 'real') {
        const [parsed, ms] = timed(() => parseMarkdown(editor, content));
        expect(parsed).toBe(true);
        parseMs = ms;
      } else {
        [content, parseMs] = timed(() => loadChunked(editor, sections));
      }
      const heapDeltaMb = Math.round((heapMb() - heapBefore) * 10) / 10;
      await yieldToRunner();
      const [first, firstSerializeMs] = timed(() => serializeMarkdown(editor));
      const [, cachedSerializeMs] = timed(() => serializeMarkdown(editor));
      const roundTripExact = first === content;
      await yieldToRunner();

      // 编辑中间一块后序列化：只有该块按规则重写
      const position = editPosition(editor.state.doc);
      expect(position).not.toBeNull();
      const tr = editor.state.tr.insertText('编辑', position!);
      editor.view.dispatch(tr);
      const [edited, editSerializeMs] = timed(() => serializeMarkdown(editor));
      expect(edited).toContain('编辑');
      await yieldToRunner();

      // 撤销后序列化
      const inverse = editor.state.tr;
      for (let index = tr.steps.length - 1; index >= 0; index -= 1) inverse.step(tr.steps[index].invert(tr.docs[index]));
      editor.view.dispatch(inverse);
      const [undone, undoSerializeMs] = timed(() => serializeMarkdown(editor));

      const record = editor.state.doc.attrs.sourceBlocks as SourceRecord | null | undefined;
      const measurement: Measurement = {
        size, composition, mode, chars: content.length, blocks: editor.state.doc.childCount,
        parseMs, firstSerializeMs, cachedSerializeMs, editSerializeMs, undoSerializeMs, roundTripExact, heapDeltaMb,
      };

      if (!LEGACY) {
        // 新实现：未编辑与撤销后逐字一致
        expect(roundTripExact).toBe(true);
        expect(undone).toBe(content);
        // 编辑后与原文不同的区间不超过单个块的原文（其余内容逐字保留）
        let prefix = 0;
        while (prefix < content.length && content[prefix] === edited[prefix]) prefix += 1;
        let suffix = 0;
        while (suffix < content.length - prefix && content[content.length - 1 - suffix] === edited[edited.length - 1 - suffix]) suffix += 1;
        const longestEntry = (record?.entries ?? []).reduce((longest, entry) => Math.max(longest, entry.raw.length + entry.gap.length), 0);
        expect(content.length - prefix - suffix).toBeLessThanOrEqual(longestEntry);

        // 对照：去掉原文记录后按旧方式整篇序列化的耗时。
        // 非规范文档整篇重写会触发转义清理的整篇重新解析（6MB 已需约 72 秒），分段规模下跳过
        if (!(mode === 'chunked' && composition === 'noncanonical')) {
          await yieldToRunner();
          editor.view.dispatch(editor.state.tr.setDocAttribute('sourceBlocks', null));
          [, measurement.legacySerializeMs] = timed(() => serializeMarkdown(editor));
        }

        // 后台准备路径：worker 同款数据准备 + 分批装载，装载后逐字一致
        if (mode === 'real' && size >= 50 * KB) {
          const { prepareVisualDocumentData } = await import('../../src/features/editor-md/visualPreparationData');
          const { mountVisualDocument } = await import('../../src/features/editor-md/visualPreparation');
          const prepareStart = performance.now();
          const prepared = await prepareVisualDocumentData(content, async () => {});
          measurement.prepareMs = Math.round(performance.now() - prepareStart);
          const mounted = createEditor(`perf-mount-${size}-${composition}`);
          try {
            const mountStart = performance.now();
            await mountVisualDocument(mounted, prepared.document, new AbortController().signal, () => {}, { current: false });
            measurement.mountMs = Math.round(performance.now() - mountStart);
            measurement.preparedExact = serializeMarkdown(mounted) === content;
            expect(measurement.preparedExact).toBe(true);
          } catch (error) {
            // 既有保护：单块过于密集时拒绝装载并留在源码（与原文保留无关），记为 -1
            if (!(error instanceof Error) || !error.message.includes('过于密集')) throw error;
            measurement.mountMs = -1;
          } finally {
            mounted.destroy();
          }
        }
      }
      results.push(measurement);
    } finally {
      editor.destroy();
    }
  }, 2 * 60 * 60 * 1000);
});
