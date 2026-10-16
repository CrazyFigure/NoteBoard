// NoteBoard 粘贴格式转换提示
// 纯文本粘贴的内容含 Markdown / HTML 语法时显示一枚小胶囊，询问是否转换为格式。
// overlay：固定在编辑区可视范围的左上角（不随滚动或光标移动），用于笔记本正文；
// inline：作为普通元素放进宿主的工具栏 / 底栏，用于多维表格单元格等小编辑区，不遮挡正文。
// 只占一行，便于对照纯文本效果再决定；
// 下一次修改文档、点击关闭或按 Esc 后消失（范围跟踪见 pasteFormatDetect）。

import { useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Wand2, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import {
  convertPastedRange,
  detectPastedFormat,
  dismissPastedRange,
  getPastedTextRange,
  isRangeAlreadyFormatted,
  type PasteConvertMode,
  type PastedFormatKind,
  type PastedTextRange,
} from './pasteFormatDetect';

const KIND_LABEL: Record<PastedFormatKind, string> = {
  markdown: '检测到 Markdown',
  html: '检测到 HTML',
  mixed: '检测到 Markdown / HTML',
};

// 各转换方式的按钮文字与说明
const MODE_ACTION: Record<PasteConvertMode, { label: string; tip: string }> = {
  markdown: { label: '转换', tip: '按格式重新插入，可撤销' },
  richText: { label: '转为正文', tip: '解析为标题、链接等格式，可撤销' },
  htmlBlock: { label: '转为 HTML 块', tip: '整段保留为一个 HTML 块，可撤销' },
};

interface PasteFormatPromptProps {
  editor: Editor;
  /** 摆放方式：overlay 吸附在滚动容器左上角（须为其直接子元素），inline 随宿主布局 */
  placement?: 'overlay' | 'inline';
}

export function PasteFormatPrompt({ editor, placement = 'overlay' }: PasteFormatPromptProps) {
  const [range, setRange] = useState<PastedTextRange | null>(() => getPastedTextRange(editor.state));

  // 跟随编辑器事务读取粘贴范围：纯选区变化时插件返回同一对象，不触发重渲染
  useEffect(() => {
    const sync = () => setRange(getPastedTextRange(editor.state));
    editor.on('transaction', sync);
    return () => {
      editor.off('transaction', sync);
    };
  }, [editor]);

  // 每段粘贴文本只检测一次（范围映射不改变文本）
  const text = range?.text ?? null;
  const detected = useMemo(() => (text ? detectPastedFormat(editor, text) : null), [editor, text]);
  // 粘贴规则已即时转换（如 **粗体**）时与转换结果相同，不提示
  const shown = useMemo(
    () => Boolean(range && detected && !isRangeAlreadyFormatted(editor, editor.state, range, detected.modes[0])),
    [editor, range, detected],
  );

  // 提示显示期间 Esc 关闭提示（不触发其它 Esc 行为）
  useEffect(() => {
    if (!shown) return;
    const dom = editor.view.dom;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dismissPastedRange(editor);
    };
    dom.addEventListener('keydown', onKeyDown, true);
    return () => dom.removeEventListener('keydown', onKeyDown, true);
  }, [editor, shown]);

  if (!shown || !range || !detected) return null;

  // 底栏中的提示向上弹出说明，左上角的提示向下弹出
  const tooltipSide = placement === 'inline' ? 'top' : 'bottom';

  const handleConvert = (mode: PasteConvertMode) => {
    if (!convertPastedRange(editor, range, mode)) dismissPastedRange(editor);
  };

  const prompt = (
    <div
      className={`nb-paste-format-prompt${placement === 'inline' ? ' is-inline' : ''}`}
      // 按下按钮不抢编辑器焦点与选区
      onMouseDown={(e) => e.preventDefault()}
      role="status"
    >
      <Wand2 size={15} className="nb-paste-format-icon" />
      <span className="nb-paste-format-label">{KIND_LABEL[detected.kind]}</span>
      {detected.modes.map((mode, index) => (
        <Tooltip key={mode} content={MODE_ACTION[mode].tip} side={tooltipSide} sideOffset={6}>
          <button
            type="button"
            className={`nb-paste-format-btn${index === 0 ? ' is-primary' : ''}`}
            onClick={() => handleConvert(mode)}
          >
            {MODE_ACTION[mode].label}
          </button>
        </Tooltip>
      ))}
      <Tooltip content="保持纯文本" shortcut="Esc" side={tooltipSide} sideOffset={6}>
        <button
          type="button"
          className="nb-paste-format-btn is-icon"
          aria-label="关闭"
          onClick={() => dismissPastedRange(editor)}
        >
          <X size={15} />
        </button>
      </Tooltip>
    </div>
  );

  if (placement === 'inline') return prompt;
  // 零高度的吸顶层：随滚动容器停在可视区顶部，不占文档流、不推动正文
  return <div className="nb-paste-format-anchor">{prompt}</div>;
}
