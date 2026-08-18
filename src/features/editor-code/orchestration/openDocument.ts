// NoteBoard 打开文档编排
// 读盘 → 建 Document → 建 Tab → 激活
// 详见 docs/09-开发路线图.md 4.13

import * as ipc from '../../../core/ipc/commands';
import { useDocumentStore } from '../../../stores/documentStore';
import { useWindowStore, type Tab } from '../../../stores/windowStore';
import { kindFromPath, languageFromPath, savePolicyOf } from '../../../core/docKind';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ── 打开文件 ──

export async function openDocument(path: string): Promise<void> {
  // 1. 先 probe，检查大文件
  try {
    const probe = await ipc.probeDocument(path);
    if (probe.size > 50 * 1024 * 1024) {
      // 阶段11会加确认框
      console.warn('文件较大，但当前阶段暂不拦截:', path);
    }
    if (!probe.isText) {
      // 阶段13会显示 unsupported 信息页
      console.warn('非文本文件:', path);
      return;
    }
  } catch {
    // probe 失败则继续尝试读取
  }

  // 2. 读盘
  let payload;
  try {
    payload = await ipc.readDocument(path);
  } catch (e) {
    console.error('打开文件失败:', e);
    return;
  }

  // 3. 注册文档
  const label = getCurrentWindow().label;
  try {
    const regResult = await ipc.registerDocument(label, payload.key, payload.kind);
    if (regResult.type === 'already-open') {
      // 已在其他窗口打开，聚焦
      await ipc.focusWindow(regResult.ownerLabel);
      return;
    }
  } catch (e) {
    console.error('注册文档失败:', e);
  }

  // 4. 建 Document
  const docStore = useDocumentStore.getState();
  docStore.upsertFromPayload(payload);

  // 5. 建 Tab 并激活
  const tabStore = useWindowStore.getState();
  const tab: Tab = {
    key: payload.key,
    displayName: payload.displayName,
    path: payload.key,
    kind: payload.kind,
    language: payload.language,
    isDirty: false,
    isPreview: false,
    viewMode: null,
    externalStatus: null,
    isDetached: false,
  };
  tabStore.openTab(tab);

  // 6. 推送到最近打开
  try {
    await ipc.pushRecent(path, false);
  } catch {
    // 非关键路径
  }
}

// ── 从路径构建 Tab（不实际打开，用于会话恢复）──

export function buildTabFromPath(path: string): Tab {
  const kind = kindFromPath(path);
  const language = languageFromPath(path);
  const name = path.split(/[\\/]/).pop() ?? path;

  return {
    key: path,
    displayName: name,
    path,
    kind,
    language,
    isDirty: false,
    isPreview: false,
    viewMode: null,
    externalStatus: null,
    isDetached: false,
  };
}
