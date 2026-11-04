// 共享文档规则：后台解析与主线程使用同一份定义，禁止引入界面、store 或原生 API。
//
// 按需逐行读取源码，行的划分与 `source.split('\n')` 完全一致。
// 块级分词器每次调用时收到的是“当前位置到文末”的剩余全文：若命中后先整篇 split，
// 每个块都要付出 O(剩余全文) 的代价，大文档整体退化为 O(n²)（1MB 约 5 秒、5MB 两分多钟）。
// 这里只定位实际读到的行，块结束即停止，代价与块本身的大小成正比。

export class SourceLines {
  // 已定位的各行起点偏移；starts[i] 为第 i 行首字符的位置
  private readonly starts: number[] = [0];
  // 已到达文末（最后一行之后没有换行符）
  private complete = false;

  constructor(private readonly source: string) {}

  /** 第 index 行是否存在（等价于 index < split 结果的长度），按需向后定位 */
  has(index: number): boolean {
    if (index < 0) return false;
    while (index >= this.starts.length && !this.complete) {
      const lineBreak = this.source.indexOf('\n', this.starts[this.starts.length - 1]);
      if (lineBreak < 0) this.complete = true;
      else this.starts.push(lineBreak + 1);
    }
    return index < this.starts.length;
  }

  /** 第 index 行的内容（不含换行符）；不存在时返回 undefined，与数组越界一致 */
  at(index: number): string | undefined {
    if (!this.has(index)) return undefined;
    const end = this.has(index + 1) ? this.starts[index + 1] - 1 : this.source.length;
    return this.source.slice(this.starts[index], end);
  }

  /** 等价于 split 结果的 slice(from, to) */
  slice(from: number, to: number): string[] {
    const lines: string[] = [];
    for (let index = Math.max(0, from); index < to; index += 1) {
      const line = this.at(index);
      if (line === undefined) break;
      lines.push(line);
    }
    return lines;
  }

  /**
   * 前 count 行的原文：等价于 `lines.slice(0, count).join('\n') + (count < lines.length ? '\n' : '')`，
   * 即分词器 raw 的常见拼法（后面还有内容时带上本块最后一行的换行符）。count 须 ≥ 1。
   */
  prefix(count: number): string {
    return this.has(count) ? this.source.slice(0, this.starts[count]) : this.source;
  }
}
