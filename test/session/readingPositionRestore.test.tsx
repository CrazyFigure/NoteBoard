// 使用真实 Markdown / CodeMirror 编辑器验证关闭重开和开关行为，不依赖正文序列化模拟。
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor } from '@/features/editor-code/CodeEditor';
import { TipTapEditor } from '@/features/editor-md/TipTapEditor';
import { getEditorCapabilities, resetEditorRegistryForTest } from '@/core/editor/editorRegistry';
import { getMdTipTapEditor } from '@/features/editor-md/editorInstances';
import { flushReadingPositions, readReadingPosition, resetReadingPositionsForTest, saveReadingPosition } from '@/features/reading/readingPosition';
import { startReadingPositionTracker } from '@/features/reading/readingPositionTracker';
import { resetSuspensionForTest } from '@/features/session/editorSuspension';
import { clearAllDocumentHistories } from '@/features/history/documentHistory';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import type { LanguageId } from '@/core/ipc/types';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { restoreSplitReadingPosition } from '@/features/reading/restoreTextPosition';

vi.mock('@/features/editor-md/extensions', async () => {
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { Markdown } = await import('@tiptap/markdown');
  return { buildExtensions: () => [StarterKit, Markdown] };
});
vi.mock('@/features/editor-md/bubbleMenu', () => ({ EditorBubbleMenu: () => null, TableToolbar: () => null }));
vi.mock('@/features/editor-md/blockDragHandle', () => ({ BlockDragHandle: () => null }));
vi.mock('@/features/editor-md/tableDragHandle', () => ({ TableDragHandles: () => null }));
vi.mock('@/features/editor-md/EditorContextMenu', () => ({ EditorContextMenu: () => null }));
vi.mock('@/features/editor-md/LinkModal', () => ({ LinkModal: () => null }));
vi.mock('@/features/editor-md/MarkdownModeToggle', () => ({ MarkdownModeToggle: () => null }));
vi.mock('@/features/editor-md/ExternalChangeBanner', () => ({ ExternalChangeBanner: () => null }));
vi.mock('@/features/editor-md/markdownAutoSave', () => ({ autoSaveDocument: vi.fn() }));
vi.mock('@/core/shortcuts', () => ({ registerShortcut: () => () => {}, formatShortcut: (text: string) => text }));
vi.mock('@/core/ipc/commands', () => ({ setDocumentDirty: vi.fn().mockResolvedValue(undefined), unregisterDocument: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'nb-main' }) }));

let host: HTMLDivElement;
let root: Root;
let stopTracker: () => void;
const CONTENT = Array.from({ length: 150 }, (_, index) => `第 ${index + 1} 段正文`).join('\n\n');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
  useDocumentStore.setState({ documents: new Map() });
  useWindowStore.setState({ tabs: [], activeKey: null, transferringKeys: [] });
  resetReadingPositionsForTest(); resetSuspensionForTest(); resetEditorRegistryForTest(); clearAllDocumentHistories();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  stopTracker = startReadingPositionTracker();
});
afterEach(async () => {
  stopTracker();
  await act(async () => root.unmount());
  host.remove(); resetReadingPositionsForTest(); vi.unstubAllGlobals();
});

/** 使用与文件打开链一致的命名文件身份，保留默认模式由真实编辑器决定。 */
async function open(key: string, language: LanguageId, source = false, content = CONTENT) {
  const kind = language === 'markdown' ? 'markdown' : 'code';
  host.dataset.readingDocument = key;
  await act(async () => {
    useDocumentStore.getState().upsertFromPayload({ key, displayName: key.split('/').pop()!, dirPath: 'C:/notes', kind, language, content, encoding: 'utf8', eol: 'lf', size: content.length, mtime: 0, readonly: false });
    useWindowStore.getState().openTab({ key, path: key, displayName: key.split('/').pop()!, kind, language, viewMode: source ? 'source' : null, isDirty: false, isPreview: false, externalStatus: null, isDetached: false });
    root.render(<StrictMode>{kind === 'markdown' ? <TipTapEditor docKey={key} /> : <CodeEditor docKey={key} />}</StrictMode>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 65)); });
}

/** 走真实标签关闭生命周期，让能力仍挂载时捕获最终阅读位置。 */
async function close(key: string) {
  await act(async () => { useWindowStore.getState().closeTab(key); root.render(null); });
}

describe('文本编辑器阅读位置恢复', () => {
  it.each<LanguageId>(['plaintext', 'json', 'sql', 'yaml', 'xml'])('%s 关闭重开恢复滚动且不标脏，关闭开关后从头打开', async (language) => {
    const key = `C:/notes/document.${language}`;
    await open(key, language);
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.scrollTop = 460;
    scroller.dispatchEvent(new Event('scroll'));
    flushReadingPositions();
    expect(readReadingPosition(key)?.scrollTop).toBe(460);
    await close(key);
    await open(key, language);
    expect(host.querySelector('.cm-scroller')?.scrollTop).toBe(460);
    expect(useDocumentStore.getState().getDocument(key)?.isDirty).toBe(false);
    await close(key);
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, file: { ...settings.file, restoreReadingPosition: false } } });
    await open(key, language);
    expect(host.querySelector('.cm-scroller')?.scrollTop).toBe(0);
  });

  it('Markdown 可视化关闭重开保留阅读位置，自动聚焦不滚动到文末旧光标', async () => {
    const key = 'C:/notes/visual.md';
    await open(key, 'markdown');
    const editor = getMdTipTapEditor(key)!;
    await act(async () => { editor.commands.setTextSelection(editor.state.doc.content.size - 2); });
    host.querySelector<HTMLElement>('.nb-md-visual-scroller')!.scrollTop = 460;
    await close(key);
    await open(key, 'markdown');
    expect(host.querySelector('.nb-md-visual-scroller')?.scrollTop).toBe(460);
    expect(useDocumentStore.getState().getDocument(key)?.isDirty).toBe(false);
    expect(useDocumentStore.getState().getDocument(key)?.content).toBe(CONTENT);
  });

  it('Markdown 源码位置重启后按源码模式恢复，不把坐标套到可视化内核', async () => {
    const key = 'C:/notes/source.md';
    saveReadingPosition(key, { kind: 'markdown', mode: 'source', selection: { anchor: 120, head: 125 }, scrollTop: 321 });
    flushReadingPositions(); resetReadingPositionsForTest();
    await open(key, 'markdown');
    expect(useWindowStore.getState().getTab(key)?.viewMode).toBe('source');
    expect(getMdTipTapEditor(key)).toBeUndefined();
    expect(getEditorCapabilities(key)?.captureViewState?.()).toMatchObject({ kind: 'markdown', mode: 'source', selection: { anchor: 120, head: 125 }, scrollTop: 321 });
    // 关闭时标签已被移除，仍应读取源码内核，不能退回默认的 visual 模式。
    host.querySelector<HTMLElement>('.cm-scroller')!.scrollTop = 550;
    await close(key);
    expect(readReadingPosition(key)).toMatchObject({ mode: 'source', scrollTop: 550 });
    await open(key, 'markdown');
    expect(host.querySelector('.cm-scroller')?.scrollTop).toBe(550);
  });

  it('关闭期间文件缩短时裁剪旧选区并丢弃越界折叠，不阻断文本打开', async () => {
    const key = 'C:/notes/short.txt';
    saveReadingPosition(key, { kind: 'code', selection: { anchor: 100_000, head: 100_000 }, scrollTop: 0, foldedRanges: [{ from: 10, to: 100_000 }] });
    await open(key, 'plaintext');
    expect(getEditorCapabilities(key)?.captureViewState?.()).toMatchObject({ selection: { anchor: CONTENT.length, head: CONTENT.length }, foldedRanges: [] });
  });

  it('回到 Home 后关闭隐藏标签，不用隐藏布局的零滚动覆盖阅读记录', async () => {
    const key = 'C:/notes/hidden.txt';
    await open(key, 'plaintext');
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.scrollTop = 460;
    scroller.dispatchEvent(new Event('scroll'));
    Object.defineProperty(host, 'checkVisibility', { configurable: true, value: () => false });
    scroller.scrollTop = 0;
    await close(key);
    Object.defineProperty(host, 'checkVisibility', { configurable: true, value: () => true });
    await open(key, 'plaintext');
    expect(host.querySelector('.cm-scroller')?.scrollTop).toBe(460);
  });

  it('大 Markdown 已有可视化阅读记录时经后台准备恢复，不能因默认源码丢失位置', async () => {
    // jsdom 没有 Worker；只替换线程传输，解析仍调用正式后台数据准备函数。
    const { prepareVisualDocumentData } = await import('@/features/editor-md/visualPreparationData');
    vi.stubGlobal('Worker', class {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      postMessage({ content }: { content: string }) {
        void prepareVisualDocumentData(content, async () => {}).then((result) => this.onmessage?.({ data: { result } }));
      }
      terminate() { this.onmessage = null; }
    });
    const key = 'C:/notes/large.md';
    const content = `${Array.from({ length: 205 }, () => '正文'.repeat(500)).join('\n\n')}\n`;
    saveReadingPosition(key, { kind: 'markdown', mode: 'visual', selection: { anchor: 50, head: 50 }, scrollTop: 321 });
    await open(key, 'markdown', false, content);
    for (let attempt = 0; attempt < 60 && host.querySelector('.nb-md-visual-scroller')?.scrollTop !== 321; attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    }
    expect(useWindowStore.getState().getTab(key)?.viewMode).toBe('visual');
    expect(host.querySelector('.nb-md-visual-scroller')?.scrollTop).toBe(321);
    expect(useDocumentStore.getState().getDocument(key)?.isDirty).toBe(false);
  });

  it('HTML / 图表类文本源码按保存的滚动位置恢复，不跟随旧光标跳到文末', () => {
    const key = 'C:/notes/page.html';
    saveReadingPosition(key, { kind: 'split-diagram', selection: { anchor: CONTENT.length, head: CONTENT.length }, scrollTop: 321, layoutMode: 'source', zoom: 1, pan: { x: 0, y: 0 } });
    const view = new EditorView({ state: EditorState.create({ doc: CONTENT }), parent: host });
    try {
      restoreSplitReadingPosition(key, view);
      expect(view.state.selection.main.head).toBe(CONTENT.length);
      expect(view.scrollDOM.scrollTop).toBe(321);
    } finally {
      view.destroy();
    }
  });
});
