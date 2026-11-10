// 纯文本复制直接读取选区节点：去掉排版语法，保留正文中的字面符号和原子节点可提供的文字。
import type { Editor } from '@tiptap/core';
import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { parseWikiLinkInner, wikiLinkLabel } from '../wikilink/wikiLinkSyntax';
import { getMarkdownManager } from './serialize';

/** HTML 只提取静态文字；不挂载到页面，不执行脚本，并保留段落、换行和图片说明。 */
function htmlPlainText(raw: string): string {
  const fragment = document.createElement('template');
  fragment.innerHTML = raw;
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return Array.from(node.childNodes).map(read).join('');
    if (node.matches('script, style, template, [hidden]')) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return node.getAttribute('alt') || node.getAttribute('title') || node.getAttribute('src') || '';
    const text = Array.from(node.childNodes).map(read).join('');
    if (node.matches('td, th')) return `${text}\t`;
    return node.matches('p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre') && !text.endsWith('\n') ? `${text}\n` : text;
  };
  return read(fragment.content).replace(/\t\n/g, '\n').replace(/\n$/, '');
}

/** 只序列化真实选区；单元格按 TSV 排列，空选区不隐式复制整篇文档。 */
export function serializeSelectionPlainText(editor: Editor): string {
  const { selection } = editor.state;
  if (selection.empty) return '';

  // 切片保留祖先容器，开放边界内的折叠标题不属于所选正文，不能额外带入。
  const readFragment = (content: Fragment, separator: string, openStart = 0): string => {
    const parts: string[] = [];
    content.forEach((node, _offset, index) => {
      // 编辑器自动追加的输入占位段不属于正文；保留用户自己输入的空白段落。
      if (node.attrs.sourceTrailingPlaceholder && node.content.size === 0) return;
      parts.push(readNode(node, index === 0 ? openStart : 0));
    });
    return parts.join(separator);
  };
  const readNode = (node: ProseMirrorNode, openStart: number): string => {
    if (node.isText) return node.text ?? '';
    const name = node.type.name;
    const attrs = node.attrs;
    // 属性型节点没有 textContent，需要逐类提取可读内容，避免静默丢失。
    if (name === 'hardBreak') return '\n';
    if (name === 'wikiLink') return wikiLinkLabel(parseWikiLinkInner(String(attrs.inner ?? '')));
    if (name === 'image' || name === 'imageBlock') return String(attrs.alt || attrs.title || attrs.src || '');
    if (name === 'mathInline' || name === 'mathBlock') return String(attrs.latex ?? '');
    if (['mermaidBlock', 'plantumlBlock', 'infographicBlock'].includes(name)) return String(attrs.code ?? '');
    if (name === 'rawHtmlBlock' || name === 'rawHtmlInline') return htmlPlainText(String(attrs.raw ?? ''));
    if (name === 'footnoteReference') return String(attrs.id ?? '');
    if (name === 'frontMatter') return String(attrs.raw ?? '').replace(/^---\r?\n/, '').replace(/\r?\n---\s*$/, '');
    if (name === 'footnoteDefinition') {
      // 定义正文仍可能带强调、链接或代码；交给现有解析器剥离格式，字面内容不会被正则误删。
      const body = String(attrs.raw ?? '').replace(/^\[\^[^\]]+\]:[ \t]*/, '').replace(/\n {4}/g, '\n');
      const parsed = getMarkdownManager(editor)?.parse?.(body);
      return parsed ? readFragment(editor.schema.nodeFromJSON(parsed).content, '\n\n') : body;
    }
    const childOpen = Math.max(0, openStart - 1);
    const role = node.type.spec.tableRole;
    if (role === 'row') return readFragment(node.content, '\t', childOpen);
    if (role === 'table') return readFragment(node.content, '\n', childOpen);
    if (role === 'cell' || role === 'header_cell') {
      // 格内换行和制表符归一为空格，保证复制到电子表格时不会错列。
      return readFragment(node.content, ' ', childOpen).replace(/[\t\r\n]+/g, ' ');
    }
    const separator = node.inlineContent ? '' : ['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'].includes(name) ? '\n' : '\n\n';
    const text = readFragment(node.content, separator, childOpen);
    return name === 'detailsBlock' && openStart === 0
      ? [String(attrs.summary ?? ''), text].filter(Boolean).join('\n\n')
      : text;
  };

  const slice = selection.content();
  // CellSelection 的顶层直接是行，单行与多行选区都不补表头或分隔线。
  const role = slice.content.firstChild?.type.spec.tableRole;
  return readFragment(slice.content, role === 'row' ? '\n' : role === 'cell' || role === 'header_cell' ? '\t' : '\n\n', slice.openStart);
}
