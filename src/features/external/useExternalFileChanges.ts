// 已打开文档的应用级监听：覆盖独立打开、子目录文件、侧栏关闭和移动端。
import { useEffect } from 'react';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { dirnameOf, pathKey } from '../explorer/pathUtils';
import { scheduleDocumentRecheck, watchDirectory } from '../explorer/directoryWatcher';

/** 监听不可用或移动端休眠漏事件时，仅对活动文档进行低频兜底核对。 */
const FALLBACK_CHECK_MS = 15_000;

/**
 * 按已加载文档的父目录共享监听，关闭文档即释放引用；
 * 标签激活、窗口聚焦及页面恢复可见时补查，后台不轮询，也不递归扫描工作区。
 */
export function useExternalFileChanges(): void {
  useEffect(() => {
    const releases = new Map<string, () => void>();
    const loadedKeys = new Set<string>();
    let previousActiveKey: string | null = null;

    /** 只对有磁盘正文的文档建监听；未命名、懒加载及二进制查看器不走文本核对。 */
    const reconcile = () => {
      const { tabs, activeKey, isTransferring } = useWindowStore.getState();
      const directories = new Map<string, string>();
      const nextKeys = new Set<string>();
      for (const tab of tabs) {
        const doc = useDocumentStore.getState().getDocument(tab.key);
        if (!tab.path || tab.key.startsWith('untitled:') || tab.lazySource
          || !doc || doc.content === null || doc.kind === 'image' || isTransferring(tab.key)) continue;
        nextKeys.add(tab.key);
        const dir = dirnameOf(tab.path);
        if (dir) directories.set(pathKey(dir), dir);
        if (!loadedKeys.has(tab.key) || (tab.key === activeKey && activeKey !== previousActiveKey)) {
          scheduleDocumentRecheck(tab.key);
        }
      }
      previousActiveKey = activeKey;
      loadedKeys.clear();
      for (const key of nextKeys) loadedKeys.add(key);
      for (const [key, release] of releases) {
        if (!directories.has(key)) { release(); releases.delete(key); }
      }
      for (const [key, dir] of directories) {
        if (!releases.has(key)) releases.set(key, watchDirectory(dir));
      }
    };

    /** 恢复前台时复查所有已加载文档，补上后台或 WebView 休眠期间丢失的事件。 */
    const checkVisibleDocuments = () => {
      if (document.hidden) return;
      for (const key of loadedKeys) scheduleDocumentRecheck(key);
    };
    const unsubscribeTabs = useWindowStore.subscribe(reconcile);
    const unsubscribeDocuments = useDocumentStore.subscribe(reconcile);
    reconcile();
    window.addEventListener('focus', checkVisibleDocuments);
    document.addEventListener('visibilitychange', checkVisibleDocuments);
    const timer = window.setInterval(() => {
      const key = useWindowStore.getState().activeKey;
      if (!document.hidden && key && loadedKeys.has(key)) scheduleDocumentRecheck(key);
    }, FALLBACK_CHECK_MS);
    return () => {
      unsubscribeTabs();
      unsubscribeDocuments();
      window.removeEventListener('focus', checkVisibleDocuments);
      document.removeEventListener('visibilitychange', checkVisibleDocuments);
      window.clearInterval(timer);
      for (const release of releases.values()) release();
    };
  }, []);
}
