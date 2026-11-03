// 验证宿主按插件能力选择分块，并保护旧插件和 Office 的原有读取路径。
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginPreview } from '@/features/plugins/PluginPreview';
import { readDocument, readPdfFileRange, readPreviewFile } from '@/core/ipc/commands';
import { loadPlugin } from '@/features/plugins/pluginService';
import type { PluginContext } from '@/features/plugins/pluginTypes';

const fixture = vi.hoisted(() => ({ documents:new Map(), installed:[] as unknown[], mount:vi.fn() }));
vi.mock('@/stores/documentStore', () => ({ useDocumentStore:(selector: (state: unknown) => unknown) => selector({documents:fixture.documents}) }));
vi.mock('@/stores/pluginStore', () => ({ initializePlugins:vi.fn(), usePluginStore:(selector: (state: unknown) => unknown) => selector({installed:fixture.installed,busy:null}) }));
vi.mock('@/core/ipc/commands', () => ({ readDocument:vi.fn(), readPdfFileRange:vi.fn(), readPreviewFile:vi.fn() }));
vi.mock('@/features/plugins/pluginService', () => ({ loadPlugin:vi.fn() }));
vi.mock('@/features/plugins/openPluginSettings', () => ({ openPluginSettings:vi.fn() }));
vi.mock('@/features/reading/readingMode', () => ({ isDocumentReading:()=>false,requestReadingMode:vi.fn(),useIsReading:()=>false,useReadingEscape:vi.fn() }));
vi.mock('@/features/reading/ReadingWindowControls', () => ({ ReadingWindowControls:()=>null }));
vi.mock('@/components/UnsupportedView', () => ({ UnsupportedView:({description}:{description:string})=><div>{description}</div> }));
vi.mock('@/core/editor/editorRegistry', () => ({ getDocumentRevision:()=>0,registerEditorCapabilities:()=>()=>{} }));

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.clearAllMocks();fixture.documents.clear();fixture.installed.length=0;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  vi.mocked(loadPlugin).mockResolvedValue({supportsRangeRead:true,mount:fixture.mount});
  vi.mocked(readDocument).mockResolvedValue({size:300*1024*1024} as Awaited<ReturnType<typeof readDocument>>);
  vi.mocked(readPdfFileRange).mockResolvedValue(new Uint8Array([37,80,68,70]));
  vi.mocked(readPreviewFile).mockResolvedValue(new Uint8Array([1,2]));
});
afterEach(async () => { await act(async () => root.unmount());host.remove();vi.unstubAllGlobals(); });

/** 仅填充本次查看器需要的状态，异步 effect 在 act 内完成。 */
async function renderFile(path='large.pdf',size=300*1024*1024) {
  fixture.documents.set(path,{displayName:path,size,mtime:1});
  fixture.installed.push({manifest:{id:path.endsWith('.pdf')?'pdf':'word',version:'1.3.0'},enabled:true});
  await act(async () => {root.render(<PluginPreview docKey={path}/>);});
}

it('大 PDF 仅取得元信息，分块按需执行且卸载后停止读取', async () => {
  await renderFile();
  const context=fixture.mount.mock.calls[0][0] as PluginContext;
  expect(context.bytes).toBeUndefined();expect(context.source?.size).toBe(300*1024*1024);
  expect(readPreviewFile).not.toHaveBeenCalled();expect(readPdfFileRange).not.toHaveBeenCalled();
  await context.source!.read(0,4);
  expect(readPdfFileRange).toHaveBeenCalledWith('large.pdf',0,4,300*1024*1024);
  await act(async () => root.unmount());root=createRoot(host);
  await expect(context.source!.read(4,8)).rejects.toThrow('取消');
  expect(readPdfFileRange).toHaveBeenCalledTimes(1);
});

it('旧 PDF 插件遇到大文件给出更新提示，Office 仍读取原始字节', async () => {
  vi.mocked(loadPlugin).mockResolvedValue({mount:fixture.mount});
  await renderFile();
  expect(host.textContent).toContain('请更新 PDF 查看插件');expect(readPreviewFile).not.toHaveBeenCalled();expect(fixture.mount).not.toHaveBeenCalled();
  await renderFile('small.docx',1024);
  expect(readPreviewFile).toHaveBeenCalledWith('small.docx');expect(readDocument).not.toHaveBeenCalled();
  expect(fixture.mount.mock.calls[0][0].source).toBeUndefined();
  expect(fixture.mount.mock.calls[0][0].bytes).toEqual(new Uint8Array([1,2]));
});

it('插件模块迟到时，已经关闭的文档不继续读盘', async () => {
  let finish!: (value: Awaited<ReturnType<typeof loadPlugin>>) => void;
  vi.mocked(loadPlugin).mockReturnValue(new Promise((resolve)=>{finish=resolve;}));
  await renderFile();await act(async () => root.unmount());root=createRoot(host);
  await act(async () => {finish({supportsRangeRead:true,mount:fixture.mount});});
  expect(readDocument).not.toHaveBeenCalled();expect(readPreviewFile).not.toHaveBeenCalled();expect(fixture.mount).not.toHaveBeenCalled();
});
