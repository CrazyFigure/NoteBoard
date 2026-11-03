// 将导出图片的数据地址直接解码为 Blob，不发起会被原生 CSP 拦截的 data: 网络请求。

/** 支持 Base64 和百分号编码；百分号按原始字节还原，未转义文字由 Blob 编码为 UTF-8。 */
export function dataUrlToBlob(url: string): Blob {
  const separator = url.indexOf(',');
  if (!/^data:/i.test(url) || separator < 0) throw new Error('导出数据地址无效');
  const metadata = url.slice(5, separator);
  const base64 = /;base64$/i.test(metadata);
  const mediaType = metadata.replace(/;base64$/i, '');
  const type = mediaType.startsWith(';') ? `text/plain${mediaType}` : mediaType || 'text/plain;charset=US-ASCII';
  const payload = url.slice(separator + 1);

  if (base64) {
    const binary = atob(decodeURIComponent(payload));
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type });
  }

  // 不能对整个正文使用 decodeURIComponent：PNG 等二进制可能包含不合法的 UTF-8 字节。
  const parts = payload.split(/((?:%[0-9a-f]{2})+)/i).map((part) =>
    /^(?:%[0-9a-f]{2})+$/i.test(part)
      ? Uint8Array.from(part.match(/%([0-9a-f]{2})/gi)!, (byte) => parseInt(byte.slice(1), 16))
      : part,
  );
  return new Blob(parts, { type });
}
