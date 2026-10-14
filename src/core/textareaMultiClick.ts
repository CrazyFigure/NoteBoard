// NoteBoard 多行文本框双击 / 三击选区修正（全局）
//
// 问题：Chromium 的 textarea 原生选词取「光标后面的那个词」，
//   1. 行尾右侧空白处双击、空行双击：选中的是一个看不见的换行符（行尾画出一块空白高亮）；
//   2. 三击：选中整行时把行尾换行符一并选入，选区末端落到下一行行首。
//   多维表格的非 Markdown 多行文本、思维导图节点、大纲、公式 / 图表源码等所有 textarea 都受影响。
//
// 方案：捕获阶段监听 mousedown，让原生选词照常执行，随后立即修正选区：
//   - 双击选中了换行：行尾有文字时改选行尾最后一个词，行尾是空白或空行时只放置光标；
//   - 三击：去掉末尾的换行符，空行只放置光标。
//   点在文字上的双击、拖选与单行输入框不受影响。

/** 选区范围（textarea 的字符偏移） */
export interface TextRange {
  start: number;
  end: number;
}

let wordSegmenter: Intl.Segmenter | null = null;

/**
 * 根据原生双击 / 三击后的选区计算修正后的选区。
 * 选区不含换行符时无需修正，返回 null。
 */
export function correctMultiClickRange(value: string, range: TextRange, clickCount: 2 | 3): TextRange | null {
  const { start, end } = range;
  const newline = value.indexOf('\n', start);
  if (newline === -1 || newline >= end) return null;

  if (clickCount === 3) {
    // 三击只处理「整行 + 行尾换行」这一种原生结果，去掉换行；空行折叠为光标
    if (end !== newline + 1) return null;
    return { start, end: newline };
  }

  // 双击选中了换行：说明点在行尾右侧或空行上，以换行所在行的行尾为准
  const caret = { start: newline, end: newline };
  const lineStart = value.lastIndexOf('\n', newline - 1) + 1;
  if (newline === lineStart || /\s/.test(value[newline - 1])) return caret;

  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' });
  const lineText = value.slice(lineStart, newline);
  const segment = wordSegmenter.segment(lineText).containing(lineText.length - 1);
  if (!segment) return caret;
  return { start: lineStart + segment.index, end: lineStart + segment.index + segment.segment.length };
}

let installed = false;

/** 按下次数序号：连击很快时，上一击的延后修正执行前下一击已改写选区，此时放弃上一击的修正 */
let mouseDownSeq = 0;

/** 安装全局 textarea 双击 / 三击选区修正（幂等） */
export function installTextareaMultiClickFix(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'mousedown',
    (event) => {
      const seq = ++mouseDownSeq;
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || target.disabled) return;
      if (event.button !== 0 || (event.detail !== 2 && event.detail !== 3)) return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const clickCount = event.detail;
      // 原生选词在 mousedown 的默认动作里完成，下一任务中读取到的才是原生选区
      setTimeout(() => {
        if (seq !== mouseDownSeq || document.activeElement !== target) return;
        const next = correctMultiClickRange(
          target.value,
          { start: target.selectionStart, end: target.selectionEnd },
          clickCount,
        );
        if (next) target.setSelectionRange(next.start, next.end);
      }, 0);
    },
    { capture: true, passive: true },
  );
}
