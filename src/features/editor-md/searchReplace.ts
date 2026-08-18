// NoteBoard 查找/替换扩展
// 基于 @sereneinserenade/tiptap-search-and-replace
// 详见 docs/09-开发路线图.md 7.13
//
// 提供 Ctrl+F 打开搜索，Ctrl+H 替换
// 注册到 extensions/index.ts

import SearchAndReplace from '@sereneinserenade/tiptap-search-and-replace';
import { registerShortcut } from '../../core/shortcuts';

/** 搜索替换扩展配置 */
export function searchReplaceExtension() {
  return SearchAndReplace.configure({
    // 结果样式
    searchResultClass: 'nb-search-result',
    // 正则模式默认关闭
    disableRegex: true,
  });
}

/** 注册搜索替换快捷键 */
export function registerSearchShortcuts(getEditor: () => { commands: { openSearchPanel?: () => void } } | null): () => void {
  const unregs: (() => void)[] = [];

  unregs.push(
    registerShortcut({
      key: 'Ctrl+F',
      action: () => {
        const editor = getEditor();
        editor?.commands.openSearchPanel?.();
      },
      scope: 'editor',
      description: '查找',
    }),
  );

  unregs.push(
    registerShortcut({
      key: 'Ctrl+H',
      action: () => {
        const editor = getEditor();
        editor?.commands.openSearchPanel?.();
      },
      scope: 'editor',
      description: '替换',
    }),
  );

  return () => unregs.forEach((u) => u());
}
