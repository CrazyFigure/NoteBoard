// 各类文本编辑器共用缩进设置，避免 Markdown、源码及普通文本各自使用固定宽度。
import { useSettingsStore } from '../../stores/settingsStore';

/** 读取当前设置；宽度沿用设置界面的 1—8 范围，缺失或非法值回退到默认的 2。 */
export function getEditorIndentation(): { tabSize: number; unit: string } {
  const settings = useSettingsStore.getState().settings.editor;
  const tabSize = Number.isFinite(settings.tabSize) && settings.tabSize > 0
    ? Math.max(1, Math.min(8, Math.trunc(settings.tabSize))) : 2;
  return { tabSize, unit: settings.insertSpaces === false ? '\t' : ' '.repeat(tabSize) };
}

/** 删除一层缩进所占的字符数；一个制表符推进到当前缩进宽度，不删除正文。 */
export function leadingIndentLength(text: string, tabSize: number): number {
  let length = 0;
  let columns = 0;
  while (length < text.length && columns < tabSize) {
    if (text[length] === ' ') columns++;
    else if (text[length] === '\t') columns = tabSize;
    else break;
    length++;
  }
  return length;
}
