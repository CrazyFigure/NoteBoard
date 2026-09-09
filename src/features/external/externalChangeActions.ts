// NoteBoard 🔴 R3-10 外部修改冲突处理编排
//
// ExternalChangeBanner 的“重新加载 / 覆盖磁盘文件”此前只 setExternalStatus(clean)——
// 既不读盘也不写盘，旧正文保留、自动保存保护解除（反例：用户处理链断开）。
// 本模块提供真正的处理链：
//   重新加载 = 确认磁盘内容 → 应用到内核/store（含历史基线重置）→ 解除冲突；
//   覆盖 = 受保护保存（flush 权威内容 → 写队列落盘 → 基线对齐）→ 解除冲突；
//   失败 = 保持冲突状态（不解除保护），可重试。

import * as ipc from '../../core/ipc/commands';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { getEditorCapabilities } from '../../core/editor/editorRegistry';
import { serializeMarkdown, getBaseline } from '../editor-md/serialize';
import {
  initializeDocumentHistory,
  synchronizeCurrentDocumentHistoryContent,
} from '../history/documentHistory';
import { showToast } from '../../stores/toastStore';
import { flushPendingSourceSnapshot, flushPendingVisualSnapshot } from '../editor-md/visualSnapshot';

/**
 * 🔴 R3-10：重新加载——确认并应用磁盘内容到当前会话。
 * 读盘成功：正文进 store、内核经能力 flush 语义对齐（无实例则只改镜像——挂载时
 * 以 store 内容重建）、基线重置为磁盘内容、历史首节点同步、解除冲突；
 * 读盘失败（外部删除/权限）：保持冲突状态，提示可重试。
 */
export async function reloadFromDisk(docKey: string): Promise<boolean> {
  try {
    const payload = await ipc.readDocument(docKey);
    const store = useDocumentStore.getState();
    const doc = store.getDocument(docKey);
    if (!doc) return false;
    // 先物化 J2 暂存（未物化输入不落历史孤儿）
    flushPendingSourceSnapshot(docKey);
    flushPendingVisualSnapshot(docKey);
    // 应用磁盘内容：store 镜像 + 基线 + 历史（DocumentPayload.content 类型含 null——
    // 读盘成功路径必为字符串；null 视为失败保持冲突状态）
    const diskContent = payload.content;
    if (diskContent == null) {
      showToast('读取到的文件内容为空引用，冲突状态保留', 'error');
      return false;
    }
    store.setContent(docKey, diskContent);
    store.updateBaseline(docKey, diskContent, payload.mtime, payload.size);
    getBaseline(docKey).updateBaseline(diskContent);
    store.setDirty(docKey, false);
    useWindowStore.getState().setTabDirty(docKey, false);
    // 内核对齐：无实例（后台/未挂载）时挂载以 store 重建；有实例时经能力 flush
    // 的镜像屏障之后，模式切换/挂载流程应用新内容；统一历史以新内容为首节点基准
    const capabilities = getEditorCapabilities(docKey);
    if (!capabilities) {
      initializeDocumentHistory(docKey, diskContent, 'code');
    } else {
      // 有实例时以当前模式对齐（内核经挂载/模式切换应用 store 内容）
      const mode = useWindowStore.getState().getTab(docKey)?.viewMode === 'source' ? 'source' : 'visual';
      synchronizeCurrentDocumentHistoryContent(docKey, diskContent, mode);
    }
    // 解除冲突（文档与标签双侧）
    store.setExternalStatus(docKey, 'clean');
    useWindowStore.getState().setTabExternalStatus(docKey, 'clean');
    showToast('已从磁盘重新加载', 'success');
    return true;
  } catch (e) {
    console.error('重新加载失败:', e);
    showToast('重新加载失败（文件可能已被删除或无法访问），冲突状态保留', 'error');
    return false;
  }
}

/**
 * 🔴 R3-10：覆盖磁盘文件——受保护保存当前权威内容。
 * flush 权威内容（编辑器内核/J2 暂存/镜像逐级回退）→ 每文档写队列落盘 →
 * 基线对齐 → 解除冲突。写盘失败：保持冲突状态（不解除自动保存保护），可重试。
 */
export async function overwriteFromEditor(docKey: string): Promise<boolean> {
  const store = useDocumentStore.getState();
  const doc = store.getDocument(docKey);
  if (!doc) return false;
  // 权威内容：能力 flush（含 J2 暂存物化）→ 镜像
  const capabilities = getEditorCapabilities(docKey);
  let content: string | null = null;
  if (capabilities) {
    const captured = await capabilities.flush('save');
    content = captured?.content ?? null;
  }
  if (content === null) {
    flushPendingSourceSnapshot(docKey);
    content = flushPendingVisualSnapshot(docKey)
      ?? store.getDocument(docKey)?.content
      ?? null;
  }
  if (content === null) {
    showToast('无法获取文档正文，覆盖已取消（冲突状态保留）', 'warning');
    return false;
  }

  try {
    // 受保护保存：写队列内落盘（基线更新为实际写入内容）
    const result = await ipc.writeDocument(docKey, content, doc.encoding, doc.eol);
    if (!result.ok) {
      showToast('覆盖磁盘失败，冲突状态保留，可重试', 'error');
      return false;
    }
    store.updateBaseline(docKey, content, result.mtime, result.size);
    getBaseline(docKey).updateBaseline(content);
    store.setDirty(docKey, false);
    useWindowStore.getState().setTabDirty(docKey, false);
    // 解除冲突（文档与标签双侧）
    store.setExternalStatus(docKey, 'clean');
    useWindowStore.getState().setTabExternalStatus(docKey, 'clean');
    showToast('已用当前内容覆盖磁盘文件', 'success');
    return true;
  } catch (e) {
    console.error('覆盖磁盘失败:', e);
    showToast('覆盖磁盘失败，冲突状态保留，可重试', 'error');
    return false;
  }
}

// 供测试断言/后续“覆盖所有可写类型入口”扩展引用（serializeMarkdown 保持模块边界内可用）
void serializeMarkdown;
