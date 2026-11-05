// 将宿主的有界文件接口接入 PDF.js；不预取整文件，取消后不再读盘或回传。
export const RANGE_CHUNK_BYTES = 256 * 1024;
const MAX_READ_BYTES = 1024 * 1024;

/** PDF.js 有时合并多个块；串行读取控制在途内存，完整范围只在确有解析需求时分配。 */
export function createRangeTransport(Transport, source, signal, onError) {
  const transport = new Transport(source.size, new Uint8Array(), true);
  let stopped = signal.aborted, queue = Promise.resolve();
  transport.abort = () => { stopped = true; };
  transport.requestDataRange = (begin, end) => {
    queue = queue.then(async () => {
      if (stopped || signal.aborted) return;
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin >= end || end > source.size) throw new Error('PDF 读取范围无效');
      // 单个小范围直接交给 PDF.js 转移所有权，不再复制一次。
      let bytes;
      if (end - begin <= MAX_READ_BYTES) bytes = await source.read(begin, end);
      else {
        bytes = new Uint8Array(end - begin);
        for (let offset = begin; offset < end; offset += MAX_READ_BYTES) {
          if (stopped || signal.aborted) return;
          const limit = Math.min(end, offset + MAX_READ_BYTES), chunk = await source.read(offset, limit);
          if (chunk.length !== limit - offset) throw new Error('PDF 分块长度不完整');
          bytes.set(chunk, offset - begin);
        }
      }
      if (bytes.length !== end - begin) throw new Error('PDF 分块长度不完整');
      if (!stopped && !signal.aborted) transport.onDataRange(begin, bytes);
    }).catch((error) => {
      if (!stopped && !signal.aborted) { stopped = true; onError(error); }
    });
  };
  return transport;
}
