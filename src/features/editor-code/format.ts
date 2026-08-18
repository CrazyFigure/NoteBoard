// NoteBoard CM6 格式化（JSON / XML）
// Shift+Alt+F 触发
// 详见 docs/09-开发路线图.md 4.9

import type { LanguageId } from '../../core/ipc/types';

// ── JSON 格式化 ──

export function formatJson(source: string): string {
  const parsed = JSON.parse(source);
  return JSON.stringify(parsed, null, 2) + '\n';
}

// ── XML 格式化 ──

export function formatXml(source: string): string {
  // 简单 XML 格式化
  let formatted = '';
  let indent = 0;
  const tab = '  ';

  // 去除已有换行和缩进
  const cleaned = source.replace(/>\s+</g, '><').trim();

  // 按标签拆分
  const parts = cleaned.split(/(<[^>]+>)/g).filter(Boolean);

  for (const part of parts) {
    if (part.startsWith('</')) {
      indent = Math.max(0, indent - 1);
      formatted += tab.repeat(indent) + part + '\n';
    } else if (part.startsWith('<') && !part.startsWith('<?') && !part.endsWith('/>')) {
      // 开始标签
      formatted += tab.repeat(indent) + part + '\n';
      indent++;
    } else if (part.startsWith('<')) {
      // 自闭合或处理指令
      formatted += tab.repeat(indent) + part + '\n';
    } else {
      // 文本内容
      const trimmed = part.trim();
      if (trimmed) {
        formatted += tab.repeat(indent) + trimmed + '\n';
      }
    }
  }

  return formatted.trim() + '\n';
}

// ── 按语言获取格式化函数 ──

export function getFormatter(lang: LanguageId): ((source: string) => string) | null {
  switch (lang) {
    case 'json':
      return formatJson;
    case 'xml':
      return formatXml;
    default:
      return null;
  }
}
