// NoteBoard CM6 lint（JSON / YAML / XML 语法错误诊断）
// 详见 docs/09-开发路线图.md 4.7

import { linter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { LanguageId } from '../../core/ipc/types';

// ── JSON lint ──

function lintJson(view: EditorView): Diagnostic[] {
  const doc = view.state.doc.toString();
  if (!doc.trim()) return [];

  const diagnostics: Diagnostic[] = [];

  try {
    JSON.parse(doc);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 尝试从错误消息提取位置
    const pos = extractPosition(msg, doc);
    diagnostics.push({
      from: pos,
      to: Math.min(pos + 1, doc.length),
      severity: 'error',
      message: msg,
    });
  }

  return diagnostics;
}

// ── YAML lint ──

function lintYaml(view: EditorView): Diagnostic[] {
  const doc = view.state.doc.toString();
  if (!doc.trim()) return [];

  const diagnostics: Diagnostic[] = [];

  // 简单 YAML 检查（不依赖 js-yaml，避免引入额外依赖）
  // 检查缩进一致性和 tab 混用
  const lines = doc.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('\t')) {
      const tabIdx = line.indexOf('\t');
      const offset = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0) + tabIdx;
      diagnostics.push({
        from: offset,
        to: offset + 1,
        severity: 'warning',
        message: 'YAML 不允许使用 Tab 缩进，请用空格',
      });
    }
  }

  return diagnostics;
}

// ── XML lint ──

function lintXml(view: EditorView): Diagnostic[] {
  const doc = view.state.doc.toString();
  if (!doc.trim()) return [];

  const diagnostics: Diagnostic[] = [];

  // 检查基本 XML 结构
  // 检查标签闭合
  const tagStack: { name: string; pos: number }[] = [];
  const tagRegex = /<\/?([\w.:-]+)(\s[^>]*)?\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(doc)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1];
    const isSelfClosing = fullMatch.endsWith('/>');
    const isClosing = fullMatch.startsWith('</');

    if (isSelfClosing) continue;

    if (isClosing) {
      const last = tagStack.pop();
      if (!last) {
        const pos = match.index;
        diagnostics.push({
          from: pos,
          to: pos + fullMatch.length,
          severity: 'error',
          message: `多余的闭合标签 </${tagName}>`,
        });
      } else if (last.name !== tagName) {
        const pos = match.index;
        diagnostics.push({
          from: pos,
          to: pos + fullMatch.length,
          severity: 'error',
          message: `标签不匹配：期望 </${last.name}>，实际 </${tagName}>`,
        });
      }
    } else {
      tagStack.push({ name: tagName, pos: match.index });
    }
  }

  // 未闭合的标签
  for (const unclosed of tagStack) {
    diagnostics.push({
      from: unclosed.pos,
      to: unclosed.pos + unclosed.name.length + 1,
      severity: 'error',
      message: `未闭合的标签 <${unclosed.name}>`,
    });
  }

  return diagnostics;
}

// ── 从 JSON.parse 错误消息提取位置 ──

function extractPosition(msg: string, doc: string): number {
  // V8 引擎 JSON.parse 错误格式：
  // "Unexpected token X in JSON at position N"
  // 或 "Expected property name or '}' in JSON at position N"
  const posMatch = msg.match(/position\s+(\d+)/i);
  if (posMatch) {
    const pos = parseInt(posMatch[1], 10);
    return Math.min(pos, doc.length);
  }
  // 尝试行列格式
  const lineMatch = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineMatch) {
    const line = parseInt(lineMatch[1], 10) - 1;
    const col = parseInt(lineMatch[2], 10) - 1;
    const lines = doc.split('\n');
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    return Math.min(offset + col, doc.length);
  }
  return 0;
}

// ── 按 LanguageId 获取 lint 扩展 ──

export function getLinterForLanguage(lang: LanguageId): Extension | null {
  switch (lang) {
    case 'json':
      return linter(lintJson, { delay: 500 });
    case 'yaml':
      return linter(lintYaml, { delay: 500 });
    case 'xml':
      return linter(lintXml, { delay: 500 });
    default:
      return null;
  }
}
