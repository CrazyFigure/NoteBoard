// 导入交互回归：选择/取消不改当前文档，直接打开生成可另存为的原生副本。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
vi.mock('@/features/mindmap/MindmapImportDialog', () => ({ requestMindmapChoice: vi.fn(), confirmMindmapImport: vi.fn() }));
vi.mock('@/core/ipc/commands', () => ({ readXmindFile: vi.fn(), setDocumentDirty: vi.fn() }));
import { requestMindmapChoice, confirmMindmapImport } from '@/features/mindmap/MindmapImportDialog';
import { readXmindFile } from '@/core/ipc/commands';
import { importXmindWithDialogs, openXmindAsMindmap } from '@/features/mindmap/xmindImportFlow';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';

async function sample(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify([
    { title: '方案 A', rootTopic: { id: 'a', title: 'A' } },
    { title: '方案 B', relationships: [{}], rootTopic: { id: 'b', title: 'B' } },
  ]));
  return zip.generateAsync({ type: 'arraybuffer' });
}

beforeEach(() => {
  vi.clearAllMocks();
  useDocumentStore.getState().clear();
  useWindowStore.setState({ tabs: [], activeKey: null });
  vi.mocked(confirmMindmapImport).mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('XMind 导入交互', () => {
  it('普通 HTTP 网页没有 randomUUID 时仍可生成未保存副本', async () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    vi.mocked(requestMindmapChoice).mockResolvedValue('0');
    vi.mocked(readXmindFile).mockResolvedValue(new Uint8Array(await sample()));
    const key = await openXmindAsMindmap('/workspace/http-site.xmind');
    expect(key).toMatch(/^untitled:mindmap:[a-f0-9]{32}$/);
    expect(useWindowStore.getState().getTab(key!)?.path).toBeNull();
  });

  it('选择第二张画布后提示该画布的兼容差异，选中内容完整返回', async () => {
    vi.mocked(requestMindmapChoice).mockResolvedValue('1');
    expect((await importXmindWithDialogs(await sample()))?.text).toBe('B');
    expect(confirmMindmapImport).toHaveBeenCalledWith(['关联线无法转换']);
    expect(useDocumentStore.getState().documents.size).toBe(0);
  });

  it('取消画布选择或取消兼容确认都不建标签', async () => {
    vi.mocked(requestMindmapChoice).mockResolvedValue(null);
    expect(await importXmindWithDialogs(await sample())).toBeNull();
    expect(confirmMindmapImport).not.toHaveBeenCalled();
    vi.mocked(requestMindmapChoice).mockResolvedValue('1');
    vi.mocked(confirmMindmapImport).mockResolvedValue(false);
    expect(await importXmindWithDialogs(await sample())).toBeNull();
    expect(useWindowStore.getState().tabs).toHaveLength(0);
  });

  it('直接打开是未保存的 .mindmap 副本，重复打开激活已有副本', async () => {
    vi.mocked(requestMindmapChoice).mockResolvedValue('0');
    vi.mocked(readXmindFile).mockResolvedValue(new Uint8Array(await sample()));
    const key = await openXmindAsMindmap('C:/test/imported.xmind');
    expect(key).toMatch(/^untitled:mindmap:/);
    expect(useDocumentStore.getState().getDocument(key!)?.displayName).toBe('imported.mindmap');
    expect(useDocumentStore.getState().getDocument(key!)?.isDirty).toBe(true);
    expect(useWindowStore.getState().getTab(key!)?.path).toBeNull();
    expect(await openXmindAsMindmap('C:/test/imported.xmind')).toBe(key);
    expect(readXmindFile).toHaveBeenCalledTimes(1);
    expect(useWindowStore.getState().tabs).toHaveLength(1);
  });
});
