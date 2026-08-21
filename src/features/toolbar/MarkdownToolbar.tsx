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
  Table as TableIcon,
  Code2,
  Sigma,
  Workflow,
  Info,
  Lightbulb,
  AlertCircle,
  AlertTriangle,
  Flame,
  Minus,
  Link2,
  Image as ImageIcon,
  Calendar,
  Clock,
  RemoveFormatting,
  PlusSquare,
  CodeXml,
  Eye,
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
import { getActiveTipTapEditor, getActiveSourceView } from '../editor-md/TipTapEditor';
import { emit } from '../../core/emitter';
import type { EditorView } from '@codemirror/view';

interface MarkdownToolbarProps {
  docKey: string;
  editor: Editor | null;
  viewMode?: 'visual' | 'source' | null;
}

export function MarkdownToolbar({ docKey, editor: propEditor, viewMode }: MarkdownToolbarProps) {
  // 保证获取到最新的 TipTap editor 实例
  const editor = propEditor || getActiveTipTapEditor(docKey) || null;
  const isSourceMode = viewMode === 'source';
  const { canUndo, canRedo } = useDocumentHistory(docKey);

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
        const insert = `<mark style="background: ${color}">${selText}</mark>`;
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

  const handleInsertAlert = (kind: 'note' | 'tip' | 'important' | 'warning' | 'caution') => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const alertSnippet = `\n> [!${kind.toUpperCase()}]\n> 提示内容\n\n`;
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: alertSnippet } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().insertContent({
      type: 'githubAlert',
      attrs: { kind },
      content: [{ type: 'paragraph' }],
    }).run();
  };

  const handleInsertCodeBlock = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      const codeBlockSnippet = '\n```typescript\n// 在此编写代码\n```\n';
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        view.dispatch({ changes: { from, to: from, insert: codeBlockSnippet } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().toggleCodeBlock().run();
  };

  const handleInsertQuote = () => {
    setInsertDropdownOpen(false);
    if (isSourceMode) {
      executeSourceAction((view) => {
        const { from } = view.state.selection.main;
        const line = view.state.doc.lineAt(from);
        view.dispatch({ changes: { from: line.from, to: line.from, insert: '> ' } });
      });
      return;
    }
    if (!editor) return;
    editor.chain().focus().toggleBlockquote().run();
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
    emit('open-link-modal', { key: docKey });
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

  const handleInsertNetworkImage = () => {
    setInsertDropdownOpen(false);
    const url = window.prompt('请输入图片网络 URL:');
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
    if (!editor) return;
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
    const { from, to, empty } = state.selection;

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, overflow: 'visible', flex: 1 }}>
      {/* ── 历史操作组 ── */}
      <ToolbarButton
        icon={<Undo2 size={15} strokeWidth={2.2} />}
        title="撤销"
        shortcut="Ctrl+Z"
        disabled={!canUndo}
        onClick={() => undoDocumentHistory(docKey)}
      />
      <ToolbarButton
        icon={<Redo2 size={15} strokeWidth={2.2} />}
        title="重做"
        shortcut="Ctrl+Y"
        disabled={!canRedo}
        onClick={() => redoDocumentHistory(docKey)}
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

      {/* ── 列表组 ── */}
      <ToolbarButton
        icon={<List size={15} strokeWidth={2.2} />}
        title="无序列表"
        shortcut="Ctrl+Shift+8"
        active={!isSourceMode && Boolean(editor?.isActive('bulletList'))}
        onClick={() => toggleList('bullet')}
      />
      <ToolbarButton
        icon={<ListOrdered size={15} strokeWidth={2.2} />}
        title="有序列表"
        shortcut="Ctrl+Shift+7"
        active={!isSourceMode && Boolean(editor?.isActive('orderedList'))}
        onClick={() => toggleList('ordered')}
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
            title="插入超链接、图片、表格、公式、图表、提示块、日期时间等"
          />
        }
      >
        {/* 1. 代码块 */}
        <ToolbarDropdownItem
          icon={<Code2 size={14} />}
          label="代码块"
          onClick={handleInsertCodeBlock}
        />

        {/* 2. GitHub Alert 提示块二级菜单 */}
        <ToolbarDropdownItem
          icon={<Info size={14} color="#3b82f6" />}
          label="提示块 (Callout)"
          submenu={
            <>
              <ToolbarDropdownItem
                icon={<Info size={14} color="#3b82f6" />}
                label="Note 补充说明"
                onClick={() => handleInsertAlert('note')}
              />
              <ToolbarDropdownItem
                icon={<Lightbulb size={14} color="#10b981" />}
                label="Tip 技巧建议"
                onClick={() => handleInsertAlert('tip')}
              />
              <ToolbarDropdownItem
                icon={<AlertCircle size={14} color="#8b5cf6" />}
                label="Important 重要提示"
                onClick={() => handleInsertAlert('important')}
              />
              <ToolbarDropdownItem
                icon={<AlertTriangle size={14} color="#f59e0b" />}
                label="Warning 注意警告"
                onClick={() => handleInsertAlert('warning')}
              />
              <ToolbarDropdownItem
                icon={<Flame size={14} color="#ef4444" />}
                label="Caution 高危警告"
                onClick={() => handleInsertAlert('caution')}
              />
            </>
          }
        />

        {/* 3. 引用块 (Quote) */}
        <ToolbarDropdownItem
          icon={<Quote size={14} />}
          label="引用块 (Quote)"
          onClick={handleInsertQuote}
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
                label="插入本地图片"
                onClick={handleInsertLocalImage}
              />
              <ToolbarDropdownItem
                icon={<ImageIcon size={14} style={{ opacity: 0.7 }} />}
                label="插入网络图片"
                onClick={handleInsertNetworkImage}
              />
            </>
          }
        />

        {/* 7. 超链接菜单项 */}
        <ToolbarDropdownItem
          icon={<Link2 size={14} />}
          label="超链接"
          shortcut="Ctrl+K"
          onClick={handleOpenLink}
        />

        {/* 8. 日期时间二级菜单 */}
        <ToolbarDropdownItem
          icon={<Calendar size={14} />}
          label="日期时间"
          submenu={
            <>
              <ToolbarDropdownItem
                icon={<Calendar size={14} />}
                label="插入当前日期"
                onClick={() => handleInsertDateTime('date')}
              />
              <ToolbarDropdownItem
                icon={<Clock size={14} />}
                label="插入当前时刻"
                onClick={() => handleInsertDateTime('time')}
              />
              <ToolbarDropdownItem
                icon={<Calendar size={14} />}
                label="插入日期与时刻"
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

      {/* ── 媒体与超链接 ── */}
      <ToolbarButton
        icon={<Link2 size={15} />}
        title="插入/编辑超链接"
        shortcut="Ctrl+K"
        active={!isSourceMode && Boolean(editor?.isActive('link'))}
        onClick={handleOpenLink}
      />
      <ToolbarButton
        icon={<ImageIcon size={15} />}
        title="插入本地图片"
        onClick={handleInsertLocalImage}
      />

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
