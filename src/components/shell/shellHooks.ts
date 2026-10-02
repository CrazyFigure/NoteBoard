// NoteBoard 外壳共享逻辑
// 桌面 AppShell 与移动端 MobileShell 共用：Markdown 内核登记（大纲数据源）、关闭拦截处理、
// 会话恢复标签的按需加载。逻辑自 AppShell 原样抽出，行为保持不变。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { saveDocument, takeLastSaveIdentityMove } from '../../features/editor-code/orchestration/saveDocument';
import { performWindowClose } from '../../features/window/windowManager';
import { discardStagedDocuments, stashPendingDocuments } from '../../features/staging/stagingManager';
import { showToast } from '../../stores/toastStore';
import { hasUnsavedWork } from '../../features/staging/stagingPolicy';
import { saveCurrentWindowSnapshot, loadRestoredTab } from '../../features/session/closedWindowSession';

/**
 * Markdown 内核登记：所有保活 Markdown 内核使用稳定回调登记实例。切换标签时直接按 activeKey 取实例，
 * 避免旧标签 effect 的迟到 null 覆盖新标签 editor，导致大纲绑定错误或反复重挂监听。
 */
export function useMarkdownEditorRegistry(tabs: Tab[], activeKey: string | null) {
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const markdownEditorsRef = useRef(new Map<string, Editor>());
  const markdownEditorReadyHandlersRef = useRef(new Map<string, (editor: Editor | null) => void>());

  /** 为每个 Markdown 标签返回身份稳定的内核就绪回调，并维护活动大纲的唯一 editor。 */
  const getMarkdownEditorReadyHandler = useCallback((docKey: string) => {
    const existing = markdownEditorReadyHandlersRef.current.get(docKey);
    if (existing) return existing;

    const handler = (editor: Editor | null) => {
      if (editor) {
        markdownEditorsRef.current.set(docKey, editor);
      } else {
        markdownEditorsRef.current.delete(docKey);
      }
      if (useWindowStore.getState().activeKey === docKey) {
        setActiveEditor((current) => current === editor ? current : editor);
      }
    };
    markdownEditorReadyHandlersRef.current.set(docKey, handler);
    return handler;
  }, []);

  // 标签激活变化只切换大纲的数据源，不修改或重建任何 Markdown 编辑器内核。
  useEffect(() => {
    const nextEditor = activeKey ? markdownEditorsRef.current.get(activeKey) ?? null : null;
    setActiveEditor((current) => current === nextEditor ? current : nextEditor);
  }, [activeKey]);

  // 标签真正关闭后释放回调与实例引用，保活期间则维持身份稳定。
  useEffect(() => {
    const openKeys = new Set(tabs.map((tab) => tab.key));
    for (const key of markdownEditorReadyHandlersRef.current.keys()) {
      if (!openKeys.has(key)) {
        markdownEditorReadyHandlersRef.current.delete(key);
        markdownEditorsRef.current.delete(key);
      }
    }
  }, [tabs]);

  return { activeEditor, getMarkdownEditorReadyHandler };
}

/** 统一关闭拦截状态与操作（保存并关闭 / 不保存 / 暂存 / 取消） */
export function useCloseGuardHandlers(tabs: Tab[]) {
  const pendingCloseKeys = useWindowStore((s) => s.pendingCloseKeys);
  const confirmCloseBatch = useWindowStore((s) => s.confirmCloseBatch);
  const clearPendingClose = useWindowStore((s) => s.clearPendingClose);

  // 待关闭列表中处于脏态的标签页列表
  const dirtyPendingTabs = useMemo(() => {
    if (pendingCloseKeys.length === 0) return [];
    return tabs.filter((tab) => pendingCloseKeys.includes(tab.key) && hasUnsavedWork(tab.key));
  }, [pendingCloseKeys, tabs]);

  // 保存并关闭
  const handleSaveAndClose = async (keys: string[]) => {
    // 🔴 N03：另存为会迁移文档身份——逐个保存后用实际新 key 检查脏态与关闭，
    //    不能继续按原 key 断言（原 key 的标签/文档已随迁移移除）
    const closeKeys: string[] = [];
    for (const key of keys) {
      const ok = await saveDocument(key);
      if (!ok) {
        // 用户在另存为对话框中取消了保存，中断关闭流程
        return;
      }
      const move = takeLastSaveIdentityMove();
      const effectiveKey = move?.from === key ? move.to : key;
      // 🔴 R12：保存期间又产生新编辑（flush-and-compare 后仍脏）→ 不静默关闭
      if (hasUnsavedWork(effectiveKey)) {
        showToast('保存期间有新的修改，请再次保存后关闭', 'warning');
        return;
      }
      closeKeys.push(effectiveKey);
    }
    const targetKeys = closeKeys;
    const willCloseWindow = useWindowStore.getState().isWindowClosing;
    if (willCloseWindow) {
      // 窗口级关闭必须在技术性移除标签前记录，否则会把仍打开的标签误判成已独立关闭。
      try {
        await saveCurrentWindowSnapshot();
      } catch (error) {
        console.error('保存最近文件快照失败:', error);
        showToast('最近文件记录失败，但文件已经保存', 'warning');
      }
      await performWindowClose(getCurrentWindow().label, true);
    } else {
      confirmCloseBatch(targetKeys);
    }
  };

  // 丢弃修改并关闭
  const handleDiscardAndClose = async (keys: string[]) => {
    const targetKeys = [...useWindowStore.getState().pendingCloseKeys];
    const willCloseWindow = useWindowStore.getState().isWindowClosing;
    // “不保存”保持彻底丢弃语义，清理由自动关闭保护产生的副本。
    await discardStagedDocuments(keys);
    if (willCloseWindow) {
      try {
        // 明确丢弃的标签不进入最近文件，其余仍打开标签继续记录。
        await saveCurrentWindowSnapshot(keys);
      } catch (error) {
        console.error('保存最近文件快照失败:', error);
        showToast('最近文件记录失败，但仍会按“不保存”关闭', 'warning');
      }
      await performWindowClose(getCurrentWindow().label, true);
    } else {
      confirmCloseBatch(targetKeys);
    }
  };

  // 暂存：确认所有目标文档已写入用户设置的位置后才真正移除标签/关闭窗口。
  const handleStashAndClose = async (keys: string[]) => {
    try {
      await stashPendingDocuments({ keys, retain: true });
    } catch (error) {
      showToast(`暂存失败，窗口尚未关闭：${error instanceof Error ? error.message : String(error)}`, 'error', 5000);
      return;
    }
    const targetKeys = [...useWindowStore.getState().pendingCloseKeys];
    const willCloseWindow = useWindowStore.getState().isWindowClosing;
    if (willCloseWindow) {
      try {
        await saveCurrentWindowSnapshot();
      } catch (error) {
        console.error('保存最近文件快照失败:', error);
        showToast('最近文件记录失败，但暂存文件已经保留', 'warning');
      }
      await performWindowClose(getCurrentWindow().label, true);
    } else {
      confirmCloseBatch(targetKeys);
    }
  };

  // 取消关闭
  const handleCancelClose = () => {
    clearPendingClose();
  };

  return {
    dirtyPendingTabs,
    handleSaveAndClose,
    handleDiscardAndClose,
    handleStashAndClose,
    handleCancelClose,
  };
}

/** 🔴 S10：激活会话恢复的轻量标签时按需加载正文（读盘/注册/编辑器加载） */
export function useRestoredTabLoader(activeKey: string | null): void {
  // 已加载正文的标签直接保持挂载；恢复描述符仍在首次激活后才加载正文与内核。
  useEffect(() => {
    if (!activeKey) return;
    const tab = useWindowStore.getState().getTab(activeKey);
    if (tab?.lazySource) {
      void loadRestoredTab(activeKey).catch((e) => {
        console.error('恢复标签加载失败:', e);
      });
    }
  }, [activeKey]);
}
