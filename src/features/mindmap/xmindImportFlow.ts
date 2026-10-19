// 工具栏导入和直接打开 XMind 复用同一套画布选择、风险确认和资源转换流程。
import { inspectXmindArchive, prepareXmindSheet, readXmindSheets, resolveXmindImages, XMIND_IMPORT_WARNINGS } from './xmindImport';
import { confirmMindmapImport, requestMindmapChoice } from './MindmapImportDialog';
import type { MindNode } from './mindmapTypes';
import { serializeMindmapDocument } from './mindmapConverter';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { pathKey } from '../explorer/pathUtils';
import { readXmindFile } from '../../core/ipc/commands';

// 与普通打开一致：重复打开尚在编辑的同一来源时激活当前转换页，并合并并发导入。
const openedBySource = new Map<string, string>();
const openingBySource = new Map<string, Promise<string | null>>();

/** 解压正文过大时先询问；只有选中的画布会转为原生节点、解码图片。 */
export async function importXmindWithDialogs(buffer: ArrayBuffer): Promise<MindNode | null> {
  const archive = await inspectXmindArchive(buffer);
  if (archive.contentBytes > XMIND_IMPORT_WARNINGS.contentBytes
    && !await confirmMindmapImport(['解压后的正文超过 20 MB，继续解析可能耗时较长并占用较多内存'])) return null;
  const sheets = await readXmindSheets(archive);
  const selectedId = sheets.length > 1
    ? await requestMindmapChoice('选择要导入的 XMind 画布', sheets.map((sheet) => ({ value: sheet.id, label: sheet.title })), '导入选中画布')
    : sheets[0].id;
  if (selectedId === null) return null;
  const sheet = sheets.find((entry) => entry.id === selectedId)!;
  const prepared = prepareXmindSheet(archive, sheet);
  if (!await confirmMindmapImport(prepared.warnings)) return null;
  return resolveXmindImages(archive, prepared.root);
}

/**
 * 直接打开产生未保存的原生导图；首次保存走 .mindmap 另存为，不以源 XMind 路径作为正文写回目标。
 * 取消选择或确认时不建标签、不替换已打开文件。
 */
export async function openXmindAsMindmap(path: string): Promise<string | null> {
  const sourceKey = pathKey(path);
  const existing = openedBySource.get(sourceKey);
  if (existing && useWindowStore.getState().getTab(existing) && useDocumentStore.getState().hasDocument(existing)) {
    useWindowStore.getState().activateTab(existing);
    return existing;
  }
  const pending = openingBySource.get(sourceKey);
  if (pending) return pending;
  const operation = createXmindCopy(path);
  openingBySource.set(sourceKey, operation);
  try {
    const key = await operation;
    if (key) openedBySource.set(sourceKey, key);
    return key;
  } finally {
    openingBySource.delete(sourceKey);
  }
}

/** 所有确认完成后才建立未保存副本，任何取消都不会留下空标签。 */
async function createXmindCopy(path: string): Promise<string | null> {
  const bytes = await readXmindFile(path);
  const root = await importXmindWithDialogs(bytes.slice().buffer as ArrayBuffer);
  if (!root) return null;
  // 普通 HTTP 的网页实例可能没有 randomUUID，安全随机字节仍可生成独立副本身份。
  const uniqueId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `untitled:mindmap:${uniqueId}`;
  const displayName = (path.split(/[\\/]/).at(-1) ?? '思维导图.xmind').replace(/\.xmind$/i, '.mindmap');
  const content = serializeMindmapDocument(root);
  useDocumentStore.getState().upsertFromPayload({ key, displayName, dirPath: '', kind: 'mindmap', language: 'json', content,
    encoding: 'utf8', eol: 'lf', size: new Blob([content]).size, mtime: 0, readonly: false });
  // 转换结果尚未保存，空基线保证取消首次另存为后仍保留未保存提示。
  useDocumentStore.getState().setBaselineContent(key, '');
  useWindowStore.getState().openTab({ key, displayName, path: null, kind: 'mindmap', language: 'json', isDirty: true,
    isPreview: false, viewMode: null, externalStatus: null, isDetached: false });
  return key;
}
