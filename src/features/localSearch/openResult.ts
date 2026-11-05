// NoteBoard 本地文件搜索：打开搜索结果
// 文件在本软件中打开（不支持的格式由查看页提供系统打开入口）；内容结果打开后用查找栏定位命中文字。

import { openDocument } from '../editor-code/orchestration/openDocument';
import { openFolderInExplorer } from '../welcome/welcomeActions';
import { getEditorCapabilities } from '../../core/editor/editorRegistry';
import { useSearchStore } from '../../stores/searchStore';
import { useWindowStore } from '../../stores/windowStore';
import { pathKey } from '../explorer/pathUtils';
import * as ipc from '../../core/ipc/commands';
import { showToast } from '../../stores/toastStore';

/** 打开文件或文件夹；locateText 非空时在文档中定位该文字 */
export async function openSearchResult(path: string, isDir: boolean, locateText?: string): Promise<void> {
  if (isDir) {
    await openFolderInExplorer(path);
    return;
  }
  const result = await openDocument(path);
  if (result !== 'failed' && locateText?.trim()) {
    locateInDocument(path, locateText);
  }
}

/** 在系统文件管理器中显示 */
export function revealSearchResult(path: string): void {
  ipc.revealInExplorer(path).catch((error) => {
    showToast(`无法打开文件管理器：${error instanceof Error ? error.message : String(error)}`, 'error');
  });
}

/** 等待文档编辑器就绪后，打开查找栏并跳到第一处命中（最多等待约 5 秒） */
export function locateInDocument(path: string, text: string): void {
  const startedAt = Date.now();
  const attempt = () => {
    const win = useWindowStore.getState();
    const tab = win.tabs.find((t) => t.path && pathKey(t.path) === pathKey(path));
    if (tab) {
      // 只有文本类文档接入查找栏；画板、表格、Office 预览等不做定位
      if ((tab.kind !== 'code' && tab.kind !== 'markdown') || tab.toolKind) return;
      const search = getEditorCapabilities(tab.key)?.search;
      if (search && win.activeKey === tab.key) {
        const store = useSearchStore.getState();
        // 命中文字取自原文，按普通文字查找（关闭正则与全字匹配，避免特殊字符失配）
        store.setIsRegex(false);
        store.setWholeWord(false);
        store.openSearch(text, 'search');
        const options = { searchText: text, replaceText: store.replaceText, caseSensitive: false, wholeWord: false, isRegex: false };
        requestAnimationFrame(() => {
          const stats = search.findFirst(options);
          useSearchStore.getState().setMatchStats(stats.matchIndex, stats.matchCount);
        });
        return;
      }
    }
    if (Date.now() - startedAt < 5000) window.setTimeout(attempt, 120);
  };
  window.setTimeout(attempt, 60);
}
