// NoteBoard 全屏关系图谱宿主
// 只订阅开关状态；图谱本体（布局与绘制）在实际打开时装载。

import { lazy, Suspense } from 'react';
import { useLinkGraphStore } from './linkGraphStore';

const LinkGraphOverlay = lazy(() => import('./LinkGraphOverlay').then((module) => ({ default: module.LinkGraphOverlay })));

export function LinkGraphHost() {
  const open = useLinkGraphStore((state) => state.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LinkGraphOverlay />
    </Suspense>
  );
}
