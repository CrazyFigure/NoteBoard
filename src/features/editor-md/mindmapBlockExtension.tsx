// NoteBoard Markdown 内嵌思维导图扩展
// 复用 MindmapBlockCore 围栏规则，并采用视口门控 + React.lazy 按需装载 MdMindmapCanvas，
// 保证普通 Markdown 文档零首屏导图运行时依赖。

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { closeHistory } from '@tiptap/pm/history';
import { Network } from 'lucide-react';
import { observe } from './viewportActivation';
import { useIsReading } from '../reading/readingMode';
import { MindmapBlockCore, type MindmapBlockOptions } from './mindmapBlockCore';
import { createDefaultMindmapCode } from './mindmapBlockDefault';

export type { MindmapBlockOptions };

const LazyMdMindmapCanvas = lazy(() => import('./MdMindmapCanvas'));

/** 视口门控占位高度与主题内联样式（避免将一次性占位样式打入首屏 globals.css） */
const PLACEHOLDER_STYLE = {
  minHeight: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  border: '1px solid var(--editor-border, #e2e8f0)',
  borderRadius: 'var(--radius-md, 8px)',
  background: 'var(--editor-surface, #ffffff)',
  color: 'var(--editor-text-muted, #64748b)',
  fontSize: 13,
} as const;

function MindmapBlockNodeView({
  node,
  editor,
  getPos,
  updateAttributes,
  selected,
  extension,
}: NodeViewProps) {
  const docKey = String((extension.options as MindmapBlockOptions | undefined)?.docKey ?? '');
  const isReading = useIsReading(docKey);
  const [inViewport, setInViewport] = useState(false);
  const [isEditable, setIsEditable] = useState(() => editor.isEditable);
  const containerRef = useRef<HTMLDivElement>(null);

  // 监听编辑器可编辑状态（切换沉浸阅读时同步更新只读态）
  useEffect(() => {
    setIsEditable(editor.isEditable);
    const syncEditable = () => setIsEditable(editor.isEditable);
    editor.on('transaction', syncEditable);
    return () => {
      editor.off('transaction', syncEditable);
    };
  }, [editor]);

  // 视口门控：滚动接近可视区域再挂载并懒加载导图渲染器
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return observe(el, () => setInViewport(true), { once: true });
  }, []);

  const code = typeof node.attrs.code === 'string' ? node.attrs.code : '';
  const readOnly = isReading || !isEditable;

  // 提交导图修改：强制关闭前序历史分组，让每次导图操作在撤销时间线中独立成步
  const handleChangeCode = useCallback(
    (nextCode: string) => {
      if (readOnly) return;
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof pos === 'number') {
        const currentNode = editor.state.doc.nodeAt(pos);
        if (currentNode) {
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
            ...currentNode.attrs,
            code: nextCode,
          });
          editor.view.dispatch(closeHistory(tr));
          return;
        }
      }
      updateAttributes({ code: nextCode });
    },
    [editor, getPos, readOnly, updateAttributes],
  );

  return (
    <NodeViewWrapper
      as="div"
      style={{ display: 'block', margin: '14px 0' }}
      selected={selected}
      data-mindmap-block=""
    >
      <div ref={containerRef} contentEditable={false}>
        {inViewport ? (
          <Suspense
            fallback={
              <div className="nb-md-mindmap-placeholder" style={PLACEHOLDER_STYLE}>
                <Network size={16} color="#f97316" />
                <span>正在加载思维导图…</span>
              </div>
            }
          >
            <LazyMdMindmapCanvas
              code={code}
              docKey={docKey}
              editor={editor}
              readOnly={readOnly}
              onChangeCode={handleChangeCode}
            />
          </Suspense>
        ) : (
          <div className="nb-md-mindmap-placeholder" style={PLACEHOLDER_STYLE}>
            <Network size={16} color="#f97316" />
            <span>思维导图（滚动到视口时渲染）</span>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

/** Markdown 思维导图块节点定义 */
export const MindmapBlock = MindmapBlockCore.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MindmapBlockNodeView, {
      // 交互控件与画布内部事件由导图自身消费，避免被 ProseMirror 拦截或误删整块
      stopEvent: ({ event }) => {
        const target = event.target as HTMLElement | null;
        return Boolean(
          target?.closest?.('[data-md-mindmap-interactive], .nb-mindmap-topbar-actions'),
        );
      },
      ignoreMutation: () => true,
    });
  },
  addCommands() {
    return {
      insertMindmap:
        (code?: string) =>
        ({ commands }: { commands: { insertContent: (content: unknown) => boolean } }) => {
          return commands.insertContent({
            type: 'mindmapBlock',
            attrs: { code: code ?? createDefaultMindmapCode() },
          });
        },
    } as never;
  },
});
