// NoteBoard 打开文档编排（S07：统一文件准备）
// prepare_document 一次往返完成：归属查询提前（已打开/在途在读盘前返回，不重复读盘、
// 不覆盖脏内容）→ 在途去重 → blocking 读取判别；目录展开与最近记录在建 Tab 后延后执行。
// 详见 docs/09-开发路线图.md 4.13 与启动性能计划 §G

import * as ipc from '../../../core/ipc/commands';
import { useDocumentStore } from '../../../stores/documentStore';
import { useWindowStore, type Tab } from '../../../stores/windowStore';
import { useExplorerStore, isSubPath } from '../../explorer/explorerStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { kindFromPath, languageFromPath } from '../../../core/docKind';
import { prefetchEditor, resolveEditorKind } from '../../editor-host/editorLoaders';
import { showToast } from '../../../stores/toastStore';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ── 打开文件 ──

/** 打开结果（S04：映射到打开队列 ACK 的 OpenOutcome） */
export type OpenDocumentResult = 'opened' | 'focused' | 'failed';

/**
 * 目录展开任务（G 节：目录及最近记录在可编辑后有序执行，不阻塞打开链路返回）。
 * 带发起时的活动标签与资源管理器根校验：用户已切换目录/标签时放弃旧结果，
 * 不覆盖用户新切换的目录。
 */
function scheduleExplorerFollowUp(targetKey: string, dirPath: string): void {
  void (async () => {
    const activeKeyAtStart = useWindowStore.getState().activeKey;
    const rootAtStart = useExplorerStore.getState().root;
    useLayoutStore.getState().setExplorerVisible(true);
    try {
      const curRoot = useExplorerStore.getState().root;
      // 同根目录已加载：仅定位目标文件
      if (curRoot && isSubPath(curRoot, targetKey)) {
        useExplorerStore.getState().setRevealed(targetKey, true);
        return;
      }
      const nodes = await ipc.readDir(dirPath, false);
      // 🔴 竞态校验：读取期间用户切换了活动标签或目录根则放弃旧结果
      const now = useWindowStore.getState().activeKey;
      const nowRoot = useExplorerStore.getState().root;
      if (now !== activeKeyAtStart || nowRoot !== rootAtStart) return;
      useExplorerStore.getState().setRoot(dirPath, nodes);
      useExplorerStore.getState().setRevealed(targetKey, true);
    } catch (e) {
      console.error('加载父文件夹目录失败:', e);
    }
  })();
}

/** 最近记录更新延后执行（失败静默，不阻塞打开链路） */
function scheduleRecentRecord(path: string, isDir: boolean): void {
  void ipc.pushRecent(path, isDir).catch(() => {
    // 非关键路径
  });
}

/** 按 Tab 信息构造（kind/language 已知时直接使用） */
function buildTab(key: string, displayName: string, kind: Tab['kind'], language: string, viewMode: Tab['viewMode'] = null): Tab {
  return {
    key,
    displayName,
    path: key,
    kind,
    language,
    isDirty: false,
    isPreview: false,
    viewMode,
    externalStatus: null,
    isDetached: false,
  };
}

/** 打开文档（对外入口；already-open 重试经 openDocumentInternal 受限递归） */
export async function openDocument(path: string): Promise<OpenDocumentResult> {
  return openDocumentInternal(path, 0);
}

async function openDocumentInternal(path: string, retryDepth: number): Promise<OpenDocumentResult> {
  if (retryDepth > 2) {
    showToast('该文件当前处于打开状态，请稍后重试', 'warning');
    return 'failed';
  }
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const kind = kindFromPath(path);
  const label = getCurrentWindow().label;

  // 0. 🔴 S05：路径解析出类型后立即预取唯一目标编辑器入口，与读盘并行
  {
    const loaderKind = resolveEditorKind({ kind, language: languageFromPath(path) });
    if (loaderKind !== 'unsupported') prefetchEditor(loaderKind);
  }

  // 1. 🔴 S07：统一文件准备（归属查询在读盘前；已打开/在途直接返回）
  let prepared: Awaited<ReturnType<typeof ipc.prepareDocument>>;
  try {
    prepared = await ipc.prepareDocument(label, path);
  } catch (e) {
    console.error('文件准备失败:', e);
    showToast(`无法打开文件: ${fileName}`, 'error');
    return 'failed';
  }

  // 2. 分派判别结果
  switch (prepared.type) {
    case 'already-open': {
      // 已打开（本窗口/在途或其他窗口）：只激活或聚焦，不重复读盘、不覆盖脏内容
      if (prepared.ownerIsSelf) {
        useWindowStore.getState().activateTab(prepared.key);
        // 🔴 R04：归属仍在但标签已不存在（刚关闭且注销 IPC 在途 / 首请求尚未建标签）——
        //    小重试等待归属注销或标签建立，最后重新走完整打开链
        if (!useWindowStore.getState().getTab(prepared.key)) {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            const tabNow = useWindowStore.getState().getTab(prepared.key);
            if (tabNow) {
              useWindowStore.getState().activateTab(prepared.key);
              return 'focused';
            }
          }
          // 归属可能已被注销完成 → 重新尝试完整打开（受限递归）
          return openDocumentInternal(path, retryDepth + 1);
        }
      } else {
        try {
          await ipc.focusWindow(prepared.ownerLabel);
        } catch (e) {
          console.error('聚焦已打开窗口失败:', e);
        }
      }
      return 'focused';
    }

    case 'directory': {
      // 拖入/打开的是文件夹：资源管理器定位到该目录（延后执行，不阻塞返回）
      useLayoutStore.getState().setExplorerVisible(true);
      void (async () => {
        const activeKeyAtStart = useWindowStore.getState().activeKey;
        try {
          const nodes = await ipc.readDir(prepared.path, false);
          if (useWindowStore.getState().activeKey !== activeKeyAtStart) return;
          useExplorerStore.getState().setRoot(prepared.path, nodes);
        } catch (e) {
          console.error('加载文件夹目录失败:', e);
        }
      })();
      scheduleRecentRecord(prepared.path, true);
      return 'opened';
    }

    case 'image': {
      const docStore = useDocumentStore.getState();
      docStore.upsertFromPayload({
        key: prepared.key,
        displayName: prepared.displayName,
        dirPath: prepared.dirPath,
        kind: 'image',
        language: 'plaintext',
        content: null,
        encoding: 'utf8',
        eol: 'lf',
        size: prepared.size,
        mtime: prepared.mtime,
        readonly: true,
      });
      try {
        const regResult = await ipc.registerDocument(label, prepared.key, 'image');
        if (regResult.type === 'already-open') {
          // 并发窗口竞争注册：聚焦已有所有者，本窗口不建 Tab
          if (regResult.ownerLabel !== label) {
            await ipc.focusWindow(regResult.ownerLabel);
            return 'focused';
          }
          useWindowStore.getState().activateTab(prepared.key);
          return 'focused';
        }
      } catch (e) {
        console.error('注册图片文档失败:', e);
      }
      useWindowStore.getState().openTab(buildTab(prepared.key, prepared.displayName, 'image', 'plaintext'));
      if (prepared.dirPath) scheduleExplorerFollowUp(prepared.key, prepared.dirPath);
      scheduleRecentRecord(path, false);
      return 'opened';
    }

    case 'unsupported': {
      showToast(`文件格式不受支持: ${prepared.displayName}，无法直接编辑`, 'warning');
      useDocumentStore.getState().upsertFromPayload({
        key: prepared.key,
        displayName: prepared.displayName,
        dirPath: prepared.dirPath,
        kind: 'unsupported',
        language: 'plaintext',
        content: null,
        encoding: 'utf8',
        eol: 'lf',
        size: prepared.size,
        mtime: 0,
        readonly: true,
      });
      useWindowStore.getState().openTab(buildTab(prepared.key, prepared.displayName, 'unsupported', 'plaintext'));
      if (prepared.dirPath) scheduleExplorerFollowUp(prepared.key, prepared.dirPath);
      return 'opened';
    }

    case 'failed': {
      console.error('打开文件失败:', prepared.message);
      showToast(`无法打开文件: ${fileName}`, 'error');
      return 'failed';
    }

    case 'text': {
      const payload = prepared.payload;
      // 注册文档（跨窗口并发竞争由 register 的 already-open 兜底）
      try {
        const regResult = await ipc.registerDocument(label, payload.key, payload.kind);
        if (regResult.type === 'already-open') {
          if (regResult.ownerLabel !== label) {
            await ipc.focusWindow(regResult.ownerLabel);
          } else {
            useWindowStore.getState().activateTab(payload.key);
          }
          return 'focused';
        }
      } catch (e) {
        console.error('注册文档失败:', e);
      }

      // 建 Document 与 Tab 并激活（关键路径：到此即可编辑）
      useDocumentStore.getState().upsertFromPayload(payload);
      useWindowStore.getState().openTab(buildTab(payload.key, payload.displayName, payload.kind, payload.language));

      // 目录展开与最近记录延后（不阻塞打开链路返回，不阻塞队列下一条）
      if (payload.dirPath && payload.key) {
        scheduleExplorerFollowUp(payload.key, payload.dirPath);
      }
      scheduleRecentRecord(path, false);
      return 'opened';
    }
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
