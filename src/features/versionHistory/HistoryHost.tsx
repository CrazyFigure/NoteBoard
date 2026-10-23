// NoteBoard 文档历史记录：查看界面挂载点
// 只订阅开关状态；查看界面与各格式查看器在第一次打开时才加载，不进入首屏

import { lazy, Suspense } from 'react';
import { useVersionHistoryStore } from './versionHistoryStore';

const HistoryView = lazy(() => import('./HistoryView'));

export function HistoryHost() {
  const open = useVersionHistoryStore((s) => s.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <HistoryView />
    </Suspense>
  );
}
