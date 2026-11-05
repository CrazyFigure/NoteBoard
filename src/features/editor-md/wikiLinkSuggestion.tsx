// NoteBoard 双链补全（可视化模式）
// 输入 `[[` 后弹出仓库内笔记列表：按名称 / 路径模糊匹配，空查询列出最近修改的笔记。
// 不用记语法也能用全部写法：
// 1. 每条笔记右侧的「#」按钮（或 → 键）进入该笔记的标题列表，选中即链接到标题；
// 2. 底部「嵌入」开关决定插入 `[[...]]` 还是 `![[...]]`；
// 3. 「更多选项」打开完整弹窗，可再设置显示名、显示宽度等。
// 熟悉语法时直接输入 `#`、`|` 同样有效。

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { ChevronRight, FileText, Hash, SlidersHorizontal } from 'lucide-react';
import { IS_MOBILE_UI } from '../../core/platform';
import { getExplorerFileIcon } from '../explorer/fileIcons';
import {
  createExternalEntry,
  getNoteIndexVersion,
  linkTargetFor,
  peekNoteIndex,
  resolveVaultRoot,
  searchNotes,
  subscribeNoteIndex,
  type NoteEntry,
} from '../wikilink/noteIndex';
import { docPathOf, loadNoteHeadings, openDocumentEntries, resolveWikiLinkNow } from '../wikilink/wikiLinkNavigation';
import { insertWikiLinkInEditor } from '../wikilink/wikiLinkActions';
import { placeEmbedAsBlock } from './wikiLinkBlock';
import type { NoteHeading } from '../wikilink/wikiLinkSyntax';
import { useWindowStore } from '../../stores/windowStore';

const wikiLinkSuggestionKey = new PluginKey('wikiLinkSuggestion');

/** 笔记候选 */
interface NoteItem {
  kind: 'note';
  entry: NoteEntry;
  /** 插入的链接目标 */
  target: string;
}

/** 标题候选（查询中已写到 `笔记#` 时） */
interface HeadingItem {
  kind: 'heading';
  heading: NoteHeading;
}

type SuggestionItem = NoteItem | HeadingItem;

interface WikiSuggestionContext {
  docKey: string;
}

/**
 * 查询拆分：`笔记#标题|显示名`。
 * 出现 `#`（且在 `|` 之前）时进入标题模式，用 `#` 后面的文字筛选标题。
 */
function splitQuery(query: string): { search: string; headingQuery: string | null; suffix: string } {
  const pipe = query.indexOf('|');
  const hash = query.indexOf('#');
  if (hash >= 0 && (pipe < 0 || hash < pipe)) {
    return { search: query.slice(0, hash), headingQuery: query.slice(hash + 1, pipe < 0 ? undefined : pipe), suffix: pipe < 0 ? '' : query.slice(pipe) };
  }
  if (pipe >= 0) return { search: query.slice(0, pipe), headingQuery: null, suffix: query.slice(pipe) };
  return { search: query, headingQuery: null, suffix: '' };
}

function currentDocKey(context: WikiSuggestionContext): string {
  return context.docKey || useWindowStore.getState().activeKey || '';
}

/**
 * 笔记候选（同步读取索引；索引构建完成后列表组件会订阅刷新）。
 * 已打开但位于仓库外的文档也作为候选，选中后写入相对当前文档的路径。
 */
function computeNoteItems(context: WikiSuggestionContext, search: string): NoteItem[] {
  const fromPath = docPathOf(currentDocKey(context));
  const root = resolveVaultRoot(fromPath);
  const snapshot = root ? peekNoteIndex(root) : null;
  return searchNotes(snapshot, search, fromPath, 30, openDocumentEntries()).map((entry) => ({
    kind: 'note',
    entry,
    target: linkTargetFor(snapshot, entry, fromPath),
  }));
}

/** 标题模式下要读取标题的笔记：目标留空时为当前文档 */
function headingSourceOf(context: WikiSuggestionContext, target: string): NoteEntry | null {
  const docKey = currentDocKey(context);
  if (!target.trim()) {
    const path = docPathOf(docKey);
    return path ? createExternalEntry(path) : null;
  }
  const resolution = resolveWikiLinkNow(target, docKey);
  return resolution.status === 'resolved' ? resolution.entry : null;
}

/** 补全范围前是否紧跟 `!`（嵌入写法） */
function hasEmbedPrefix(editor: Editor, range: Range): boolean {
  return range.from > 0 && editor.state.doc.textBetween(range.from - 1, range.from, '', '') === '!';
}

/** 补全范围连同前面的 `!` 与后面自动补齐的 `]]` */
function fullRange(editor: Editor, range: Range): Range {
  const { doc } = editor.state;
  const after = doc.textBetween(range.to, Math.min(range.to + 2, doc.content.size), '', '');
  return {
    from: hasEmbedPrefix(editor, range) ? range.from - 1 : range.from,
    to: after === ']]' ? range.to + 2 : range.to,
  };
}

/** 用双链节点替换 `[[查询` 文字；嵌入单独成段 */
function insertWikiLink(editor: Editor, range: Range, inner: string, embed: boolean): void {
  const target = fullRange(editor, range);
  if (embed) {
    editor
      .chain()
      .focus()
      .command(({ tr, state }) => {
        placeEmbedAsBlock(tr, target.from, target.to, state.schema.nodes.wikiLink.create({ inner, embed: true }));
        return true;
      })
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .insertContentAt(target, [{ type: 'wikiLink', attrs: { inner, embed } }])
    .run();
}

interface WikiSuggestionMenuProps extends SuggestionProps<SuggestionItem> {
  context: WikiSuggestionContext;
}

export interface WikiSuggestionMenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const WikiSuggestionMenu = forwardRef<WikiSuggestionMenuHandle, WikiSuggestionMenuProps>(
  function WikiSuggestionMenu({ editor, range, query, context }, ref) {
    // 索引在后台构建/重建完成后重新计算候选
    const indexVersion = useSyncExternalStore(subscribeNoteIndex, getNoteIndexVersion);
    const [selectedIndex, setSelectedIndex] = useState(0);
    // 嵌入开关：输入 `![[` 时默认打开
    const [embed, setEmbed] = useState(() => hasEmbedPrefix(editor, range));
    const [headings, setHeadings] = useState<NoteHeading[] | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const { search, headingQuery, suffix } = splitQuery(query);
    const headingMode = headingQuery !== null;

    const noteItems = useMemo(() => {
      void indexVersion;
      return headingMode ? [] : computeNoteItems(context, search);
    }, [context, search, headingMode, indexVersion]);

    // 标题模式：读取目标笔记的标题
    const headingSource = useMemo(() => {
      void indexVersion;
      return headingMode ? headingSourceOf(context, search) : null;
    }, [context, search, headingMode, indexVersion]);
    const headingSourcePath = headingSource?.path ?? null;
    useEffect(() => {
      if (!headingSource) {
        setHeadings(headingMode ? [] : null);
        return;
      }
      let cancelled = false;
      setHeadings(null);
      void loadNoteHeadings(headingSource).then((list) => {
        if (!cancelled) setHeadings(list);
      });
      return () => {
        cancelled = true;
      };
      // 只随目标笔记路径变化重新读取（条目对象每次重新计算，不能作为依赖）
    }, [headingSourcePath, headingMode]);

    const items: SuggestionItem[] = headingMode
      ? (headings ?? [])
        .filter((item) => item.text.toLowerCase().includes((headingQuery ?? '').trim().toLowerCase()))
        .map((heading) => ({ kind: 'heading', heading }))
      : noteItems;

    useEffect(() => {
      setSelectedIndex(0);
    }, [query]);

    // 键盘移动时保持当前项可见
    useEffect(() => {
      const active = listRef.current?.querySelector<HTMLElement>('.is-active');
      active?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    /** 进入某篇笔记的标题列表：把输入改写为 `[[目标#` */
    const drillIntoHeadings = (target: string) => {
      editor.chain().focus().insertContentAt(range, `[[${target}#`).run();
    };

    const select = (index: number) => {
      const item = items[index];
      if (item?.kind === 'note') {
        insertWikiLink(editor, range, `${item.target}${suffix}`, embed);
      } else if (item?.kind === 'heading') {
        insertWikiLink(editor, range, `${search.trim()}#${item.heading.text}${suffix}`, embed);
      } else if (query.trim()) {
        // 没有匹配项：按输入原样创建链接（目标稍后同步到达或另行新建都能自动生效）
        insertWikiLink(editor, range, query.trim(), embed);
      }
    };

    /** 更多选项：收起补全，带着已输入的内容打开完整弹窗 */
    const openDialog = () => {
      const docKey = currentDocKey(context);
      const inner = query.trim();
      editor.chain().focus().deleteRange(fullRange(editor, range)).run();
      void insertWikiLinkInEditor(editor, docKey, { inner, embed });
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
        if (event.key === 'ArrowRight') {
          const item = items[selectedIndex];
          if (item?.kind !== 'note' || !item.entry.isMarkdown) return false;
          drillIntoHeadings(item.target);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (!items.length && !query.trim()) return false;
          select(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    let title: string;
    if (headingMode) title = search.trim() ? `${search.trim()} 中的标题` : '本文中的标题';
    else title = search.trim() ? `链接到：${search.trim()}` : '链接到笔记';

    let emptyText: string;
    if (headingMode) emptyText = headings === null ? '正在读取标题…' : '没有匹配的标题';
    else emptyText = search.trim() ? `没有匹配的笔记，Enter 仍可插入「${search.trim()}」` : '输入笔记名称进行搜索';

    return (
      <div className="nb-wikilink-menu" role="listbox" aria-label="链接到笔记">
        <div className="nb-wikilink-menu-header">
          <span>{title}</span>
          {!IS_MOBILE_UI && (
            <span className="nb-wikilink-menu-hint">{headingMode ? '↑↓ 选择 · Enter 插入' : '↑↓ 选择 · → 选标题 · Enter 插入'}</span>
          )}
        </div>
        <div className="nb-wikilink-menu-list" ref={listRef}>
          {items.map((item, index) => (
            <div
              key={item.kind === 'note' ? item.entry.path : `${item.heading.text}:${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              className={`nb-wikilink-menu-item${index === selectedIndex ? ' is-active' : ''}`}
              // 不抢编辑器焦点，避免建议框在点击前就因失焦关闭
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => select(index)}
            >
              {item.kind === 'note' ? (
                <>
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
                  {item.entry.isMarkdown && (
                    <button
                      type="button"
                      className="nb-wikilink-menu-drill"
                      aria-label="链接到其中的标题"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        drillIntoHeadings(item.target);
                      }}
                    >
                      <Hash size={13} />
                      <ChevronRight size={13} />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="nb-wikilink-menu-icon">
                    <Hash size={15} />
                  </span>
                  <span
                    className="nb-wikilink-menu-name"
                    style={{ paddingLeft: Math.min(item.heading.level - 1, 4) * 12 }}
                  >
                    {item.heading.text}
                  </span>
                </>
              )}
            </div>
          ))}
          {items.length === 0 && <div className="nb-wikilink-menu-empty">{emptyText}</div>}
        </div>
        <div className="nb-wikilink-menu-footer">
          <button
            type="button"
            role="switch"
            aria-checked={embed}
            className={`nb-wikilink-menu-toggle${embed ? ' is-on' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setEmbed((value) => !value)}
          >
            <span className="nb-wikilink-menu-switch" />
            嵌入内容
          </button>
          <button
            type="button"
            className="nb-wikilink-menu-more"
            onMouseDown={(event) => event.preventDefault()}
            onClick={openDialog}
          >
            <SlidersHorizontal size={13} />
            更多选项
          </button>
        </div>
      </div>
    );
  },
);

/** 菜单定位：跟随光标，下方空间不足时向上展开，左右不超出视口 */
function positionPopup(popup: HTMLElement, props: SuggestionProps<SuggestionItem>): void {
  const rect = props.clientRect?.();
  if (!rect) return;
  const menuWidth = Math.min(340, window.innerWidth - 32);
  const menuHeight = 360;
  const spaceBelow = window.innerHeight - rect.bottom - 44;
  const spaceAbove = rect.top - 48;
  const left = Math.min(Math.max(16, rect.left), window.innerWidth - menuWidth - 16);
  popup.style.left = `${Math.round(left)}px`;
  // 高度上限通过 CSS 变量传给菜单本体：ReactRenderer 在两者之间多包一层，max-height 无法直接继承
  if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
    popup.style.top = 'auto';
    popup.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
    popup.style.setProperty('--nb-wikilink-menu-max-height', `${Math.max(160, Math.min(menuHeight, spaceAbove))}px`);
  } else {
    popup.style.bottom = 'auto';
    popup.style.top = `${Math.round(rect.bottom + 6)}px`;
    popup.style.setProperty('--nb-wikilink-menu-max-height', `${Math.max(160, Math.min(menuHeight, spaceBelow))}px`);
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
      Suggestion<SuggestionItem>({
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
        // 候选由菜单组件按查询计算（标题模式需要异步读取）
        items: () => [],
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
