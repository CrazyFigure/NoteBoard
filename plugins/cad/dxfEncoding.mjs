// DXF 文本编码修正：R2007 起 DXF 固定为 UTF-8，但文件头仍保留旧的 $DWGCODEPAGE（如 ANSI_936）；
// 上游解析器按代码页解码会把中文 UTF-8 图纸显示成乱码。加 BOM 后解析器优先按 UTF-8 读取。
const BOM = [0xef, 0xbb, 0xbf];

/** 内容是合法 UTF-8 且含非 ASCII 字符时返回带 BOM 的新缓冲；GBK 等旧编码图纸原样返回。 */
export function normalizeDxfEncoding(bytes) {
  if (bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) return bytes;
  if (!bytes.some((byte) => byte > 0x7f)) return bytes;
  // GBK 中文几乎不可能恰好构成合法 UTF-8 序列，严格解码失败即交给代码页处理。
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return bytes; }
  const output = new Uint8Array(bytes.length + 3); output.set(BOM); output.set(bytes, 3);
  return output;
}
