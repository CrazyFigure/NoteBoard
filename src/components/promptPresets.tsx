// NoteBoard 常用输入弹窗预设
// 工具栏、斜杠菜单、右键菜单、气泡菜单与多维表格共用，保证同类操作的文案与交互一致

import { Image as ImageIcon, Link2 } from 'lucide-react';
import { showPrompt } from '../stores/promptDialogStore';

/** 询问网络图片地址，附带实时预览；取消返回 null */
export const promptImageUrl = () =>
  showPrompt({
    title: '插入网络图片',
    description: '粘贴图片的在线地址，确认前可在下方预览效果',
    icon: <ImageIcon size={17} />,
    placeholder: 'https://example.com/image.png',
    confirmLabel: '插入',
    previewImage: true,
  });

/**
 * 询问超链接地址
 * @param previous 已有链接地址；存在时为编辑模式，允许留空提交以移除链接
 * @returns 确认值（编辑模式下可能为空字符串，表示移除）；取消返回 null
 */
export const promptLinkUrl = (previous?: string) => {
  const editing = Boolean(previous);
  return showPrompt({
    title: editing ? '编辑超链接' : '插入超链接',
    description: editing ? '支持网页链接或文档相对路径，留空并确认即可移除链接' : '支持网页链接或文档相对路径',
    icon: <Link2 size={17} />,
    defaultValue: previous,
    placeholder: 'https://... 或 ./doc.md',
    confirmLabel: editing ? '保存' : '插入',
    allowEmpty: editing,
  });
};
