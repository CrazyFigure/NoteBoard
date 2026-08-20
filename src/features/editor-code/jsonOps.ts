// NoteBoard JSON 核心操作模块（校验、压缩、展开）
// 支持对选中文本局部操作或全文操作，并在失败时精确定位错误位置
// 详见 docs/07-UI布局与交互规范.md

import type { EditorView } from '@codemirror/view';
import { showToast } from '../../stores/toastStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatXml } from './format';
import type { LanguageId } from '../../core/ipc/types';

// ── 错误位置解析工具 ──

/** 从 JSON.parse 错误消息中解析错误位置偏移量 */
export function extractJsonErrorPosition(msg: string, text: string): number {
  // 匹配 "at position N"
  const posMatch = msg.match(/position\s+(\d+)/i);
  if (posMatch) {
    const pos = parseInt(posMatch[1], 10);
    return Math.min(Math.max(0, pos), text.length);
  }

  // 匹配 "line X column Y"
  const lineMatch = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineMatch) {
    const targetLine = parseInt(lineMatch[1], 10) - 1;
    const targetCol = parseInt(lineMatch[2], 10) - 1;
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < targetLine && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    return Math.min(Math.max(0, offset + targetCol), text.length);
  }

  return 0;
}

// ── 核心纯函数 ──

/** 校验 JSON 文本结果 */
export interface JsonValidationResult {
  valid: boolean;
  error?: string;
  errorPos?: number;
}

/** 校验 JSON 文本 */
export function validateJsonText(text: string): JsonValidationResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { valid: false, error: '文本内容为空', errorPos: 0 };
  }
  try {
    JSON.parse(trimmed);
    return { valid: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorPos = extractJsonErrorPosition(msg, trimmed);
    return { valid: false, error: msg, errorPos };
  }
}

/** 压缩 JSON 文本（转换为单行紧凑形式） */
export function minifyJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('文本内容为空');
  }
  const parsed = JSON.parse(trimmed);
  return JSON.stringify(parsed);
}

/** 展开/格式化 JSON 文本（带指定缩进与换行） */
export function expandJsonText(text: string, tabSize: number = 2): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('文本内容为空');
  }
  const parsed = JSON.parse(trimmed);
  const indent = ' '.repeat(tabSize);
  return JSON.stringify(parsed, null, indent);
}

// ── 编辑器 Action 处理器（针对 CodeMirror 6 实例） ──

/** 获取目标文本及选区范围（若有选区则针对选区，否则针对全文） */
function getTargetRange(view: EditorView, forcedScope?: 'all' | 'selection' | 'auto') {
  const selection = view.state.selection.main;
  const hasSelection = !selection.empty;

  if (forcedScope === 'selection') {
    if (!hasSelection) {
      return { isSelected: false, from: 0, to: 0, text: '', selection, noSelectionError: true };
    }
    return {
      isSelected: true,
      from: selection.from,
      to: selection.to,
      text: view.state.sliceDoc(selection.from, selection.to),
      selection,
      noSelectionError: false,
    };
  }

  if (forcedScope === 'all') {
    return {
      isSelected: false,
      from: 0,
      to: view.state.doc.length,
      text: view.state.doc.toString(),
      selection,
      noSelectionError: false,
    };
  }

  const isSelected = hasSelection;
  const from = isSelected ? selection.from : 0;
  const to = isSelected ? selection.to : view.state.doc.length;
  const text = isSelected ? view.state.sliceDoc(from, to) : view.state.doc.toString();
  return { isSelected, from, to, text, selection, noSelectionError: false };
}

export interface JsonOpOptions {
  scope?: 'all' | 'selection' | 'auto';
  tabSize?: number;
  lang?: LanguageId;
}

/**
 * 执行 JSON 格式校验
 * 支持选中文本校验或全文校验，失败时自动选中错误字符位置
 */
export function handleValidateJson(view: EditorView, options?: JsonOpOptions): boolean {
  const { isSelected, from, text, noSelectionError } = getTargetRange(view, options?.scope);
  if (noSelectionError) {
    showToast('未选择任何文本，请先选中要校验的 JSON 片段', 'warning');
    return false;
  }
  const scopeName = isSelected ? '选中文本' : '全文';

  if (!text.trim()) {
    showToast(`当前${scopeName}内容为空，无法校验`, 'warning');
    return false;
  }

  const result = validateJsonText(text);

  if (result.valid) {
    // 校验成功提示
    showToast(`✓ JSON 格式校验通过（${scopeName}）`, 'success');
    return true;
  }

  // 校验失败提示
  showToast(`JSON 校验失败（${scopeName}）: ${result.error}`, 'error', 4500);

  // 精确定位并高亮错误字符位置
  const errOffset = result.errorPos ?? 0;
  const targetPos = Math.min(from + errOffset, view.state.doc.length);
  view.dispatch({
    selection: { anchor: targetPos, head: Math.min(targetPos + 1, view.state.doc.length) },
    scrollIntoView: true,
  });
  view.focus();

  return true;
}

/**
 * 执行 JSON 压缩（Minify）
 * 将选中文本或全文转换为单行紧凑格式
 */
export function handleMinifyJson(view: EditorView, options?: JsonOpOptions): boolean {
  const { isSelected, from, to, text, selection, noSelectionError } = getTargetRange(view, options?.scope);
  if (noSelectionError) {
    showToast('未选择任何文本，请先选中要压缩的 JSON 片段', 'warning');
    return false;
  }
  const scopeName = isSelected ? '选中文本' : '全文';

  if (!text.trim()) {
    showToast(`当前${scopeName}内容为空，无法压缩`, 'warning');
    return false;
  }

  try {
    const minified = minifyJsonText(text);

    // 内容无变化时轻提示
    if (minified === text) {
      showToast(`JSON 已经是压缩状态（${scopeName}）`, 'info');
      return true;
    }

    // 替换编辑器内容（选区或全文）
    view.dispatch({
      changes: { from, to, insert: minified },
      selection: isSelected
        ? { anchor: from, head: from + minified.length }
        : { anchor: Math.min(selection.anchor, minified.length) },
      scrollIntoView: true,
    });
    view.focus();

    showToast(`✓ JSON 压缩成功（${scopeName}）`, 'success');
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`JSON 压缩失败（${scopeName}格式错误）: ${msg}`, 'error', 4500);
    return false;
  }
}

/**
 * 执行 XML 格式化
 */
export function handleFormatXml(view: EditorView, options?: JsonOpOptions): boolean {
  const { isSelected, from, to, text, selection, noSelectionError } = getTargetRange(view, options?.scope);
  if (noSelectionError) {
    showToast('未选择任何文本，请先选中要格式化的 XML 片段', 'warning');
    return false;
  }
  const scopeName = isSelected ? '选中文本' : '全文';

  if (!text.trim()) {
    showToast(`当前${scopeName}内容为空，无法格式化`, 'warning');
    return false;
  }

  try {
    const formattedXml = formatXml(text);
    view.dispatch({
      changes: { from, to, insert: formattedXml },
      selection: isSelected
        ? { anchor: from, head: from + formattedXml.length }
        : { anchor: Math.min(selection.anchor, formattedXml.length) },
      scrollIntoView: true,
    });
    view.focus();
    showToast(`✓ XML 格式化成功（${scopeName}）`, 'success');
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`XML 格式化失败: ${msg}`, 'error', 4500);
    return false;
  }
}

/**
 * 执行 JSON 展开 / 格式化（Expand / Format）
 * 格式化选中文本或全文，支持根据 settings.editor.tabSize 或 options.tabSize 调整缩进
 */
export function handleExpandJson(
  view: EditorView,
  langOrOptions?: LanguageId | JsonOpOptions,
): boolean {
  const options: JsonOpOptions =
    typeof langOrOptions === 'string'
      ? { lang: langOrOptions }
      : langOrOptions ?? {};

  const { isSelected, from, to, text, selection, noSelectionError } = getTargetRange(view, options.scope);
  if (noSelectionError) {
    showToast('未选择任何文本，请先选中要格式化的内容', 'warning');
    return false;
  }
  const scopeName = isSelected ? '选中文本' : '全文';

  if (!text.trim()) {
    showToast(`当前${scopeName}内容为空，无法展开`, 'warning');
    return false;
  }

  // 若明确为 XML 格式文件且未选中非 XML 文本，回退至 XML 格式化
  if (options.lang === 'xml') {
    return handleFormatXml(view, options);
  }

  try {
    const defaultTabSize = useSettingsStore.getState().settings.editor.tabSize ?? 2;
    const tabSize = options.tabSize ?? defaultTabSize;
    let expanded = expandJsonText(text, tabSize);

    // 若是对全文格式化且末尾无换行，追加换行符符合文件规范
    if (!isSelected && !expanded.endsWith('\n')) {
      expanded += '\n';
    }

    // 内容无变化时轻提示
    if (expanded === text) {
      showToast(`JSON 已经是展开状态（${scopeName}）`, 'info');
      return true;
    }

    // 替换编辑器内容
    view.dispatch({
      changes: { from, to, insert: expanded },
      selection: isSelected
        ? { anchor: from, head: from + expanded.length }
        : { anchor: Math.min(selection.anchor, expanded.length) },
      scrollIntoView: true,
    });
    view.focus();

    showToast(`✓ JSON 展开成功（${scopeName}，${tabSize}空格缩进）`, 'success');
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`JSON 展开失败（${scopeName}格式错误）: ${msg}`, 'error', 4500);
    return false;
  }
}
