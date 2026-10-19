// 导图另存为不能把原生 JSON 写回 .xmind；文件对话框和写盘均使用内存替身。
import { beforeEach, expect, it, vi } from 'vitest';
import { save } from '@tauri-apps/plugin-dialog';
import * as ipc from '@/core/ipc/commands';
import { saveAs } from '@/features/editor-code/orchestration/saveDocument';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { resetEditorRegistryForTest } from '@/core/editor/editorRegistry';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({ setDocumentDirty: vi.fn(), registerDocument: vi.fn(), writeDocument: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  resetEditorRegistryForTest();
  useDocumentStore.setState({ documents: new Map() });
  useWindowStore.setState({ tabs: [], activeKey: null });
});

it('默认只提供原生扩展名，手输 .xmind 时在注册与写盘前中止', async () => {
  const key = 'untitled:mindmap:save-protection';
  const content = '{"version":1,"root":{"id":"r","text":"保留原文件","children":[]}}';
  useDocumentStore.getState().upsertFromPayload({ key, displayName: '测试.mindmap', dirPath: '', kind: 'mindmap', language: 'json', content,
    encoding: 'utf8', eol: 'lf', size: content.length, mtime: 0, readonly: false });
  vi.mocked(save).mockResolvedValue('C:/test/original.XMIND');
  expect(await saveAs(key, content)).toBe(false);
  const options = vi.mocked(save).mock.calls[0][0];
  expect(options?.filters?.flatMap((filter) => filter.extensions)).toEqual(['mindmap', '*']);
  expect(ipc.registerDocument).not.toHaveBeenCalled();
  expect(ipc.writeDocument).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().getDocument(key)?.content).toBe(content);
});
