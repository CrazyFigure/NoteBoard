// 用不同构建目标验证路径身份和快捷键，不依赖测试机本身运行的 Windows。
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('网页保留 POSIX 大小写、面包屑和收藏身份', async () => {
  vi.stubGlobal('__NB_TARGET_PLATFORM__', 'web');
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.resetModules();
  const paths = await import('../../src/features/explorer/pathUtils');
  const { parsePathSegments } = await import('../../src/features/explorer/ExplorerBreadcrumb');
  const { findFavoriteByPath } = await import('../../src/features/favorites/favoritesUtils');
  expect(paths.joinPath('/workspace/Notes', 'A.md')).toBe('/workspace/Notes/A.md');
  expect(paths.sameKey('/workspace/A.md', '/workspace/a.md')).toBe(false);
  expect(parsePathSegments('/workspace/Notes').map((item) => item.fullPath)).toEqual(['/workspace', '/workspace/Notes']);
  expect(findFavoriteByPath([{ type: 'file', id: 'a', name: 'A', path: '/workspace/A.md', createdAt: 0 }], '/workspace/a.md')).toBeNull();
});

it('macOS 使用 Command 触发既有保存快捷键', async () => {
  // 使用 Tauri CLI 的真实 darwin 标记，避免测试只覆盖手工写入的 macos 别名。
  vi.stubGlobal('__NB_TARGET_PLATFORM__', 'darwin');
  vi.resetModules();
  const { registerShortcut, initShortcuts } = await import('../../src/core/shortcuts');
  const save = vi.fn();
  const unregister = registerShortcut({ key: 'Ctrl+S', scope: 'global', description: '保存', action: save });
  const stop = initShortcuts();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }));
  expect(save).toHaveBeenCalledOnce();
  stop(); unregister();
});
