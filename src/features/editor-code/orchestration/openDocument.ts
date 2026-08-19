// NoteBoard 打开文档编排
// 读盘 → 建 Document → 建 Tab → 激活
// 详见 docs/09-开发路线图.md 4.13

import * as ipc from '../../../core/ipc/commands';
import { useDocumentStore } from '../../../stores/documentStore';
import { useWindowStore, type Tab } from '../../../stores/windowStore';
import { useExplorerStore, isSubPath } from '../../explorer/explorerStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { kindFromPath, languageFromPath } from '../../../core/docKind';
import { showToast } from '../../../stores/toastStore';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ── 打开文件 ──

export async function openDocument(path: string): Promise<void> {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dirPath =
    path.substring(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))) || path;
  const kind = kindFromPath(path);

  // 1. 先 probe，检查文件可读性与类型
  let isUnsupported = false;
  let fileSize = 0;
  try {
    const probe = await ipc.probeDocument(path);
    fileSize = probe.size;
    if (probe.size > 50 * 1024 * 1024) {
      console.warn('文件较大:', path);
    }
    if ((!probe.isText || probe.kind === 'unsupported') && kind !== 'image' && probe.kind !== 'image') {
      isUnsupported = true;
    }
  } catch {
    // probe 失败则继续尝试读取
  }

  // 1.1 若为图片文件，直接创建 image Tab 并激活图片查看器
  if (kind === 'image') {
    const docStore = useDocumentStore.getState();
    docStore.upsertFromPayload({
      key: path,
      displayName: fileName,
      dirPath,
      kind: 'image',
      language: 'plaintext',
      content: null,
      encoding: 'utf8',
      eol: 'lf',
      size: fileSize,
      mtime: 0,
      readonly: true,
    });

    const label = getCurrentWindow().label;
    try {
      const regResult = await ipc.registerDocument(label, path, 'image');
      if (regResult.type === 'already-open') {
        await ipc.focusWindow(regResult.ownerLabel);
        return;
      }
    } catch (e) {
      console.error('注册图片文档失败:', e);
    }

    const tabStore = useWindowStore.getState();
    const tab: Tab = {
      key: path,
      displayName: fileName,
      path,
      kind: 'image',
      language: 'plaintext',
      isDirty: false,
      isPreview: false,
      viewMode: null,
      externalStatus: null,
      isDetached: false,
    };
    tabStore.openTab(tab);

    if (dirPath) {
      useLayoutStore.getState().setExplorerVisible(true);
      try {
        const curRoot = useExplorerStore.getState().root;
        if (curRoot && isSubPath(curRoot, path)) {
          useExplorerStore.getState().setRevealed(path, true);
        } else {
          const nodes = await ipc.readDir(dirPath, false);
          useExplorerStore.getState().setRoot(dirPath, nodes);
          useExplorerStore.getState().setRevealed(path, true);
        }
      } catch (e) {
        console.error('加载父文件夹目录失败:', e);
      }
    }

    try {
      await ipc.pushRecent(path, false);
    } catch {
      // 非关键路径
    }
    return;
  }

  // 1.2 若为不适配/非文本文件，建立 unsupported Tab 并在主区域和悬浮层提示
  if (isUnsupported) {
    showToast(`文件格式不受支持: ${fileName}，无法直接编辑`, 'warning');

    // 建 Document 记录元信息
    const docStore = useDocumentStore.getState();
    docStore.upsertFromPayload({
      key: path,
      displayName: fileName,
      dirPath,
      kind: 'unsupported',
      language: 'plaintext',
      content: null,
      encoding: 'utf8',
      eol: 'lf',
      size: fileSize,
      mtime: 0,
      readonly: true,
    });

    // 建 Tab 并激活
    const tabStore = useWindowStore.getState();
    const tab: Tab = {
      key: path,
      displayName: fileName,
      path,
      kind: 'unsupported',
      language: 'plaintext',
      isDirty: false,
      isPreview: false,
      viewMode: null,
      externalStatus: null,
      isDetached: false,
    };
    tabStore.openTab(tab);

    // 确保左侧栏展开并展示父文件夹目录
    if (dirPath) {
      useLayoutStore.getState().setExplorerVisible(true);
      try {
        const curRoot = useExplorerStore.getState().root;
        if (curRoot && isSubPath(curRoot, path)) {
          useExplorerStore.getState().setRevealed(path, true);
        } else {
          const nodes = await ipc.readDir(dirPath, false);
          useExplorerStore.getState().setRoot(dirPath, nodes);
          useExplorerStore.getState().setRevealed(path, true);
        }
      } catch (e) {
        console.error('加载父文件夹目录失败:', e);
      }
    }
    return;
  }

  // 2. 读盘
  let payload;
  try {
    payload = await ipc.readDocument(path);
  } catch (e) {
    console.error('打开文件失败:', e);
    showToast(`无法打开文件: ${fileName}`, 'error');
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

  // 6. 确保左侧栏展开并展示父文件夹目录
  if (payload.dirPath && payload.key) {
    useLayoutStore.getState().setExplorerVisible(true);
    try {
      const curRoot = useExplorerStore.getState().root;
      if (curRoot && isSubPath(curRoot, payload.key)) {
        useExplorerStore.getState().setRevealed(payload.key, true);
      } else {
        const nodes = await ipc.readDir(payload.dirPath, false);
        useExplorerStore.getState().setRoot(payload.dirPath, nodes);
        useExplorerStore.getState().setRevealed(payload.key, true);
      }
    } catch (e) {
      console.error('加载父文件夹目录失败:', e);
    }
  }

  // 7. 推送到最近打开
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
