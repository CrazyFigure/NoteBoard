// 桌面标签手势交给系统原生拖放；窗口内落点与跨窗口插入共用标签锚点。
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../../core/ipc/commands';
import { useWindowStore } from '../../stores/windowStore';
import { showToast } from '../../stores/toastStore';
import { moveTabToWindow } from './windowManager';
import { nativeTabInsertionAnchor } from './tabDropTarget';
import { setNativeTabDragInfo } from './tabDragFeedback';

/** 生成跟随指针的轻量标签预览，不截取或暴露文档正文。 */
function createDragPreview(label: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 276;
  canvas.height = 58;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法生成标签预览');
  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue('--editor-surface').trim() || '#f8fafc';
  ctx.shadowColor = 'rgba(15, 23, 42, 0.24)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  // 较旧的 macOS/WebKitGTK 还没有 roundRect，预览回退为矩形也应能正常拖放。
  if (typeof ctx.roundRect === 'function') ctx.roundRect(8, 5, 260, 44, 8);
  else ctx.rect(8, 5, 260, 44);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = style.getPropertyValue('--tab-border').trim() || '#94a3b8';
  ctx.stroke();
  ctx.fillStyle = style.getPropertyValue('--accent-strong').trim() || '#3b82f6';
  ctx.font = '20px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('▤', 20, 26);
  ctx.fillStyle = style.getPropertyValue('--editor-text').trim() || '#0f172a';
  ctx.font = '13px sans-serif';
  ctx.textBaseline = 'middle';
  // 长文件名截断预览，不改变实际标签宽度与名称。
  let title = label;
  while (title.length > 1 && ctx.measureText(title).width > 208) title = title.slice(0, -1);
  ctx.fillText(title === label ? title : `${title}…`, 48, 20);
  ctx.fillStyle = style.getPropertyValue('--editor-text-secondary').trim() || '#64748b';
  ctx.font = '10px sans-serif';
  ctx.fillText('拖入窗口合并，拖出拆分', 48, 37);
  return canvas.toDataURL('image/png');
}

/** 原生拖放结束后执行排序或迁移；Escape 和启动失败都不移动源标签。 */
export async function dragTab(key: string): Promise<void> {
  const store = useWindowStore.getState();
  const tab = store.getTab(key);
  if (!tab || store.isTransferring(key) || store.isWindowClosing || store.pendingCloseKeys.length) return;
  try {
    setNativeTabDragInfo({ sourceLabel: getCurrentWindow().label, key, displayName: tab.displayName });
    const result = await ipc.startTabDrag(key, createDragPreview(tab.displayName), tab.displayName);
    setNativeTabDragInfo(null);
    if (result.cancelled || !useWindowStore.getState().getTab(key)) return;
    if (result.target?.label === getCurrentWindow().label) {
      // 同窗排序无需迁移或重建编辑器；以去掉自身后的锚点计算最终顺序。
      const current = useWindowStore.getState();
      const from = current.tabs.findIndex((item) => item.key === key);
      const remaining = current.tabs.filter((item) => item.key !== key);
      const before = nativeTabInsertionAnchor(result.target, key);
      const index = remaining.findIndex((item) => item.key === before);
      current.reorderTabs(from, index < 0 ? remaining.length : index);
      return;
    }
    await moveTabToWindow(key, {
      targetLabel: result.target?.label,
      beforeKey: result.target?.beforeKey,
      position: result.target ? null : result.position,
      dropPosition: result.target ? { x: result.target.x, y: result.target.y } : undefined,
    });
  } catch (error) {
    console.error('标签拖放失败:', error);
    showToast('标签移动失败，内容已保留在原窗口', 'error');
  } finally {
    setNativeTabDragInfo(null);
  }
}
