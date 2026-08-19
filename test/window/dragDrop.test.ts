// NoteBoard 文件拖拽（Drag & Drop）单元测试
// 测试文件拖拽悬停状态管理与拖拽文件/文件夹在新 Tab 中打开的编排逻辑

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLayoutStore } from '../../src/stores/layoutStore';
import { useWindowStore } from '../../src/stores/windowStore';
import { useDocumentStore } from '../../src/stores/documentStore';
import { useExplorerStore } from '../../src/features/explorer/explorerStore';
import { openDocument } from '../../src/features/editor-code/orchestration/openDocument';
import * as ipc from '../../src/core/ipc/commands';

// Mock ipc 接口
vi.mock('../../src/core/ipc/commands', () => ({
  probeDocument: vi.fn(),
  readDocument: vi.fn(),
  registerDocument: vi.fn(),
  readDir: vi.fn(),
  pushRecent: vi.fn(),
  revealInExplorer: vi.fn(),
  openWithDefaultApp: vi.fn(),
}));

// Mock @tauri-apps/api/window
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'nb-main' }),
}));

describe('文件拖拽（Drag & Drop）测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLayoutStore.setState({
      isDraggingFile: false,
      explorerVisible: false,
    });
    useWindowStore.setState({
      tabs: [],
      activeKey: null,
    });
    useDocumentStore.setState({
      documents: new Map(),
    });
    useExplorerStore.setState({
      root: null,
      expanded: new Map(),
      revealed: null,
    });
  });

  it('layoutStore 正确响应拖拽悬停与离开状态变更', () => {
    expect(useLayoutStore.getState().isDraggingFile).toBe(false);

    // 拖入窗口
    useLayoutStore.getState().setIsDraggingFile(true);
    expect(useLayoutStore.getState().isDraggingFile).toBe(true);

    // 移出窗口或完成 drop
    useLayoutStore.getState().setIsDraggingFile(false);
    expect(useLayoutStore.getState().isDraggingFile).toBe(false);
  });

  it('拖入支持的 Markdown 文件时在新 Tab 中打开并展开左侧目录', async () => {
    const mdPath = 'C:\\notes\\project\\readme.md';
    vi.mocked(ipc.probeDocument).mockResolvedValue({
      exists: true,
      isDir: false,
      isText: true,
      kind: 'markdown',
      size: 1024,
    });
    vi.mocked(ipc.readDocument).mockResolvedValue({
      key: mdPath,
      displayName: 'readme.md',
      dirPath: 'C:\\notes\\project',
      kind: 'markdown',
      language: 'markdown',
      content: '# Hello NoteBoard',
      encoding: 'utf8',
      eol: 'crlf',
      size: 1024,
      mtime: Date.now(),
      readonly: false,
    });
    vi.mocked(ipc.registerDocument).mockResolvedValue({
      type: 'ok',
    });
    vi.mocked(ipc.readDir).mockResolvedValue([
      {
        name: 'readme.md',
        path: mdPath,
        isDir: false,
        kind: 'markdown',
        size: 1024,
        mtime: 0,
        isHidden: false,
        isSymlink: false,
      },
    ]);

    await openDocument(mdPath);

    // 验证 Tab 是否正确开启并激活
    const tabs = useWindowStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].key).toBe(mdPath);
    expect(tabs[0].kind).toBe('markdown');
    expect(useWindowStore.getState().activeKey).toBe(mdPath);

    // 验证左侧资源管理器是否自动展开并加载父目录
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\notes\\project');
    expect(useExplorerStore.getState().revealed).toBe(mdPath);
  });

  it('拖入不受支持的二进制文件时创建 unsupported Tab 并定位左侧目录', async () => {
    const binPath = 'C:\\downloads\\archive.zip';
    vi.mocked(ipc.probeDocument).mockResolvedValue({
      exists: true,
      isDir: false,
      isText: false,
      kind: 'unsupported',
      size: 20480,
    });
    vi.mocked(ipc.readDir).mockResolvedValue([
      {
        name: 'archive.zip',
        path: binPath,
        isDir: false,
        kind: 'unsupported',
        size: 20480,
        mtime: 0,
        isHidden: false,
        isSymlink: false,
      },
    ]);

    await openDocument(binPath);

    // 验证 Tab 是否创建为 unsupported
    const tabs = useWindowStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].key).toBe(binPath);
    expect(tabs[0].kind).toBe('unsupported');
    expect(useWindowStore.getState().activeKey).toBe(binPath);

    // 验证左侧目录自动展开并定位
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(useExplorerStore.getState().root).toBe('C:\\downloads');
    expect(useExplorerStore.getState().revealed).toBe(binPath);
  });

  it('拖入文件夹时直接设置为资源管理器根目录并展开左侧栏', async () => {
    const dirPath = 'C:\\workspace\\my-project';
    vi.mocked(ipc.probeDocument).mockResolvedValue({
      exists: true,
      isDir: true,
      isText: false,
      kind: 'unsupported',
      size: 0,
    });
    vi.mocked(ipc.readDir).mockResolvedValue([
      {
        name: 'main.md',
        path: 'C:\\workspace\\my-project\\main.md',
        isDir: false,
        kind: 'markdown',
        size: 100,
        mtime: 0,
        isHidden: false,
        isSymlink: false,
      },
    ]);

    await openDocument(dirPath);

    // 不创建文件 Tab
    expect(useWindowStore.getState().tabs.length).toBe(0);

    // 资源管理器以该目录为根并展开
    expect(useExplorerStore.getState().root).toBe(dirPath);
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
  });
});
