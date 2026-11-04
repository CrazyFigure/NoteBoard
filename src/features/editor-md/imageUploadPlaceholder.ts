// NoteBoard 图片插入占位
// 粘贴 / 拖入 / 选择本地图片后，保存到 img 目录需要一点时间。期间立即在插入位置显示这张图的
// 半透明预览与「正在插入图片」动画，让用户知道操作已被接收；保存完成后在同一位置替换为正式图片节点。
// 占位是装饰（不进入文档）：不会被自动保存写进 Markdown，也不会进入撤销历史；
// 位置随文档编辑自动映射，占位所在内容被删除时放弃插入。

import { Extension, type Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import '../../styles/imageUploadPlaceholder.css';

interface PlaceholderAction {
  add?: { id: object; pos: number; previewUrl: string | null };
  remove?: { id: object };
}

export const imageUploadPlaceholderKey = new PluginKey<DecorationSet>('nbImageUploadPlaceholder');

/** 预览图加载中的提示文案 */
const UPLOADING_TEXT = '正在插入图片…';

let widgetSeq = 0;

/** 占位 DOM：预览图（与最终图片同宽，替换时版面不跳动）+ 居中的加载徽标 */
function createWidget(previewUrl: string | null): HTMLElement {
  const root = document.createElement('span');
  root.className = 'nb-image-uploading';
  root.contentEditable = 'false';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-label', UPLOADING_TEXT);
  if (previewUrl) {
    const image = document.createElement('img');
    image.src = previewUrl;
    image.alt = '';
    image.draggable = false;
    root.append(image);
  }
  const badge = document.createElement('span');
  badge.className = 'nb-image-uploading-badge';
  const spinner = document.createElement('span');
  spinner.className = 'nb-image-uploading-spinner';
  const text = document.createElement('span');
  text.textContent = UPLOADING_TEXT;
  badge.append(spinner, text);
  root.append(badge);
  return root;
}

export const ImageUploadPlaceholder = Extension.create({
  name: 'imageUploadPlaceholder',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: imageUploadPlaceholderKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            // 占位随文档修改移动；所在内容被删除时装饰随之消失
            let next = set.map(tr.mapping, tr.doc);
            const action = tr.getMeta(imageUploadPlaceholderKey) as PlaceholderAction | undefined;
            if (action?.add) {
              const { id, pos, previewUrl } = action.add;
              const widget = Decoration.widget(pos, () => createWidget(previewUrl), {
                id,
                // 固定 key 让重绘时复用同一 DOM，预览图不会反复重新加载
                key: `nb-image-uploading-${++widgetSeq}`,
                side: -1,
              });
              next = next.add(tr.doc, [widget]);
            }
            if (action?.remove) {
              const removeId = action.remove.id;
              next = next.remove(next.find(undefined, undefined, (spec) => spec.id === removeId));
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

/**
 * 插入图片后把光标放到图片下方的段落（没有则新建一个），用户可直接继续输入。
 * 默认插入后图片处于整块选中状态，此时一打字就会把刚插入的图片替换掉。
 */
function placeCursorAfterImage(tr: Transaction): boolean {
  const { selection } = tr;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return true;
  const after = selection.to;
  const next = tr.doc.nodeAt(after);
  if (next?.isTextblock) {
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    return true;
  }
  const $after = tr.doc.resolve(after);
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (paragraph && $after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) {
    tr.insert(after, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  }
  return true;
}

/** 占位当前所在位置；已被删除返回 null */
function findPlaceholder(state: EditorState, id: object): number | null {
  const found = imageUploadPlaceholderKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id);
  return found && found.length > 0 ? found[0].from : null;
}

export interface ImageInsertion {
  /** 保存完成：在占位处插入图片并移除占位 */
  commit: (attrs: { src: string; alt?: string }) => void;
  /** 插入失败：移除占位 */
  cancel: () => void;
}

/**
 * 在当前选区开始一次图片插入：先删除选区内容（与直接插入图片一致），再放置占位。
 * 编辑器未装载占位扩展（例如其他自定义编辑器）时退化为保存完成后直接插入。
 * @param preview 用于预览的图片数据（粘贴的文件）或可直接加载的地址；为空时只显示加载徽标
 */
export function beginImageInsertion(editor: Editor, preview: Blob | string | null): ImageInsertion {
  const id = {};
  let previewUrl: string | null = null;
  let ownsPreviewUrl = false;
  if (typeof preview === 'string') {
    previewUrl = preview;
  } else if (preview && typeof URL.createObjectURL === 'function') {
    previewUrl = URL.createObjectURL(preview);
    ownsPreviewUrl = true;
  }

  const supported = !editor.isDestroyed && imageUploadPlaceholderKey.getState(editor.state) !== undefined;
  if (supported) {
    const tr = editor.state.tr.deleteSelection();
    tr.setMeta(imageUploadPlaceholderKey, { add: { id, pos: tr.selection.from, previewUrl } } satisfies PlaceholderAction);
    // 只放置占位时不进入撤销历史；删除了选中内容则是真实编辑，必须可撤销
    if (!tr.docChanged) tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
  }

  let settled = false;
  /** 释放预览地址：占位移除后不再需要 */
  const releasePreview = () => {
    if (ownsPreviewUrl && previewUrl) URL.revokeObjectURL(previewUrl);
  };

  return {
    commit(attrs) {
      if (settled || editor.isDestroyed) return;
      settled = true;
      if (!supported) {
        editor.chain().focus().setImage(attrs).run();
        releasePreview();
        return;
      }
      const pos = findPlaceholder(editor.state, id);
      // 光标仍停在占位处时插入后把光标移到图片之后；用户已去别处编辑则不打扰
      const { selection } = editor.state;
      const cursorAtPlaceholder = pos !== null && selection.empty && selection.from === pos;
      // 移除占位与插入图片在同一事务，画面不闪烁
      const chain = editor.chain().command(({ tr }) => {
        tr.setMeta(imageUploadPlaceholderKey, { remove: { id } } satisfies PlaceholderAction);
        return true;
      });
      // 占位所在内容已被删除时放弃插入
      if (pos !== null) {
        chain.insertContentAt(pos, { type: 'image', attrs }, { updateSelection: cursorAtPlaceholder });
        if (cursorAtPlaceholder) chain.command(({ tr }) => placeCursorAfterImage(tr)).scrollIntoView();
      }
      chain.run();
      releasePreview();
    },
    cancel() {
      if (settled) return;
      settled = true;
      if (supported && !editor.isDestroyed) {
        const tr = editor.state.tr.setMeta(imageUploadPlaceholderKey, { remove: { id } } satisfies PlaceholderAction);
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      }
      releasePreview();
    },
  };
}
