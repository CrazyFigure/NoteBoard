// 两种笔记均只在内存中解包；统一限制文件数、解压量和单个资源，原文件不写回。
import JSZip from 'jszip';

export const NOTE_LIMIT = 64 * 1024 * 1024;

/** 校验 ZIP 中央目录预算，读取时再次验证实际长度并响应文档关闭。 */
export async function openNoteArchive(bytes, signal) {
  if (!bytes?.length || bytes.length > 50 * 1024 * 1024) throw new Error('笔记为空或超过 50 MB');
  signal?.throwIfAborted();
  let zip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new Error('笔记压缩包无法读取，可能已损坏、加密或不是受支持的格式'); }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > 10000) throw new Error('笔记内部文件超过 10000 个');
  let total = 0;
  for (const entry of entries) {
    total += entry._data?.uncompressedSize ?? 0;
    if (total > NOTE_LIMIT) throw new Error('笔记解压后超过 64 MB');
  }
  return {
    entries,
    async read(entry) {
      signal?.throwIfAborted();
      if (!entry || (entry._data?.uncompressedSize ?? 0) > NOTE_LIMIT) throw new Error('笔记资源无效或过大');
      const value = await entry.async('uint8array');
      signal?.throwIfAborted();
      if (value.length > NOTE_LIMIT) throw new Error('笔记资源超过 64 MB');
      return value;
    },
  };
}

/** 只识别可解码的本地位图/PDF；不把任意附件作为 HTML、SVG 或远程地址加载。 */
export function noteMediaType(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  return null;
}

/** 统一模型只保存解析结果与惰性读取入口；附件永远不冒充已合成批注的页面。 */
export function noteResources(archive, root, previewPattern) {
  const entries = archive.entries.filter((entry) => entry.name.startsWith(root));
  const previews = entries.filter((entry) => previewPattern.test(entry.name.slice(root.length)))
    .sort((a, b) => (b._data?.uncompressedSize ?? 0) - (a._data?.uncompressedSize ?? 0));
  const attachments = entries.filter((entry) => /^(?:PDFs|Images|attachments)\//i.test(entry.name.slice(root.length)));
  return [
    ...previews.slice(0, 1).map((entry) => ({ label: '内嵌预览（通常仅首页）', read: () => archive.read(entry), preview: true })),
    ...attachments.map((entry) => ({ label: `附件 · ${entry.name.slice(root.length)}`, read: () => archive.read(entry) })),
  ];
}
