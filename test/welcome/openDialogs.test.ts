// 回归 Linux 路径输入选择器的入口分流，以及选中/取消后的原有打开行为。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: 'linux',
  open: vi.fn(),
  openLinuxPathDialog: vi.fn(),
  openDocument: vi.fn(),
  readDir: vi.fn(),
  pushRecent: vi.fn(),
}));

vi.mock('@/core/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/platform')>(),
  get TARGET_PLATFORM() { return mocks.platform; },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@/core/ipc/commands', () => ({
  openLinuxPathDialog: mocks.openLinuxPathDialog,
  readDir: mocks.readDir,
  pushRecent: mocks.pushRecent,
}));
vi.mock('@/features/editor-code/orchestration/openDocument', () => ({ openDocument: mocks.openDocument }));

import { openFileDialog, openFolderDialog } from '@/features/welcome/welcomeActions';
import { useExplorerStore } from '@/features/explorer/explorerStore';
import { useLayoutStore } from '@/stores/layoutStore';

describe('打开文件/文件夹的系统选择器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform = 'linux';
    mocks.readDir.mockResolvedValue([]);
    mocks.pushRecent.mockResolvedValue(undefined);
    mocks.openDocument.mockResolvedValue(undefined);
    useExplorerStore.getState().clear();
  });

  it('Linux 打开文件使用带路径输入框的选择器，并依次打开多选文件', async () => {
    const paths = ['/home/user/笔记/第一篇.md', '/home/user/笔记/第二篇.md'];
    mocks.openLinuxPathDialog.mockResolvedValueOnce(paths);

    await openFileDialog();

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openLinuxPathDialog).toHaveBeenCalledWith(false, expect.arrayContaining([
      { name: '全部文件', extensions: ['*'] },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
    ]));
    expect(mocks.openDocument).toHaveBeenNthCalledWith(1, paths[0]);
    expect(mocks.openDocument).toHaveBeenNthCalledWith(2, paths[1]);
  });

  it('Linux 取消文件或文件夹选择时不打开文件、不替换资源管理器根目录', async () => {
    mocks.openLinuxPathDialog.mockResolvedValue(null);

    await openFileDialog();
    await openFolderDialog();

    expect(mocks.openDocument).not.toHaveBeenCalled();
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.pushRecent).not.toHaveBeenCalled();
    expect(useExplorerStore.getState().root).toBeNull();
  });

  it('Linux 选择文件夹后展开侧栏、加载目录并记入最近打开', async () => {
    const folder = '/home/user/我的 笔记';
    mocks.openLinuxPathDialog.mockResolvedValueOnce([folder]);
    useLayoutStore.getState().setExplorerVisible(false);

    await openFolderDialog();

    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.openLinuxPathDialog).toHaveBeenCalledWith(true);
    expect(mocks.readDir).toHaveBeenCalledWith(folder, false);
    expect(useExplorerStore.getState().root).toBe(folder);
    expect(useLayoutStore.getState().explorerVisible).toBe(true);
    expect(mocks.pushRecent).toHaveBeenCalledWith(folder, true);
  });

  it.each(['windows', 'macos'])('%s 继续使用原系统选择器及其多选/单目录选项', async (platform) => {
    mocks.platform = platform;
    mocks.open.mockResolvedValueOnce(['/notes/a.md']).mockResolvedValueOnce('/notes');

    await openFileDialog();
    await openFolderDialog();

    expect(mocks.openLinuxPathDialog).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenNthCalledWith(1, expect.objectContaining({ multiple: true }));
    expect(mocks.open).toHaveBeenNthCalledWith(2, { directory: true, multiple: false });
    expect(mocks.openDocument).toHaveBeenCalledWith('/notes/a.md');
    expect(mocks.readDir).toHaveBeenCalledWith('/notes', false);
  });

  it('Linux 选择器失败时保留错误，不继续执行打开操作', async () => {
    mocks.openLinuxPathDialog.mockRejectedValueOnce(new Error('无法访问窗口'));

    await expect(openFileDialog()).rejects.toThrow('无法访问窗口');

    expect(mocks.openDocument).not.toHaveBeenCalled();
  });
});
