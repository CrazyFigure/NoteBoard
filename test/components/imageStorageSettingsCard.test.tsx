// 图片目录设置卡片：统一目录随时可选、位置更改与迁移、同步 / 备份开启时必须位于同步文件夹内（路径按 Windows 语义）
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../../src/core/platform', async (original) => ({
  ...await original<typeof import('../../src/core/platform')>(),
  get USES_WINDOWS_PATHS() { return platform.windows; },
}));

// 文件夹选择框返回值由各用例指定
const dialog = vi.hoisted(() => ({ selected: null as string | null, calls: 0 }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => { dialog.calls += 1; return dialog.selected; }),
}));

// 已存在的目录（用于判断原统一目录是否需要迁移）
const disk = vi.hoisted(() => ({ dirs: new Set<string>() }));
vi.mock('../../src/core/ipc/commands', async (original) => ({
  ...await original<typeof import('../../src/core/ipc/commands')>(),
  saveSettings: vi.fn(async () => undefined),
  revealInExplorer: vi.fn(async () => undefined),
  pathExists: vi.fn(async (path: string) => ({ exists: disk.dirs.has(path.toLowerCase()), isDir: true })),
}));

// 迁移对话框本身另有测试，这里只校验打开时传入的参数
vi.mock('../../src/features/editor-md/ImageMigrationDialog', () => ({
  ImageMigrationDialog: ({ options }: { options: unknown }) => <div data-testid="migration">{JSON.stringify(options)}</div>,
}));

import { ImageDirOutsideSyncNotice, ImageStorageSettingsCard } from '../../src/components/settings/ImageStorageSettingsCard';
import { TooltipProvider } from '../../src/components/Tooltip';
import type { FileSettings, SyncConfigFile } from '../../src/core/ipc/types';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../src/stores/settingsStore';
import { useSyncStore } from '../../src/stores/syncStore';
import { useExplorerStore } from '../../src/features/explorer/explorerStore';

/** 只包含卡片读取的同步字段 */
function syncConfig(rootDir: string, enabled: boolean, autoEnabled: boolean): SyncConfigFile {
  return { sync: { rootDir, enabled }, backup: { autoEnabled } } as unknown as SyncConfigFile;
}

function setup(file: Partial<FileSettings>, config: SyncConfigFile | null, explorerRoot: string | null) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, file: { ...DEFAULT_SETTINGS.file, ...file } } });
  useSyncStore.setState({ config, initialized: true });
  useExplorerStore.setState({ root: explorerRoot });
}

const fileSettings = () => useSettingsStore.getState().settings.file;

let host: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
}

/** 点击包含指定文字的按钮并等待异步处理完成 */
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === text || el.textContent?.includes(text));
  if (!button) throw new Error(`找不到按钮：${text}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function migrationOptions() {
  const el = host.querySelector('[data-testid="migration"]');
  return el ? JSON.parse(el.textContent ?? '{}') : null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dialog.selected = null;
  dialog.calls = 0;
  disk.dirs.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('统一目录随时可选', () => {
  it('未设置同步文件夹时统一目录可选，默认放在当前打开的文件夹', async () => {
    setup({ imageStorageMode: 'sibling', imageGlobalRoot: '' }, syncConfig('', false, false), 'C:\\Work');
    render(<ImageStorageSettingsCard />);
    const globalOption = [...host.querySelectorAll<HTMLButtonElement>('.nb-image-mode-option')].find((el) => el.textContent?.includes('统一目录'))!;
    expect(globalOption.disabled).toBe(false);
    await click('统一目录');
    expect(fileSettings()).toMatchObject({ imageStorageMode: 'global', imageGlobalRoot: 'C:\\Work' });
    expect(host.textContent).toContain('图片存入：C:\\Work\\img');
  });

  it('既无同步文件夹也未打开文件夹时，切换后弹出文件夹选择', async () => {
    setup({ imageStorageMode: 'sibling', imageGlobalRoot: '' }, null, null);
    dialog.selected = 'D:\\Pics';
    render(<ImageStorageSettingsCard />);
    await click('统一目录');
    expect(dialog.calls).toBe(1);
    expect(fileSettings()).toMatchObject({ imageStorageMode: 'global', imageGlobalRoot: 'D:\\Pics' });
  });

  it('「整理现有图片」按钮不带省略号', () => {
    setup({ imageStorageMode: 'global', imageGlobalRoot: '' }, syncConfig('C:\\Notes', false, false), null);
    render(<ImageStorageSettingsCard />);
    const labels = [...host.querySelectorAll('button')].map((el) => el.textContent?.trim());
    expect(labels).toContain('整理现有图片');
    expect(labels.some((label) => label?.includes('…'))).toBe(false);
  });
});

describe('更换统一目录位置', () => {
  it('原统一目录已存在时打开迁移预览，旧目录作为来源', async () => {
    setup({ imageStorageMode: 'global', imageGlobalRoot: 'C:\\Work' }, syncConfig('', false, false), 'C:\\Work');
    disk.dirs.add('c:\\work\\img');
    dialog.selected = 'D:\\Pics';
    render(<ImageStorageSettingsCard />);
    await click('选择文件夹');
    expect(fileSettings().imageGlobalRoot).toBe('D:\\Pics');
    expect(migrationOptions()).toMatchObject({
      direction: 'toGlobal',
      scanRoots: ['C:\\Work'],
      globalDir: 'D:\\Pics\\img',
      legacyGlobalDirs: ['C:\\Work\\img'],
    });
  });

  it('原统一目录不存在时只更改位置，不打开迁移', async () => {
    setup({ imageStorageMode: 'global', imageGlobalRoot: 'C:\\Work' }, syncConfig('', false, false), 'C:\\Work');
    dialog.selected = 'D:\\Pics';
    render(<ImageStorageSettingsCard />);
    await click('选择文件夹');
    expect(fileSettings().imageGlobalRoot).toBe('D:\\Pics');
    expect(migrationOptions()).toBeNull();
  });

  it('同步 / 备份未开启时可以选同步文件夹外的位置', async () => {
    setup({ imageStorageMode: 'global', imageGlobalRoot: '' }, syncConfig('C:\\Notes', false, false), null);
    dialog.selected = 'D:\\Pics';
    render(<ImageStorageSettingsCard />);
    await click('选择文件夹');
    expect(fileSettings().imageGlobalRoot).toBe('D:\\Pics');
    expect(host.querySelector('.nb-image-mode-warning')).toBeNull();
  });

  it('同步 / 备份开启时拒绝同步文件夹外的位置', async () => {
    setup({ imageStorageMode: 'global', imageGlobalRoot: '' }, syncConfig('C:\\Notes', true, false), null);
    dialog.selected = 'D:\\Pics';
    render(<ImageStorageSettingsCard />);
    await click('选择文件夹');
    expect(fileSettings().imageGlobalRoot).toBe('');
  });
});

describe('同步 / 备份开启而统一目录在同步文件夹外', () => {
  const outside = () => setup({ imageStorageMode: 'global', imageGlobalRoot: 'D:\\Pics' }, syncConfig('C:\\Notes', false, true), 'C:\\Notes');

  it('卡片提示原因与实际存放位置，一键迁移到同步文件夹', async () => {
    outside();
    disk.dirs.add('d:\\pics\\img');
    render(<ImageStorageSettingsCard />);
    const warning = host.querySelector('.nb-image-mode-warning')?.textContent ?? '';
    expect(warning).toContain('已开启自动备份');
    expect(warning).toContain('D:\\Pics\\img');
    expect(warning).toContain('C:\\Notes\\img');
    expect(host.textContent).toContain('图片存入：C:\\Notes\\img');

    await click('迁移到同步文件夹');
    expect(fileSettings().imageGlobalRoot).toBe('');
    expect(migrationOptions()).toMatchObject({
      direction: 'toGlobal',
      scanRoots: ['C:\\Notes'],
      globalDir: 'C:\\Notes\\img',
      legacyGlobalDirs: ['D:\\Pics\\img'],
    });
    expect(host.querySelector('.nb-image-mode-warning')).toBeNull();
  });

  it('「同步与备份」页同样显示提示并可迁移', async () => {
    outside();
    disk.dirs.add('d:\\pics\\img');
    render(<ImageDirOutsideSyncNotice />);
    expect(host.textContent).toContain('统一目录需要位于同步文件夹内');
    await click('迁移到同步文件夹');
    expect(fileSettings().imageGlobalRoot).toBe('');
    expect(migrationOptions()).toMatchObject({ globalDir: 'C:\\Notes\\img', legacyGlobalDirs: ['D:\\Pics\\img'] });
  });

  it('整理现有图片时把原位置的图片一并迁入', async () => {
    outside();
    render(<ImageStorageSettingsCard />);
    await click('整理现有图片');
    expect(migrationOptions()).toMatchObject({ direction: 'toGlobal', globalDir: 'C:\\Notes\\img', legacyGlobalDirs: ['D:\\Pics\\img'] });
  });

  it('同级模式或统一目录已在同步文件夹内时不提示', () => {
    setup({ imageStorageMode: 'sibling', imageGlobalRoot: 'D:\\Pics' }, syncConfig('C:\\Notes', true, true), null);
    render(<ImageDirOutsideSyncNotice />);
    expect(host.textContent).toBe('');
    // 已挂载组件订阅了 Store，修改状态需包在 act 中
    act(() => setup({ imageStorageMode: 'global', imageGlobalRoot: 'C:\\Notes\\res' }, syncConfig('C:\\Notes', true, true), null));
    render(<ImageDirOutsideSyncNotice />);
    expect(host.textContent).toBe('');
  });
});
