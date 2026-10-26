// NoteBoard 双链弹窗宿主
// 只订阅弹窗 Store；弹窗本体（含笔记搜索）不进入启动包，启动后空闲时预加载，首次打开无需等待下载解析。

import { lazy, Suspense, useEffect } from 'react';
import { useWikiLinkDialogStore } from './wikiLinkDialogStore';

const loadDialog = () => import('./WikiLinkDialog');

const WikiLinkDialogPortal = lazy(() => loadDialog().then((module) => ({ default: module.WikiLinkDialogPortal })));

/** 启动完成后多久预加载弹窗代码 */
const PRELOAD_DELAY_MS = 2000;

export function WikiLinkDialogHost() {
  const requestId = useWikiLinkDialogStore((state) => state.request?.id ?? null);

  // 空闲时预加载：避开启动关键路径，又让第一次点「插入双向链接」立即出现
  useEffect(() => {
    let idleHandle: number | null = null;
    const timer = window.setTimeout(() => {
      const preload = () => void loadDialog().catch(() => {});
      if (typeof window.requestIdleCallback === 'function') idleHandle = window.requestIdleCallback(preload, { timeout: 3000 });
      else preload();
    }, PRELOAD_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      if (idleHandle !== null && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleHandle);
    };
  }, []);

  if (requestId === null) return null;
  return (
    <Suspense fallback={null}>
      {/* 以请求 id 作为 key：每次打开都是全新实例，表单状态天然重置 */}
      <WikiLinkDialogPortal key={requestId} />
    </Suspense>
  );
}
