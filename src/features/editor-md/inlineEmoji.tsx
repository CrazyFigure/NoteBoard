// NoteBoard 正文表情：插入与渲染
// 表情库与高亮块「表情」页共用（calloutPickers 中的 Noto Emoji），但写入 Markdown 的是标准 Unicode 字符：
//   - 文件内容：`今天上线了 🎉`，任何编辑器 / 平台都能识别，不引入任何非标准语法；
//   - 可视化显示：用行内装饰把表情库内的字符换成同款 Noto SVG（字符本身保留，光标、复制、保存均不受影响），
//     保证各系统下观感与选择面板一致；表情库以外的表情、代码内的表情维持系统字体原样显示。

import type { Editor, Range } from '@tiptap/core';
import { Extension, getChangedRanges } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Tooltip } from '../../components/Tooltip';
import { CALLOUT_EMOJI_GROUPS, CalloutIconGlyph, type CalloutEmojiDef } from './calloutPickers';

// 变体选择符 U+FE0F：同一表情带或不带都应识别（如 ❤ 与 ❤️）
const VARIATION_SELECTOR = /️/g;

/** 全部可插入的表情（按面板分组顺序） */
export const INLINE_EMOJIS: CalloutEmojiDef[] = CALLOUT_EMOJI_GROUPS.flatMap((group) => group.icons);

// 以去掉变体选择符后的字符为键，查找对应的 SVG
const EMOJI_BY_BASE = new Map(INLINE_EMOJIS.map((emoji) => [emoji.char.replace(VARIATION_SELECTOR, ''), emoji] as const));

// 匹配表情库内的字符：长序列优先（😮‍💨 先于 😮）；
// 前后不能紧邻零宽连接符，后面不能紧跟肤色修饰符，避免把组合表情（如 ❤️‍🔥、👍🏽）拆开渲染；
// 后瞻中的 FE0F 用于阻止回溯：❤️‍🔥 中带变体的 ❤️ 被拒后，不能退而只匹配不带变体的 ❤
const EMOJI_PATTERN = new RegExp(
  `(?<!\\u200D)(?:${[...EMOJI_BY_BASE.keys()]
    .sort((a, b) => b.length - a.length)
    .map((base) => `${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\uFE0F?`)
    .join('|')})(?![\\u200D\\uFE0F\\u{1F3FB}-\\u{1F3FF}])`,
  'gu',
);

export const inlineEmojiKey = new PluginKey<DecorationSet>('nbInlineEmoji');

/** 扫描单个文本块，为其中的表情生成装饰；代码块与行内代码保持原样 */
function collectTextblock(node: ProseMirrorNode, pos: number, decorations: Decoration[]) {
  if (node.type.spec.code) return;
  node.forEach((child, offset) => {
    if (!child.isText || !child.text || child.marks.some((mark) => mark.type.spec.code)) return;
    for (const match of child.text.matchAll(EMOJI_PATTERN)) {
      const emoji = EMOJI_BY_BASE.get(match[0].replace(VARIATION_SELECTOR, ''));
      if (!emoji) continue;
      const from = pos + 1 + offset + (match.index ?? 0);
      decorations.push(
        Decoration.inline(from, from + match[0].length, {
          class: 'nb-inline-emoji',
          style: `background-image: url("${emoji.src}")`,
        }),
      );
    }
  });
}

/** 扫描 [from, to] 涉及的全部文本块 */
function collectRange(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    collectTextblock(node, pos, decorations);
    return false;
  });
  return decorations;
}

/** 正文表情装饰插件：只重扫发生变化的文本块，大文档输入时不做全量扫描 */
export function createInlineEmojiPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: inlineEmojiKey,
    state: {
      init: (_, state) => DecorationSet.create(state.doc, collectRange(state.doc, 0, state.doc.content.size)),
      apply(tr, set) {
        if (!tr.docChanged) return set;
        let next = set.map(tr.mapping, tr.doc);
        const size = tr.doc.content.size;
        for (const { newRange } of getChangedRanges(tr)) {
          // 向两侧各扩 1，确保删除、合并段落等落在块边界的改动也能覆盖到相邻文本块
          const from = Math.max(0, newRange.from - 1);
          const to = Math.min(size, newRange.to + 1);
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isTextblock) return true;
            const end = pos + node.nodeSize;
            next = next.remove(next.find(pos, end));
            const decorations: Decoration[] = [];
            collectTextblock(node, pos, decorations);
            if (decorations.length) next = next.add(tr.doc, decorations);
            return false;
          });
        }
        return next;
      },
    },
    props: {
      decorations: (state) => inlineEmojiKey.getState(state),
    },
  });
}

/** 正文表情渲染扩展 */
export const InlineEmojiRender = Extension.create({
  name: 'inlineEmojiRender',
  addProseMirrorPlugins() {
    return [createInlineEmojiPlugin()];
  },
});

/** 在可视化编辑器光标处插入表情字符；传入 range 时先删除该范围（斜杠命令的触发文本） */
export function insertInlineEmoji(editor: Editor, char: string, range?: Range): void {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  chain.insertContent(char).run();
}

/** 表情选择网格：按分组展示，点击即插入；用于工具栏「插入」与右键菜单的二级面板 */
export function InlineEmojiGrid({ onSelect }: { onSelect: (char: string) => void }) {
  return (
    // 阻止 mousedown 默认行为：点选表情时不让编辑器失焦，插入位置保持在原光标处
    <div className="nb-inline-emoji-panel" onMouseDown={(event) => event.preventDefault()}>
      {CALLOUT_EMOJI_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="nb-callout-popover-title">{group.label}</div>
          <div className="nb-callout-icon-grid nb-inline-emoji-grid" role="listbox" aria-label={group.label}>
            {group.icons.map((item) => (
              <Tooltip key={item.id} content={item.label} side="top" sideOffset={4}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-label={item.label}
                  className="nb-callout-icon-cell"
                  onClick={(event) => {
                    // 不冒泡到外层菜单项：工具栏子菜单的父项点击会切换子菜单开合
                    event.stopPropagation();
                    onSelect(item.char);
                  }}
                >
                  <CalloutIconGlyph id={item.id} size={18} />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
