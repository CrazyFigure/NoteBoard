// 文件树单文件改名：先保全权威内容并排空写入，再迁移路径；后缀变化交给共用重载弹窗。
import * as ipc from '../../core/ipc/commands';
import { getEditorCapabilities } from '../../core/editor/editorRegistry';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { drainDocumentWrites, flushDocument, migrateDocumentSession, submitCapturedContent } from '../session/documentSession';
import { flushPendingSourceSnapshot, flushPendingVisualSnapshot } from '../editor-md/visualSnapshot';
import { getBaseline, removeBaseline } from '../editor-md/serialize';
import { moveDocumentHistory } from '../history/documentHistory';
import { dirnameOf, sameKey } from './pathUtils';

/** 使用平台路径身份寻找已打开会话，失败时保留原路径、正文和保存状态。 */
export async function renameOpenFile(oldPath: string, newPath: string, displayName: string): Promise<void> {
  const windows = useWindowStore.getState();
  const tab = windows.tabs.find((item) => sameKey(item.path, oldPath));
  const key = tab?.key ?? oldPath;
  windows.enterTransfer(key);
  try {
    // 改名会使旧编辑器卸载，必须在迁移 key 前物化尚未防抖落入镜像的输入。
    const capabilities = getEditorCapabilities(key);
    const captured = await flushDocument(key, 'transfer');
    if (capabilities && !captured) throw new Error('编辑器尚未就绪，请稍后重试重命名');
    if (captured && !submitCapturedContent(key, captured)) throw new Error('文档内容已变化，请重试重命名');
    flushPendingSourceSnapshot(key);
    flushPendingVisualSnapshot(key);
    await drainDocumentWrites(key);
    await ipc.renamePath(oldPath, newPath);
    const baseline = useDocumentStore.getState().getDocument(key)?.baselineContent;
    // 先作废旧任务，再提交路径；文档订阅会同时回收旧路径的会话代际记录。
    if (useDocumentStore.getState().hasDocument(key)) {
      migrateDocumentSession(key, newPath);
      moveDocumentHistory(key, newPath);
    }
    useDocumentStore.getState().renameDocument(key, newPath, displayName, dirnameOf(newPath));
    if (key !== newPath) removeBaseline(key);
    if (baseline != null) getBaseline(newPath).updateBaseline(baseline);
    windows.updateTabPath(key, newPath, displayName);
    const status = useDocumentStore.getState().getDocument(newPath)?.externalStatus;
    if (status) windows.setTabExternalStatus(newPath, status);
    const renamedDoc = useDocumentStore.getState().getDocument(newPath);
    if (renamedDoc) windows.setTabDirty(newPath, renamedDoc.isDirty);
    // 非活动标签改后缀也立即提示，避免直到切回标签时才发现仍在用旧编辑器。
    if (tab && status === 'renamed') windows.activateTab(newPath);
  } finally {
    windows.exitTransfer(key);
  }
}
