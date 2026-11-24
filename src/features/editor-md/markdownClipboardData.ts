// Markdown 源码仍通过 text/plain 对外提供。自定义类型只告知 NoteBoard 可视化编辑器应按 Markdown 粘贴。
export const MARKDOWN_CLIPBOARD_TYPE = 'application/x-noteboard-markdown';
export const WEB_MARKDOWN_CLIPBOARD_TYPE = `web ${MARKDOWN_CLIPBOARD_TYPE}`;

/** 源码编辑器处理复制后补充标记，沿用 CodeMirror 的选区、整行复制和剪切语义。 */
export function tagSourceMarkdownCopy(event: ClipboardEvent): void {
  const data = event.clipboardData;
  if (event.defaultPrevented && data?.getData('text/plain')) data.setData(MARKDOWN_CLIPBOARD_TYPE, '1');
}
