// NoteBoard 双链弹窗宿主
// 只订阅弹窗 Store；弹窗本体（含笔记搜索）在实际打开时装载，首页空闲时不抢占下载与求值。

import { lazy, Suspense } from 'react';
import { useWikiLinkDialogStore } from './wikiLinkDialogStore';

const loadDialog = () => import('./WikiLinkDialog');

const WikiLinkDialogPortal = lazy(() => loadDialog().then((module) => ({ default: module.WikiLinkDialogPortal })));

export function WikiLinkDialogHost() {
  const requestId = useWikiLinkDialogStore((state) => state.request?.id ?? null);

  if (requestId === null) return null;
  return (
    <Suspense fallback={null}>
      {/* 以请求 id 作为 key：每次打开都是全新实例，表单状态天然重置 */}
      <WikiLinkDialogPortal key={requestId} />
    </Suspense>
  );
}
