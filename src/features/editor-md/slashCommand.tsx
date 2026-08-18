// NoteBoard 斜杠命令
// @tiptap/suggestion + SlashMenu + 中英文关键词搜索 + ↑↓/Enter/Esc + 最多 8 项
// 详见 docs/09-开发路线图.md 8.7

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionProps } from '@tiptap/suggestion';
import type { Editor, Range } from '@tiptap/core';

interface CommandItem {
  id: string;
  label: string;
  aliases?: string[];
  icon?: ReactNode;
  keywords?: string;
  action: (editor: Editor, range: Range) => void;
}

/** 命令列表 */
const COMMANDS: CommandItem[] = [
  {
    id: 'codeBlock',
    label: '代码块',
    aliases: ['daima', 'daimakuai', 'dm', 'code', 'codeblock', 'pre', 'js', 'ts', 'py', 'sql', 'json'],
    keywords: '代码 代码块 code codeblock daima dm',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    id: 'heading1',
    label: '标题 1 (H1)',
    aliases: ['h1', '1', 'biaoti', 'biaoti1', 'bt', 'bt1', 'heading', 'title'],
    keywords: '标题 一级标题 heading h1 biaoti',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'heading2',
    label: '标题 2 (H2)',
    aliases: ['h2', '2', 'biaoti', 'biaoti2', 'bt', 'bt2', 'subtitle'],
    keywords: '标题 二级标题 heading h2 biaoti',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'heading3',
    label: '标题 3 (H3)',
    aliases: ['h3', '3', 'biaoti', 'biaoti3', 'bt', 'bt3'],
    keywords: '标题 三级标题 heading h3 biaoti',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'table',
    label: '表格 (3x3)',
    aliases: ['biaoge', 'bg', 'table', 'grid'],
    keywords: '表格 table grid biaoge bg',
    action: (editor, range) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'taskList',
    label: '任务列表 (Todo)',
    aliases: ['renwu', 'renwuliebiao', 'rw', 'todo', 'task', 'checkbox'],
    keywords: '任务 待办 task todo checkbox renwu',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: 'bulletList',
    label: '无序列表 (Bullet)',
    aliases: ['wuxu', 'wuxuliebiao', 'wx', 'list', 'bullet', 'ul'],
    keywords: '列表 无序列表 list bullet ul wuxu',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    label: '有序列表 (Numbered)',
    aliases: ['youxu', 'youxuliebiao', 'yx', 'list', 'ordered', 'ol'],
    keywords: '列表 有序列表 list ordered ol youxu',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: 'blockquote',
    label: '引用 (Quote)',
    aliases: ['yinyong', 'yy', 'quote', 'blockquote'],
    keywords: '引用 quote blockquote yinyong yy',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: 'mathInline',
    label: '行内公式 ($...$)',
    aliases: ['gongshi', 'gs', 'math', 'latex', 'inline', 'katex'],
    keywords: '公式 数学公式 math latex inline katex gongshi',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'mathInline', attrs: { latex: 'E=mc^2' } }).run();
    },
  },
  {
    id: 'mathBlock',
    label: '块级公式 ($$...$$)',
    aliases: ['kuaijigongshi', 'kjgs', 'math', 'latex', 'block', 'katex'],
    keywords: '块级公式 数学公式 math latex block katex',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'mathBlock', attrs: { latex: '' } }).run();
    },
  },
  {
    id: 'mermaid',
    label: 'Mermaid 图表',
    aliases: ['tubiao', 'tb', 'mermaid', 'diagram', 'chart', 'tu'],
    keywords: '图表 流程图 mermaid diagram chart flowchart tubiao',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'mermaidBlock', attrs: { code: 'graph TD\n  A --> B' } }).run();
    },
  },
  {
    id: 'alertNote',
    label: 'Note 提示块',
    aliases: ['tishi', 'ts', 'alert', 'note', 'tip', 'info'],
    keywords: '提示 note alert tip tishi',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'githubAlert', attrs: { kind: 'note' }, content: [{ type: 'paragraph' }] }).run();
    },
  },
  {
    id: 'alertWarning',
    label: 'Warning 警告块',
    aliases: ['jinggao', 'jg', 'alert', 'warning', 'warn'],
    keywords: '警告 warning alert warn jinggao',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'githubAlert', attrs: { kind: 'warning' }, content: [{ type: 'paragraph' }] }).run();
    },
  },
  {
    id: 'divider',
    label: '水平分割线 (---)',
    aliases: ['fengexian', 'fgx', 'fg', 'divider', 'hr', 'horizontal', 'line'],
    keywords: '分割线 分割 华丽分割线 divider hr fengexian',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

/** 搜索匹配：中英文关键词 + 全拼音缩写匹配 */
function searchCommands(query: string): CommandItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return COMMANDS.slice(0, 8);

  const scored: { item: CommandItem; score: number }[] = [];

  for (const item of COMMANDS) {
    const label = item.label.toLowerCase();
    const keywords = (item.keywords ?? '').toLowerCase();
    const aliases = (item.aliases ?? []).map((a) => a.toLowerCase());

    let score = 0;
    if (label.startsWith(q)) score = 120;
    else if (aliases.some((a) => a === q)) score = 110;
    else if (label.includes(q)) score = 100 - label.indexOf(q);
    else if (aliases.some((a) => a.startsWith(q))) score = 90;
    else if (keywords.includes(q)) score = 80;
    else if (aliases.some((a) => a.includes(q))) score = 60;

    if (score > 0) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.item);
}

/** 斜杠命令菜单组件 */
function SlashMenu({
  editor,
  range,
  query,
}: SuggestionProps) {
  const [items, setItems] = useState<CommandItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const results = searchCommands(query);
    setItems(results);
    setSelectedIndex(0);
  }, [query]);

  const selectItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) {
        item.action(editor, range);
      }
    },
    [items, editor, range],
  );

  // 键盘导航
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectItem(selectedIndex);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // 关闭菜单（tippy 会处理）
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [items, selectedIndex, selectItem]);

  if (items.length === 0) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--editor-text-muted)' }}>
        无匹配命令
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--editor-surface)',
        border: '1px solid var(--editor-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden',
        maxWidth: 280,
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          onMouseEnter={() => setSelectedIndex(index)}
          onClick={() => selectItem(index)}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 12px',
            textAlign: 'left',
            border: 'none',
            background: index === selectedIndex ? 'var(--editor-selection-background)' : 'transparent',
            color: 'var(--editor-text)',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 斜杠命令 suggestion 配置 */
export const slashSuggestion = {
  char: '/',
  items: ({ query }: { query: string }) => searchCommands(query).map((i) => ({ label: i.label, id: i.id })),
  render: () => {
    let component: ReactRenderer | null = null;
    let popup: HTMLElement | null = null;

    return {
      onStart: (props: SuggestionProps) => {
        component = new ReactRenderer(SlashMenu, {
          props,
          editor: props.editor,
        });

        if (props.clientRect && component.element) {
          popup = document.createElement('div');
          popup.style.position = 'fixed';
          popup.style.zIndex = '9999';
          const rect = props.clientRect();
          if (rect) {
            popup.style.top = `${rect.bottom + 8}px`;
            popup.style.left = `${rect.left}px`;
          }
          popup.appendChild(component.element);
          document.body.appendChild(popup);
        }
      },
      onUpdate: (props: SuggestionProps) => {
        component?.updateProps(props);
        if (props.clientRect && popup) {
          const rect = props.clientRect();
          if (rect) {
            popup.style.top = `${rect.bottom + 8}px`;
            popup.style.left = `${rect.left}px`;
          }
        }
      },
      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (props.event.key === 'Escape') {
          if (popup) {
            popup.remove();
            popup = null;
          }
          return true;
        }
        return false;
      },
      onExit: () => {
        if (popup) {
          popup.remove();
          popup = null;
        }
        component?.destroy();
        component = null;
      },
    };
  },
};
