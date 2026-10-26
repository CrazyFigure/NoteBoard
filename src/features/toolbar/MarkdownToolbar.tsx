// NoteBoard Markdown 编辑器顶部操作栏
// 适用于 Markdown 可视化与源码模式
// 支持多级下拉菜单、实时 Active/Hover 状态同步、撤销/重做与丰富排版格式化工具

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { Editor } from '@tiptap/core';
import {
  Undo2,
  Redo2,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Pilcrow,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Highlighter,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  ListCollapse,
  SquareCode,
  Columns2,
  Columns3,
  Columns4,
  Table as TableIcon,
  Code2,
  Sigma,
  Workflow,
  Boxes,
  Minus,
  Link2,
  Waypoints,
  Image as ImageIcon,
  Calendar,
  Clock,
  RemoveFormatting,
  PlusSquare,
  BarChart3,
  Smile,
} from 'lucide-react';
import {
  ToolbarButton,
  ToolbarDivider,
  ToolbarDropdown,
  ToolbarDropdownItem,
  HighlightColorPicker,
} from './ToolbarComponents';
import {
  undoDocumentHistory,
  redoDocumentHistory,
  useDocumentHistory,
} from '../history/documentHistory';
import { insertLocalImageWithDialog, pickAndSaveLocalImage } from '../editor-md/imagePaste';
import { promptImageUrl } from '../../components/promptPresets';
import {
  DEFAULT_DETAILS_SUMMARY,
  DETAILS_SOURCE_SNIPPET,
  detailsSourceBlock,
  insertDetailsContent,
  requestDetailsSummaryFocus,
} from '../editor-md/detailsExtension';
import { columnsSourceSnippet, insertColumnsBlock } from '../editor-md/columnsExtension';
import { calloutSourceBlock, calloutSourceSnippet, insertCalloutBlock } from '../editor-md/calloutExtension';
import { convertSelectionToCodeBlock, wrapSelectionInBlock } from '../editor-md/blockConvert';
import { alertSourceBlock, codeSourceBlock, quoteSourceBlock, wrapSourceLines } from '../editor-md/sourceBlockWrap';
import { ALERT_KINDS, AlertMenuIcon, alertMenuLabel, type AlertKind } from '../editor-md/alertExtension';
import { CALLOUT_PRESETS, CalloutPresetIcon, type CalloutPreset } from '../editor-md/calloutPickers';
import { RAW_HTML_SOURCE_SNIPPET, insertRawHtmlContent } from '../editor-md/rawHtmlBlockView';
import { insertWikiLinkInEditor, insertWikiLinkInSource } from '../wikilink/wikiLinkActions';
import { InlineEmojiGrid, insertInlineEmoji } from '../editor-md/inlineEmoji';
import { renderHighlightSource } from '../editor-md/markdownInlineMarks';
// 🔴 S03：从 editor-md 边界内实例表获取内核实例（不再依赖编辑器组件文件的 getter 导出）
import { getMdTipTapEditor as getActiveTipTapEditor, getMdSourceView as getActiveSourceView } from '../editor-md/editorInstances';
import { emit } from '../../core/emitter';
import { DEFAULT_INFOGRAPHIC_CODE } from '../infographic/infographicTemplates';
import type { EditorView } from '@codemirror/view';

/**
 * 源码模式有选区时把选中的整行包成块（与可视化模式「选中内容成为块正文」一致）
 * 无选区或选中的全是空行时返回 false，由调用方按原逻辑插入示例片段
 */
function wrapSourceSelection(view: EditorView, wrap: (body: string) => string): boolean {
  const { from, to, empty } = view.state.selection.main;
  if (empty) return false;
  const edit = wrapSourceLines(view.state.doc, from, to, wrap);
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.anchor, head: edit.head },
    scrollIntoView: true,
  });
  return true;
}

/**
 * 嵌入式编辑器自带的撤销栈（不走文件级时间线）
 * 可用性以函数提供：工具栏随编辑器事务自行刷新，每次渲染时读取最新状态。
 */
export interface MarkdownToolbarHistory {
  canUndo: () => boolean;
  canRedo: () => boolean;
  undo: () => void;
  redo: () => void;
}

interface MarkdownToolbarProps {
  docKey: string;
  editor: Editor | null;
  viewMode?: 'visual' | 'source' | null;
  /** 覆盖撤销/重做来源：多维表格单元格等嵌入式编辑器使用编辑器自身历史 */
  history?: MarkdownToolbarHistory;
  /** 覆盖超链接入口：未提供时按 docKey 广播给可视化内核的链接弹窗 */
  onOpenLink?: () => void;
  /** 空间不足时按钮换行排列（侧栏等窄容器） */
  wrap?: boolean;
}

export function MarkdownToolbar({
  docKey,
  editor: propEditor,
  viewMode,
  history,
  onOpenLink,
  wrap,
}: MarkdownToolbarProps) {
  // 保证获取到最新的 TipTap editor 实例
  const editor = propEditor || getActiveTipTapEditor(docKey) || null;
  const isSourceMode = viewMode === 'source';
  // 双链只在启用了该节点的编辑器中提供（多维表格单元格编辑器未启用）；源码模式首开时可能尚无可视化实例
  const canInsertWikiLink = editor ? Boolean(editor.schema.nodes.wikiLink) : isSourceMode;
  // Hook 必须无条件调用；嵌入式编辑器传入 history 时以其为准
  const documentHistory = useDocumentHistory(docKey);
  const canUndo = history ? history.canUndo() : documentHistory.canUndo;
  const canRedo = history ? history.canRedo() : documentHistory.canRedo;
  const handleUndo = () => (history ? history.undo() : undoDocumentHistory(docKey));
  const handleRedo = () => (history ? history.redo() : redoDocumentHistory(docKey));

  // 状态更新标识（促使 TipTap 选区变化时刷新 Active 状态）
  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick((t) => (t + 1) % 100000), []);

  // 监听 TipTap 编辑器事务与选区变化
  useEffect(() => {
    if (!editor || isSourceMode) return;
    const handleTransaction = () => {
      forceUpdate();
    };
    editor.on('transaction', handleTransaction);
    editor.on('selectionUpdate', handleTransaction);
    return () => {
      editor.off('transaction', handleTransaction);
      editor.off('selectionUpdate', handleTransaction);
    };
  }, [editor, isSourceMode, forceUpdate]);

  // 下拉菜单开闭状态
  const [headingDropdownOpen, setHeadingDropdownOpen] = useState(false);
  const [insertDropdownOpen, setInsertDropdownOpen] = useState(false);
  const [highlightDropdownOpen, setHighlightDropdownOpen] = useState(false);

  // ── 获取当前标题状态 ──
  const currentHeadingLabel = useMemo(() => {
    if (!editor || isSourceMode) return '正文';
    for (let level = 1; level <= 6; level++) {
      if (editor.isActive('heading', { level })) {
        return `H${level}`;
      }
    }
    return '正文';
  }, [editor, isSourceMode]);

  // ── 源码模式辅助文本插入 ──
  const executeSourceAction = useCallback((action: (view: EditorView) => void) => {
    const view = getActiveSourceView(docKey);
    if (!view) return;
    action(view);
    view.focus();
  }, [docKey]);

  // ── 标题与段落设置 ──
  const handleSetHeading = (level: number | 'paragraph') => {
    setHeadingDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        const line = view.state.doc.lineAt(from);
        const lineText = line.text;
        const cleaned = lineText.replace(/^#{1,6}\s+/, '');
        const newPrefix = level === 'paragraph' ? '' : '#'.repeat(level) + ' ';
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: newPrefix + cleaned },
          scrollIntoView: true,
        });
      });
      return;
    }
    if (!editor) return;
    if (level === 'paragraph') {
      editor.chain().focus().setParagraph().run();
    } else {
      editor.chain().focus().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run();
    }
  };

  // ── 文本样式快捷触发 ──
  const toggleMark = (mark: 'bold' | 'italic' | 'underline' | 'strike' | 'code') => {
    if (isSourceMode) {
      const wrapMap: Record<string, string> = {
        bold: '**',
        italic: '*',
        underline: '<u>$</u>',
        strike: '~~',
        code: '`',
      };
      const sym = wrapMap[mark];
      executeSourceAction((view) => {
        const { from, to, empty } = view.state.selection.main;
        const selText = view.state.sliceDoc(from, to);
        if (mark === 'underline') {
          const insert = `<u>${selText}</u>`;
          view.dispatch({
            changes: { from, to, insert },
            selection: empty ? { anchor: from + 3 } : { anchor: from, head: from + insert.length },
          });
        } else {
          const insert = `${sym}${selText}${sym}`;
          view.dispatch({
            changes: { from, to, insert },
            selection: empty ? { anchor: from + sym.length } : { anchor: from, head: from + insert.length },
          });
        }
      });
      return;
    }
    if (!editor) return;
    switch (mark) {
      case 'bold':
        editor.chain().focus().toggleBold().run();
        break;
      case 'italic':
        editor.chain().focus().toggleItalic().run();
        break;
      case 'underline':
        editor.chain().focus().toggleUnderline().run();
        break;
      case 'strike':
        editor.chain().focus().toggleStrike().run();
        break;
      case 'code':
        editor.chain().focus().toggleCode().run();
        break;
    }
  };

  // ── 列表切换 ──
  const toggleList = (type: 'bullet' | 'ordered' | 'task') => {
    if (isSourceMode) {
      const prefixMap = { bullet: '- ', ordered: '1. ', task: '- [ ] ' };
      const prefix = prefixMap[type];
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        const line = view.state.doc.lineAt(from);
        view.dispatch({
          changes: { from: line.from, to: line.from, insert: prefix },
          scrollIntoView: true,
        });
      });
      return;
    }
    if (!editor) return;
    if (type === 'bullet') editor.chain().focus().toggleBulletList().run();
    if (type === 'ordered') editor.chain().focus().toggleOrderedList().run();
    if (type === 'task') editor.chain().focus().toggleTaskList().run();
  };

  // ── 高亮操作 ──
  const handleSelectHighlightColor = (color: string) => {
    setHighlightDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from, to } = view.state.selection.main;
        const selText = view.state.sliceDoc(from, to);
        // 与可视化模式序列化写法一致，切换模式时不触发规范化
        const insert = renderHighlightSource(selText, color);
        view.dispatch({ changes: { from, to, insert } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().toggleHighlight({ color }).run();
  };

  const handleRemoveHighlight = () => {
    setHighlightDropdownOpen(false);
    if (!editor || isSourceMode) return;
    editor.chain().focus().unsetHighlight().run();
  };

  // ── 插入元素处理 ──
  const handleInsertTable = (rows: number, cols: number) => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const tableMarkdown = '\n| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 1 | 内容 2 | 内容 3 |\n\n';
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: tableMarkdown } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
  };

  const handleInsertMath = (type: 'inline' | 'block') => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const mathSnippet = type === 'inline' ? '$E=mc^2$' : '\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n';
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: mathSnippet } });
      });
      return;
    }
    if (!editor) return;
    if (type === 'inline') {
      editor.chain().focus().insertContent({ type: 'mathInline', attrs: { latex: 'E=mc^2' } }).run();
    } else {
      editor.chain().focus().insertContent({ type: 'mathBlock', attrs: { latex: '' } }).run();
    }
  };

  const handleInsertMermaid = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const mermaidCode = '\n```mermaid\ngraph TD\n  A[开始] --> B[处理]\n  B --> C[完成]\n```\n';
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: mermaidCode } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().insertContent({
      type: 'mermaidBlock',
      attrs: { code: 'graph TD\n  A[开始] --> B[处理]\n  B --> C[完成]' },
    }).run();
  };

  // 插入 Infographic 现代化信息图
  const handleInsertInfographic = () => {
    setInsertDropdownOpen(false);
    // 默认信息图模板与斜杠命令、右键菜单共用
    const tmpl = DEFAULT_INFOGRAPHIC_CODE;
    if (isSourceMode) {
      const infoSnippet = `\n\`\`\`infographic\n${tmpl}\n\`\`\`\n`;
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: infoSnippet } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().insertContent({
      type: 'infographicBlock',
      attrs: { code: tmpl },
    }).run();
  };

  const handleInsertAlert = (kind: AlertKind) => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const alertSnippet = `\n${alertSourceBlock(kind, '提示内容')}\n\n`;
      executeSourceAction((view) => {
        if (wrapSourceSelection(view, (body) => alertSourceBlock(kind, body))) return;
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: alertSnippet } });
      });
      return;
    }
    if (!editor) return;
    // 有选区时选中内容成为提示块正文，不再被空块替换掉
    if (!editor.state.selection.empty) {
      wrapSelectionInBlock(editor, 'githubAlert', { kind });
      return;
    }
    editor.chain().focus().insertContent({
      type: 'githubAlert',
      attrs: { kind },
      content: [{ type: 'paragraph' }],
    }).run();
  };

  // 插入高亮块：源码模式写入标准高亮块片段，可视化模式插入高亮块并把光标放到块内
  // 有选区时两种模式一致：选中内容成为高亮块正文
  const handleInsertCallout = (preset: CalloutPreset) => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        if (wrapSourceSelection(view, (body) => calloutSourceBlock(body, preset))) return;
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: calloutSourceSnippet(preset) } });
      });
      return;
    }
    if (!editor) return;
    if (!editor.state.selection.empty) {
      wrapSelectionInBlock(editor, 'calloutBlock', { color: preset.color, icon: preset.icon });
      return;
    }
    insertCalloutBlock(editor, preset);
  };

  const handleInsertCodeBlock = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const codeBlockSnippet = '\n```typescript\n// 在此编写代码\n```\n';
      executeSourceAction((view) => {
        if (wrapSourceSelection(view, codeSourceBlock)) return;
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: codeBlockSnippet } });
      });
      return;
    }
    if (!editor) return;
    // 有选区时选中的多个块合并为一个代码块（逐块切换会拆成多个代码块）
    if (!editor.state.selection.empty) {
      convertSelectionToCodeBlock(editor);
      return;
    }
    editor.chain().focus().toggleCodeBlock().run();
  };

  const handleInsertQuote = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        // 有选区时选中的每一行都加引用前缀，与可视化模式整块转为引用一致
        if (wrapSourceSelection(view, quoteSourceBlock)) return;
        const { from } = view.state.selection.main;
        const line = view.state.doc.lineAt(from);
        view.dispatch({ changes: { from: line.from, to: line.from, insert: '> ' } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().toggleBlockquote().run();
  };

  // 插入折叠块：源码模式写入标准 <details> 片段，可视化模式插入折叠块节点
  const handleInsertDetails = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        if (wrapSourceSelection(view, detailsSourceBlock)) return;
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: DETAILS_SOURCE_SNIPPET } });
      });
      return;
    }
    if (!editor) return;
    // 有选区时选中内容成为折叠正文，随后聚焦标题输入框
    if (!editor.state.selection.empty) {
      requestDetailsSummaryFocus();
      wrapSelectionInBlock(editor, 'detailsBlock', { summary: DEFAULT_DETAILS_SUMMARY });
      return;
    }
    editor.chain().focus().insertContent(insertDetailsContent()).run();
  };

  // 插入分栏卡片：源码模式写入标准分栏片段，可视化模式插入分栏节点并把光标放到第一栏
  const handleInsertColumns = (count: number) => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: columnsSourceSnippet(count) } });
      });
      return;
    }
    if (!editor) return;
    insertColumnsBlock(editor, count);
  };

  // 插入 HTML 块：源码模式写入示例片段，可视化模式插入空块并直接进入源码编辑
  const handleInsertRawHtml = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: RAW_HTML_SOURCE_SNIPPET } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().insertContent(insertRawHtmlContent()).run();
  };

  const handleInsertDivider = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: '\n---\n\n' } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().setHorizontalRule().run();
  };

  // ── 超链接与图片处理 ──
  const handleOpenLink = () => {
    setInsertDropdownOpen(false);
    if (onOpenLink) {
      onOpenLink();
      return;
    }
    emit('open-link-modal', { key: docKey });
  };

  // 双向链接：弹窗中选择笔记、标题、显示名与链接 / 嵌入方式（直接输入 `[[` 是快捷写法）
  const handleInsertWikiLink = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const view = getActiveSourceView(docKey);
      if (view) void insertWikiLinkInSource(view, docKey);
      return;
    }
    if (editor) void insertWikiLinkInEditor(editor, docKey);
  };

  const handleInsertLocalImage = async () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const imageInfo = await pickAndSaveLocalImage(docKey);
      if (imageInfo) {
        executeSourceAction((view) => {
          const { from, to } = view.state.selection.main;
          const snippet = `![${imageInfo.alt}](${imageInfo.src})`;
          view.dispatch({
            changes: { from, to, insert: snippet },
            selection: { anchor: from + snippet.length },
          });
        });
      }
      return;
    }
    if (editor) {
      insertLocalImageWithDialog(editor, docKey);
    }
  };

  const handleInsertNetworkImage = async () => {
    setInsertDropdownOpen(false);
    const url = await promptImageUrl();
    if (!url) return;
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from, to } = view.state.selection.main;
        const snippet = `![图片](${url})`;
        view.dispatch({
          changes: { from, to, insert: snippet },
          selection: { anchor: from + snippet.length },
        });
      });
      return;
    }
    // 弹窗期间标签可能已被关闭，编辑器实例随之销毁
    if (!editor || editor.isDestroyed) return;
    editor.chain().focus().setImage({ src: url }).run();
  };

  // ── 日期时间插入处理 ──
  const handleInsertDateTime = (mode: 'date' | 'time' | 'datetime') => {
    setInsertDropdownOpen(false);
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const textToInsert =
      mode === 'date' ? dateStr : mode === 'time' ? timeStr : `${dateStr} ${timeStr}`;

    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: textToInsert },
          selection: { anchor: from + textToInsert.length },
        });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().insertContent(textToInsert).run();
  };

  // ── 表情插入处理：两种模式写入的都是标准 Unicode 表情字符 ──
  const handleInsertEmoji = (char: string) => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: char },
          selection: { anchor: from + char.length },
        });
      });
      return;
    }
    if (!editor) return;
    insertInlineEmoji(editor, char);
  };

  const handleClearFormat = () => {
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from, to, empty } = view.state.selection.main;
        let targetFrom = from;
        let targetTo = to;
        let text = '';
        if (empty) {
          // 无选区时选取当前整行进行清除
          const line = view.state.doc.lineAt(from);
          targetFrom = line.from;
          targetTo = line.to;
          text = line.text;
        } else {
          text = view.state.sliceDoc(from, to);
        }
        // 清除行首块级语法（标题 #, 引用 >, 列表 -, 1.）及行内语法（加粗 **, 斜体 *, 删除线 ~~, 高亮 ==, 行内代码 `, 链接 [t](u)）
        const cleaned = text
          .replace(/^(#{1,6}\s+|>+\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/gm, '')
          .replace(/(\*\*|__)(.*?)\1/g, '$2')
          .replace(/(\*|_)(.*?)\1/g, '$2')
          .replace(/(~~)(.*?)\1/g, '$2')
          .replace(/(==)(.*?)\1/g, '$2')
          .replace(/(`)(.*?)\1/g, '$2')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

        view.dispatch({
          changes: { from: targetFrom, to: targetTo, insert: cleaned },
          selection: { anchor: targetFrom, head: targetFrom + cleaned.length },
        });
      });
      return;
    }

    const currentEditor = editor || getActiveTipTapEditor(docKey);
    if (!currentEditor) return;

    const { state } = currentEditor;
    const { from, empty } = state.selection;

    if (empty) {
      // 1. 无选区时：若处于标题/列表/引用等特殊块中，重置为普通段落
      currentEditor.chain().focus().clearNodes().run();

      // 2. 清除当前行内所有样式标记
      const $pos = state.doc.resolve(from);
      const start = $pos.start();
      const end = $pos.end();
      if (start < end) {
        currentEditor
          .chain()
          .focus()
          .setTextSelection({ from: start, to: end })
          .unsetAllMarks()
          .clearNodes()
          .setTextSelection(from)
          .run();
      } else {
        currentEditor.chain().focus().unsetAllMarks().clearNodes().run();
      }
    } else {
      // 存在选区：同时清除所有行内 Mark（加粗/斜体/下划线/删除线/高亮/链接等）与块级 Node（标题/列表/引用/代码块等）
      currentEditor
        .chain()
        .focus()
        .unsetAllMarks()
        .clearNodes()
        .run();
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        overflow: 'visible',
        flex: 1,
        flexWrap: wrap ? 'wrap' : undefined,
        rowGap: wrap ? 2 : undefined,
      }}
    >
      {/* ── 历史操作组 ── */}
      <ToolbarButton
        icon={<Undo2 size={15} strokeWidth={2.2} />}
        title="撤销"
        shortcut="Ctrl+Z"
        disabled={!canUndo}
        onClick={handleUndo}
      />
      <ToolbarButton
        icon={<Redo2 size={15} strokeWidth={2.2} />}
        title="重做"
        shortcut="Ctrl+Y"
        disabled={!canRedo}
        onClick={handleRedo}
      />

      <ToolbarDivider />

      {/* ── 标题与段落下拉菜单（二级菜单） ── */}
      <ToolbarDropdown
        isOpen={headingDropdownOpen}
        onOpenChange={setHeadingDropdownOpen}
        trigger={
          <ToolbarButton
            icon={<Heading size={15} />}
            label={currentHeadingLabel}
            hasDropdown
            title="标题等级"
            active={currentHeadingLabel !== '正文'}
          />
        }
      >
        <ToolbarDropdownItem
          icon={<Pilcrow size={14} />}
          label="正文段落"
          shortcut="Ctrl+Alt+0"
          active={currentHeadingLabel === '正文'}
          onClick={() => handleSetHeading('paragraph')}
        />
        <ToolbarDropdownItem
          icon={<Heading1 size={14} />}
          label="一级标题 (H1)"
          shortcut="Ctrl+Alt+1"
          active={currentHeadingLabel === 'H1'}
          onClick={() => handleSetHeading(1)}
        />
        <ToolbarDropdownItem
          icon={<Heading2 size={14} />}
          label="二级标题 (H2)"
          shortcut="Ctrl+Alt+2"
          active={currentHeadingLabel === 'H2'}
          onClick={() => handleSetHeading(2)}
        />
        <ToolbarDropdownItem
          icon={<Heading3 size={14} />}
          label="三级标题 (H3)"
          shortcut="Ctrl+Alt+3"
          active={currentHeadingLabel === 'H3'}
          onClick={() => handleSetHeading(3)}
        />
        <ToolbarDropdownItem
          icon={<Heading4 size={14} />}
          label="四级标题 (H4)"
          shortcut="Ctrl+Alt+4"
          active={currentHeadingLabel === 'H4'}
          onClick={() => handleSetHeading(4)}
        />
        <ToolbarDropdownItem
          icon={<Heading5 size={14} />}
          label="五级标题 (H5)"
          shortcut="Ctrl+Alt+5"
          active={currentHeadingLabel === 'H5'}
          onClick={() => handleSetHeading(5)}
        />
        <ToolbarDropdownItem
          icon={<Heading6 size={14} />}
          label="六级标题 (H6)"
          shortcut="Ctrl+Alt+6"
          active={currentHeadingLabel === 'H6'}
          onClick={() => handleSetHeading(6)}
        />
      </ToolbarDropdown>

      <ToolbarDivider />

      {/* ── 基础文本样式组 ── */}
      <ToolbarButton
        icon={<Bold size={15} strokeWidth={2.4} />}
        title="加粗"
        shortcut="Ctrl+B"
        active={!isSourceMode && Boolean(editor?.isActive('bold'))}
        onClick={() => toggleMark('bold')}
      />
      <ToolbarButton
        icon={<Italic size={15} strokeWidth={2.4} />}
        title="斜体"
        shortcut="Ctrl+I"
        active={!isSourceMode && Boolean(editor?.isActive('italic'))}
        onClick={() => toggleMark('italic')}
      />
      <ToolbarButton
        icon={<Underline size={15} strokeWidth={2.4} />}
        title="下划线"
        shortcut="Ctrl+U"
        active={!isSourceMode && Boolean(editor?.isActive('underline'))}
        onClick={() => toggleMark('underline')}
      />
      <ToolbarButton
        icon={<Strikethrough size={15} strokeWidth={2.4} />}
        title="删除线"
        active={!isSourceMode && Boolean(editor?.isActive('strike'))}
        onClick={() => toggleMark('strike')}
      />
      <ToolbarButton
        icon={<Code size={15} strokeWidth={2.4} />}
        title="行内代码"
        shortcut="`"
        active={!isSourceMode && Boolean(editor?.isActive('code'))}
        onClick={() => toggleMark('code')}
      />

      {/* ── 文本高亮与调色盘下拉（二级调色盘） ── */}
      <ToolbarDropdown
        isOpen={highlightDropdownOpen}
        onOpenChange={setHighlightDropdownOpen}
        trigger={
          <ToolbarButton
            icon={<Highlighter size={15} />}
            title="文本高亮"
            hasDropdown
            active={!isSourceMode && Boolean(editor?.isActive('highlight'))}
          />
        }
      >
        <HighlightColorPicker
          onSelectColor={handleSelectHighlightColor}
          onRemoveHighlight={handleRemoveHighlight}
        />
      </ToolbarDropdown>

      <ToolbarDivider />

      {/* ── 列表组（按快捷键数字 7 / 8 / 9 排列） ── */}
      <ToolbarButton
        icon={<ListOrdered size={15} strokeWidth={2.2} />}
        title="有序列表"
        shortcut="Ctrl+Shift+7"
        active={!isSourceMode && Boolean(editor?.isActive('orderedList'))}
        onClick={() => toggleList('ordered')}
      />
      <ToolbarButton
        icon={<List size={15} strokeWidth={2.2} />}
        title="无序列表"
        shortcut="Ctrl+Shift+8"
        active={!isSourceMode && Boolean(editor?.isActive('bulletList'))}
        onClick={() => toggleList('bullet')}
      />
      <ToolbarButton
        icon={<CheckSquare size={15} strokeWidth={2.2} />}
        title="任务列表"
        shortcut="Ctrl+Shift+9"
        active={!isSourceMode && Boolean(editor?.isActive('taskList'))}
        onClick={() => toggleList('task')}
      />

      <ToolbarDivider />

      {/* ── 插入块级与丰富元素下拉菜单（二级/三级菜单集大成） ── */}
      <ToolbarDropdown
        isOpen={insertDropdownOpen}
        onOpenChange={setInsertDropdownOpen}
        trigger={
          <ToolbarButton
            icon={<PlusSquare size={15} />}
            label="插入"
            hasDropdown
            title="插入超链接、图片、表格、公式、图表、GitHub 提示块、高亮块、折叠块、分栏、HTML 块、表情、日期时间等"
          />
        }
      >
        {/* 1. 代码块 */}
        <ToolbarDropdownItem
          icon={<Code2 size={14} />}
          label="代码块"
          onClick={handleInsertCodeBlock}
        />

        {/* 2. GitHub 提示块 (Alert) 二级菜单 */}
        <ToolbarDropdownItem
          icon={<Boxes size={14} color="#3b82f6" />}
          label="GitHub 提示块"
          submenu={
            <>
              {/* 文案与图标取自 alertExtension，与斜杠命令、右键菜单保持一致 */}
              {ALERT_KINDS.map((kind) => (
                <ToolbarDropdownItem
                  key={kind}
                  icon={<AlertMenuIcon kind={kind} size={14} />}
                  label={alertMenuLabel(kind)}
                  onClick={() => handleInsertAlert(kind)}
                />
              ))}
            </>
          }
        />

        {/* 2.5 高亮块二级菜单（常用颜色与图标组合，插入后可随时更换） */}
        <ToolbarDropdownItem
          icon={<Highlighter size={14} color="#8b5cf6" />}
          label="高亮块"
          submenu={
            <>
              {CALLOUT_PRESETS.map((preset) => (
                <ToolbarDropdownItem
                  key={preset.id}
                  icon={<CalloutPresetIcon preset={preset} size={14} />}
                  label={`${preset.label}（${preset.description.split(' · ')[0]}）`}
                  onClick={() => handleInsertCallout(preset)}
                />
              ))}
            </>
          }
        />

        {/* 3. 引用块 (Quote) */}
        <ToolbarDropdownItem
          icon={<Quote size={14} />}
          label="引用块"
          onClick={handleInsertQuote}
        />

        {/* 3.1 折叠块 (Details) */}
        <ToolbarDropdownItem
          icon={<ListCollapse size={14} />}
          label="折叠块"
          onClick={handleInsertDetails}
        />

        {/* 3.15 分栏卡片二级菜单 */}
        <ToolbarDropdownItem
          icon={<Columns2 size={14} />}
          label="分栏卡片"
          submenu={
            <>
              <ToolbarDropdownItem
                icon={<Columns2 size={14} />}
                label="两栏"
                onClick={() => handleInsertColumns(2)}
              />
              <ToolbarDropdownItem
                icon={<Columns3 size={14} />}
                label="三栏"
                onClick={() => handleInsertColumns(3)}
              />
              <ToolbarDropdownItem
                icon={<Columns4 size={14} />}
                label="四栏"
                onClick={() => handleInsertColumns(4)}
              />
            </>
          }
        />

        {/* 3.2 HTML 块 */}
        <ToolbarDropdownItem
          icon={<SquareCode size={14} />}
          label="HTML 块"
          onClick={handleInsertRawHtml}
        />

        {/* 4. 表格二级菜单 */}
        <ToolbarDropdownItem
          icon={<TableIcon size={14} />}
          label="表格"
          submenu={
            <>
              <ToolbarDropdownItem
                label="标准表格 (3x3)"
                onClick={() => handleInsertTable(3, 3)}
              />
              <ToolbarDropdownItem
                label="紧凑表格 (2x2)"
                onClick={() => handleInsertTable(2, 2)}
              />
              <ToolbarDropdownItem
                label="宽表格 (4x4)"
                onClick={() => handleInsertTable(4, 4)}
              />
            </>
          }
        />

        {/* 5. 公式与图表二级菜单 */}
        <ToolbarDropdownItem
          icon={<Sigma size={14} />}
          label="公式与图表"
          submenu={
            <>
              <ToolbarDropdownItem
                icon={<Sigma size={14} />}
                label="行内公式 ($...$)"
                onClick={() => handleInsertMath('inline')}
              />
              <ToolbarDropdownItem
                icon={<Sigma size={14} />}
                label="独立公式块 ($$...$$)"
                onClick={() => handleInsertMath('block')}
              />
              <ToolbarDropdownItem
                icon={<Workflow size={14} />}
                label="Mermaid 流程图表"
                onClick={handleInsertMermaid}
              />
              <ToolbarDropdownItem
                icon={<BarChart3 size={14} color="#3b82f6" />}
                label="Infographic 现代信息图"
                onClick={handleInsertInfographic}
              />
            </>
          }
        />

        {/* 6. 图片二级菜单 */}
        <ToolbarDropdownItem
          icon={<ImageIcon size={14} />}
          label="图片"
          submenu={
            <>
              <ToolbarDropdownItem
                icon={<ImageIcon size={14} />}
                label="本地图片"
                onClick={handleInsertLocalImage}
              />
              <ToolbarDropdownItem
                icon={<ImageIcon size={14} style={{ opacity: 0.7 }} />}
                label="网络图片"
                onClick={handleInsertNetworkImage}
              />
            </>
          }
        />

        {/* 6.5 表情二级面板（写入标准 Unicode 表情，与高亮块「表情」页同一套图案） */}
        <ToolbarDropdownItem
          icon={<Smile size={14} color="#f59e0b" />}
          label="表情"
          submenuWidth={310}
          submenu={<InlineEmojiGrid onSelect={handleInsertEmoji} />}
        />

        {/* 7. 超链接菜单项 */}
        <ToolbarDropdownItem
          icon={<Link2 size={14} />}
          label="超链接"
          shortcut="Ctrl+K"
          onClick={handleOpenLink}
        />

        {/* 7.5 双向链接（多维表格单元格等未启用双链的编辑器不显示） */}
        {canInsertWikiLink && (
          <ToolbarDropdownItem
            icon={<Waypoints size={14} color="#8b5cf6" />}
            label="双向链接"
            shortcut="[["
            onClick={handleInsertWikiLink}
          />
        )}

        {/* 8. 日期时间二级菜单 */}
        <ToolbarDropdownItem
          icon={<Calendar size={14} />}
          label="日期时间"
          submenu={
            <>
              <ToolbarDropdownItem
                icon={<Calendar size={14} />}
                label="当前日期"
                onClick={() => handleInsertDateTime('date')}
              />
              <ToolbarDropdownItem
                icon={<Clock size={14} />}
                label="当前时刻"
                onClick={() => handleInsertDateTime('time')}
              />
              <ToolbarDropdownItem
                icon={<Calendar size={14} />}
                label="日期与时刻"
                onClick={() => handleInsertDateTime('datetime')}
              />
            </>
          }
        />

        {/* 9. 水平分割线 */}
        <ToolbarDropdownItem
          icon={<Minus size={14} />}
          label="水平分割线"
          onClick={handleInsertDivider}
        />
      </ToolbarDropdown>

      {/* 超链接与图片入口统一收在「插入」菜单内 */}
      <ToolbarDivider />

      {/* ── 清除格式 ── */}
      <ToolbarButton
        icon={<RemoveFormatting size={15} color="#ef4444" />}
        title="清除选中文本格式"
        onClick={handleClearFormat}
      />
    </div>
  );
}
