// NoteBoard 双链补全（可视化模式）
// 输入 `[[` 后弹出仓库内笔记列表：按名称 / 路径模糊匹配，空查询列出最近修改的笔记。
// 选中后插入双链节点；查询中含 `#` 或 `|` 时原样保留标题与显示名部分。

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { FileText } from 'lucide-react';
import { IS_MOBILE_UI } from '../../core/platform';
import { getExplorerFileIcon } from '../explorer/fileIcons';
import {
  getNoteIndexVersion,
  linkTargetFor,
  peekNoteIndex,
  resolveVaultRoot,
  searchNotes,
  subscribeNoteIndex,
  type NoteEntry,
} from '../wikilink/noteIndex';
import { docPathOf, openDocumentEntries } from '../wikilink/wikiLinkNavigation';
import { useWindowStore } from '../../stores/windowStore';

const wikiLinkSuggestionKey = new PluginKey('wikiLinkSuggestion');

/** 补全列表的一项 */
interface WikiSuggestionItem {
  entry: NoteEntry;
  /** 插入的链接目标 */
  target: string;
}

interface WikiSuggestionContext {
  docKey: string;
}

/** 查询拆分：`笔记#标题|显示名` 只用 `笔记` 部分搜索，其余插入时保留 */
function splitQuery(query: string): { search: string; suffix: string } {
  const index = query.search(/[#|]/);
  if (index < 0) return { search: query, suffix: '' };
  return { search: query.slice(0, index), suffix: query.slice(index) };
}

function currentDocKey(context: WikiSuggestionContext): string {
  return context.docKey || useWindowStore.getState().activeKey || '';
}

/**
 * 计算候选（同步读取索引；索引构建完成后列表组件会订阅刷新）。
 * 已打开但位于仓库外的文档也作为候选，选中后写入相对当前文档的路径。
 */
function computeItems(context: WikiSuggestionContext, query: string): WikiSuggestionItem[] {
  const fromPath = docPathOf(currentDocKey(context));
  const root = resolveVaultRoot(fromPath);
  const snapshot = root ? peekNoteIndex(root) : null;
  const { search } = splitQuery(query);
  return searchNotes(snapshot, search, fromPath, 30, openDocumentEntries()).map((entry) => ({
    entry,
    target: linkTargetFor(snapshot, entry, fromPath),
  }));
}

/**
 * 用双链节点替换 `[[查询` 文字：光标后若紧跟 `]]`（手动补全的括号）一并吞掉；
 * 前面紧跟 `!` 时作为嵌入 `![[...]]`。
 */
function insertWikiLink(editor: Editor, range: Range, inner: string): void {
  const { state } = editor;
  const after = state.doc.textBetween(range.to, Math.min(range.to + 2, state.doc.content.size), '', '');
  const to = after === ']]' ? range.to + 2 : range.to;
  const before = range.from > 0 ? state.doc.textBetween(range.from - 1, range.from, '', '') : '';
  const embed = before === '!';
  editor
    .chain()
    .focus()
    .insertContentAt({ from: embed ? range.from - 1 : range.from, to }, [{ type: 'wikiLink', attrs: { inner, embed } }])
    .run();
}

interface WikiSuggestionMenuProps extends SuggestionProps<WikiSuggestionItem> {
  context: WikiSuggestionContext;
}

export interface WikiSuggestionMenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const WikiSuggestionMenu = forwardRef<WikiSuggestionMenuHandle, WikiSuggestionMenuProps>(
  function WikiSuggestionMenu({ editor, range, query, context }, ref) {
    // 索引在后台构建/重建完成后重新计算候选
    const indexVersion = useSyncExternalStore(subscribeNoteIndex, getNoteIndexVersion);
    const [items, setItems] = useState<WikiSuggestionItem[]>(() => computeItems(context, query));
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setItems(computeItems(context, query));
      setSelectedIndex(0);
    }, [context, query, indexVersion]);

    // 键盘移动时保持当前项可见
    useEffect(() => {
      const active = listRef.current?.querySelector<HTMLElement>('.is-active');
      active?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    const { search, suffix } = splitQuery(query);

    const select = (index: number) => {
      const item = items[index];
      if (item) {
        insertWikiLink(editor, range, `${item.target}${suffix}`);
      } else if (search.trim()) {
        // 没有匹配的笔记：按输入原样创建链接（目标稍后同步到达或另行新建都能自动生效）
        insertWikiLink(editor, range, query.trim());
      }
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.isComposing) return false;
        if (event.key === 'ArrowDown') {
          setSelectedIndex((index) => (items.length ? (index + 1) % items.length : 0));
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelectedIndex((index) => (items.length ? (index - 1 + items.length) % items.length : 0));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (!items.length && !search.trim()) return false;
          select(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    return (
      <div className="nb-wikilink-menu" role="listbox" aria-label="链接到笔记">
        <div className="nb-wikilink-menu-header">
          <span>{search.trim() ? `链接到：${search.trim()}` : '链接到笔记'}</span>
          {!IS_MOBILE_UI && <span className="nb-wikilink-menu-hint">↑↓ 选择 · Enter 插入</span>}
        </div>
        <div className="nb-wikilink-menu-list" ref={listRef}>
          {items.map((item, index) => (
            <button
              key={item.entry.path}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={`nb-wikilink-menu-item${index === selectedIndex ? ' is-active' : ''}`}
              // 不抢编辑器焦点，避免建议框在点击前就因失焦关闭
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => select(index)}
            >
              <span className="nb-wikilink-menu-icon">
                {item.entry.isMarkdown ? <FileText size={15} /> : getExplorerFileIcon(item.entry.name, { size: 15 })}
              </span>
              <span className="nb-wikilink-menu-text">
                <span className="nb-wikilink-menu-name">
                  {item.entry.isMarkdown ? item.entry.stem : item.entry.name}
                  {item.entry.external && <span className="nb-wikilink-menu-badge">仓库外</span>}
                </span>
                {item.entry.relPath.includes('/') && (
                  <span className="nb-wikilink-menu-path">{item.entry.relPath.replace(/\/[^/]*$/, '')}</span>
                )}
              </span>
            </button>
          ))}
          {items.length === 0 && (
            <div className="nb-wikilink-menu-empty">
              {search.trim() ? `没有匹配的笔记，Enter 创建「${search.trim()}」链接` : '输入笔记名称进行搜索'}
            </div>
          )}
        </div>
      </div>
    );
  },
);

/** 菜单定位：跟随光标，下方空间不足时向上展开，左右不超出视口 */
function positionPopup(popup: HTMLElement, props: SuggestionProps<WikiSuggestionItem>): void {
  const rect = props.clientRect?.();
  if (!rect) return;
  const menuWidth = Math.min(320, window.innerWidth - 32);
  const menuHeight = 320;
  const spaceBelow = window.innerHeight - rect.bottom - 44;
  const spaceAbove = rect.top - 48;
  const left = Math.min(Math.max(16, rect.left), window.innerWidth - menuWidth - 16);
  popup.style.left = `${Math.round(left)}px`;
  // 高度上限通过 CSS 变量传给菜单本体：ReactRenderer 在两者之间多包一层，max-height 无法直接继承
  if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
    popup.style.top = 'auto';
    popup.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
    popup.style.setProperty('--nb-wikilink-menu-max-height', `${Math.max(120, Math.min(menuHeight, spaceAbove))}px`);
  } else {
    popup.style.bottom = 'auto';
    popup.style.top = `${Math.round(rect.bottom + 6)}px`;
    popup.style.setProperty('--nb-wikilink-menu-max-height', `${Math.max(120, Math.min(menuHeight, spaceBelow))}px`);
  }
}

/** `[[` 补全扩展 */
export const WikiLinkSuggestion = Extension.create<WikiSuggestionContext>({
  name: 'wikiLinkSuggestion',

  addOptions() {
    return { docKey: '' };
  },

  addProseMirrorPlugins() {
    const context: WikiSuggestionContext = { docKey: this.options.docKey };
    return [
      Suggestion<WikiSuggestionItem>({
        editor: this.editor,
        pluginKey: wikiLinkSuggestionKey,
        char: '[[',
        // 笔记名常含空格；中文正文前通常没有空格，任意前缀都允许触发
        allowSpaces: true,
        allowedPrefixes: null,
        // 查询中出现方括号说明已不是补全中的链接
        allow: ({ state, range }) => {
          const text = state.doc.textBetween(range.from, range.to, '', '');
          if (/[[\]]/.test(text.slice(2))) return false;
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return false;
          return !$from.marks().some((mark) => mark.type.spec.code);
        },
        items: ({ query }) => computeItems(context, query),
        render: () => {
          let component: ReactRenderer<WikiSuggestionMenuHandle, WikiSuggestionMenuProps> | null = null;
          let popup: HTMLDivElement | null = null;
          return {
            onStart: (props) => {
              component = new ReactRenderer(WikiSuggestionMenu, {
                props: { ...props, context },
                editor: props.editor,
              });
              popup = document.createElement('div');
              popup.className = 'nb-wikilink-menu-popup';
              popup.style.position = 'fixed';
              // 与斜杠菜单相同层级：高于多维表格单元格编辑弹层
              popup.style.zIndex = '100005';
              popup.appendChild(component.element);
              document.body.appendChild(popup);
              positionPopup(popup, props);
            },
            onUpdate: (props) => {
              component?.updateProps({ ...props, context });
              if (popup) positionPopup(popup, props);
            },
            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                popup?.remove();
                popup = null;
                return true;
              }
              if (!popup) return false;
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              popup?.remove();
              popup = null;
              component?.destroy();
              component = null;
            },
          };
        },
      }),
    ];
  },
});
