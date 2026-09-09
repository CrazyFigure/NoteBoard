// Markdown 与多维表格共用的纯剪贴板解析，不依赖任一编辑器或表格配置。

/** 将一行分隔文本解析为单元格数组，自动识别 Tab / 逗号分隔符并兼容双引号包裹 */
function splitDelimitedLine(line: string): string[] {
  const delimiter = line.includes('\t') ? '\t' : line.includes(',') ? ',' : '\t';
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * 解析剪贴板文本为二维矩阵
 * 兼容电子表格复制出的 TSV 与 CSV 格式，末尾空行会被丢弃
 */
export function parseClipboardMatrix(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmed = normalized.replace(/\n+$/, '');
  if (!trimmed) return [];
  return trimmed.split('\n').map(splitDelimitedLine);
}
