// NoteBoard 文档历史记录：Markdown 渲染级差异查看
// 用与正文编辑器相同的扩展装配一个只读 TipTap 实例，渲染「合并文档」：
//   行内删除 / 新增用 historyDiff 标记呈现，整块的删除 / 新增 / 修改用节点装饰呈现。
// 「显示更改」关闭时只切换根节点属性，由样式隐藏删除内容，不重新计算。
// 文档过大或解析失败时回退到源码级差异。

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Extension, Mark, type Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNodeType, Schema } from '@tiptap/pm/model';
import { buildExtensions } from '../../editor-md/extensions';
import { parseMarkdownToJson } from '../../editor-md/serialize';
import { THRESHOLDS } from '../../editor-md/largeDoc';
import { diffMarkdownDocs, DIFF_MARK, type BlockMarker, type PMNode, type SchemaInfo } from '../diff/markdownDiff';
import type { VersionViewerProps } from './viewerTypes';

const TextVersionViewer = lazy(() => import('./TextVersionViewer'));

/** 行内差异标记（仅查看器 schema 注册，不进入正文编辑器） */
const HistoryDiffMark = Mark.create({
  name: DIFF_MARK,
  excludes: '',
  inclusive: false,
  addAttributes() {
    return { kind: { default: 'ins' } };
  },
  parseHTML() {
    return [];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { class: HTMLAttributes.kind === 'del' ? 'nb-hd-del' : 'nb-hd-ins' }, 0];
  },
});

interface DiffPluginState {
  blocks: BlockMarker[];
  current: { from: number; to: number } | null;
}

const diffPluginKey = new PluginKey<DiffPluginState>('nbHistoryDiff');

/** 按子节点下标路径定位节点 */
function resolvePath(doc: PMNodeType, path: number[]): { pos: number; node: PMNodeType } | null {
  let node = doc;
  let pos = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const index = path[depth];
    if (index >= node.childCount) return null;
    let offset = 0;
    for (let i = 0; i < index; i++) offset += node.child(i).nodeSize;
    const child = node.child(index);
    const childPos = pos + offset;
    if (depth === path.length - 1) return { pos: childPos, node: child };
    pos = childPos + 1;
    node = child;
  }
  return null;
}

/** 整块改动装饰 + 当前定位的改动高亮 */
const HistoryDiffDecorations = Extension.create({
  name: 'nbHistoryDiffDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin<DiffPluginState>({
        key: diffPluginKey,
        state: {
          init: () => ({ blocks: [], current: null }),
          apply: (tr, prev) => (tr.getMeta(diffPluginKey) as DiffPluginState | undefined) ?? prev,
        },
        props: {
          decorations(state) {
            const plugin = diffPluginKey.getState(state);
            if (!plugin) return null;
            const decos: Decoration[] = [];
            for (const marker of plugin.blocks) {
              const hit = resolvePath(state.doc, marker.path);
              if (!hit) continue;
              decos.push(Decoration.node(hit.pos, hit.pos + hit.node.nodeSize, { class: `nb-hd-block nb-hd-block-${marker.kind}` }));
            }
            const cur = plugin.current;
            if (cur && cur.to <= state.doc.content.size) {
              const node = state.doc.nodeAt(cur.from);
              if (node && cur.to - cur.from === node.nodeSize && !node.isText) {
                decos.push(Decoration.node(cur.from, cur.to, { class: 'nb-hd-current' }));
              } else {
                decos.push(Decoration.inline(cur.from, cur.to, { class: 'nb-hd-current' }));
              }
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

function schemaInfo(schema: Schema): SchemaInfo {
  return {
    isTextblock: (type) => schema.nodes[type]?.isTextblock ?? false,
    allowsMarks: (type) => {
      const nodeType = schema.nodes[type];
      const mark = schema.marks[DIFF_MARK];
      return Boolean(nodeType && mark && nodeType.allowsMarkType(mark));
    },
  };
}

/** 空文档补一个空段落（doc 内容不能为空） */
function ensureBlock(doc: PMNode): PMNode {
  return doc.content && doc.content.length > 0 ? doc : { ...doc, content: [{ type: 'paragraph' }] };
}

function parse(editor: Editor, markdown: string): PMNode | null {
  if (markdown.trim() === '') return { type: 'doc', content: [{ type: 'paragraph' }] };
  const json = parseMarkdownToJson(editor, markdown) as PMNode | null;
  return json ? ensureBlock(json) : null;
}

/** 收集改动处：行内标记的连续区间 + 整块标记，按位置排序 */
function collectChanges(doc: PMNodeType, blocks: BlockMarker[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  doc.descendants((node, pos) => {
    if (node.isInline && node.marks.some((m) => m.type.name === DIFF_MARK)) {
      const last = ranges[ranges.length - 1];
      const end = pos + node.nodeSize;
      // 紧邻的删除 + 新增算同一处改动
      if (last && last.to === pos) last.to = end;
      else ranges.push({ from: pos, to: end });
    }
    return true;
  });
  for (const marker of blocks) {
    const hit = resolvePath(doc, marker.path);
    if (hit) ranges.push({ from: hit.pos, to: hit.pos + hit.node.nodeSize });
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  // 去掉被整块改动包含的行内改动，避免同一处数两次
  const out: Array<{ from: number; to: number }> = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.from >= last.from && r.to <= last.to) continue;
    out.push(r);
  }
  return out;
}

export default function MarkdownVersionViewer(props: VersionViewerProps) {
  const { docKey, base, target, showChanges, onChangeInfo, navigatorRef } = props;
  const tooLarge = Math.max(base?.length ?? 0, target.length) > THRESHOLDS.VISUAL_MODE_LIMIT;
  const [failed, setFailed] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const changesRef = useRef<Array<{ from: number; to: number }>>([]);
  const indexRef = useRef(-1);
  const onChangeInfoRef = useRef(onChangeInfo);
  onChangeInfoRef.current = onChangeInfo;
  const showRef = useRef(showChanges);
  showRef.current = showChanges;

  const extensions = useMemo(
    () => [...buildExtensions(docKey, { documentHistory: false, placeholder: '' }), HistoryDiffMark, HistoryDiffDecorations],
    [docKey],
  );
  const editor = useEditor(
    {
      extensions,
      editable: false,
      content: '',
      editorProps: {
        attributes: {
          class: 'nb-prose nb-hd-prose',
          style: 'outline: none; max-width: var(--content-max-width); margin: 0 auto; padding: 24px 24px 64px; font-size: var(--content-font-size); line-height: var(--content-line-height); font-family: var(--content-font-family); color: var(--editor-text);',
        },
      },
    },
    [extensions],
  );

  const report = () => {
    const count = showRef.current ? changesRef.current.length : 0;
    onChangeInfoRef.current({ count, index: count > 0 ? indexRef.current : -1 });
  };

  /** 定位到第 index 处改动并高亮 */
  const focusChange = (index: number) => {
    if (!editor || editor.isDestroyed) return;
    const change = changesRef.current[index];
    if (!change) return;
    indexRef.current = index;
    editor.view.dispatch(editor.state.tr.setMeta(diffPluginKey, { ...diffPluginKey.getState(editor.state)!, current: change }));
    const dom = editor.view.nodeDOM(change.from) ?? editor.view.domAtPos(change.from).node;
    const el = dom instanceof HTMLElement ? dom : dom?.parentElement;
    // 只滚动查看器自身：scrollIntoView 会连带滚动外层页面（移动端出现横向偏移）
    const scroller = scrollerRef.current;
    if (el && scroller) {
      const rect = el.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      const top = scroller.scrollTop + rect.top - box.top - box.height / 2 + Math.min(rect.height, box.height) / 2;
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    report();
  };

  // 计算并渲染合并文档（推迟到渲染提交之后执行：节点视图的同步渲染不能发生在生命周期内）
  useEffect(() => {
    if (!editor || editor.isDestroyed || tooLarge) return;
    const timer = window.setTimeout(() => {
      if (editor.isDestroyed) return;
      try {
        const b = parse(editor, target);
        const a = base === null ? null : parse(editor, base);
        if (!b || (base !== null && !a)) {
          setFailed(true);
          return;
        }
        const result = diffMarkdownDocs(a, b, schemaInfo(editor.schema));
        editor.commands.setContent(result.doc as never, { emitUpdate: false });
        editor.view.dispatch(editor.state.tr.setMeta(diffPluginKey, { blocks: result.blocks, current: null }));
        changesRef.current = collectChanges(editor.state.doc, result.blocks);
        indexRef.current = -1;
        setFailed(false);
        scrollerRef.current?.scrollTo({ top: 0 });
        if (showRef.current && changesRef.current.length > 0) {
          // 等渲染完成后定位到第一处改动
          requestAnimationFrame(() => focusChange(0));
        } else {
          report();
        }
      } catch (error) {
        console.error('[历史记录] Markdown 差异渲染失败，回退源码对比:', error);
        setFailed(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // focusChange / report 只读取 ref 与 editor
  }, [editor, base, target, tooLarge]);

  // 显示更改开关：清除当前高亮并重新上报数量
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const st = diffPluginKey.getState(editor.state);
    if (st?.current) editor.view.dispatch(editor.state.tr.setMeta(diffPluginKey, { ...st, current: null }));
    indexRef.current = showChanges && changesRef.current.length > 0 ? 0 : -1;
    if (showChanges && changesRef.current.length > 0) focusChange(0);
    else report();
  }, [showChanges, editor]);

  useEffect(() => {
    // 回退到源码对比时由源码查看器提供跳转
    if (tooLarge || failed) return;
    navigatorRef.current = {
      next: () => focusChange(Math.min(changesRef.current.length - 1, indexRef.current + 1)),
      prev: () => focusChange(Math.max(0, indexRef.current - 1)),
    };
    return () => {
      navigatorRef.current = null;
    };
  });

  if (tooLarge || failed) {
    return (
      <>
        <div className="nb-vh-banner">{tooLarge ? '文档较大，显示源码对比' : '无法渲染，显示源码对比'}</div>
        <Suspense fallback={null}>
          <TextVersionViewer {...props} />
        </Suspense>
      </>
    );
  }

  return (
    <div ref={scrollerRef} className="nb-hd-scroller" data-changes={showChanges ? 'on' : 'off'}>
      <EditorContent editor={editor} />
    </div>
  );
}
