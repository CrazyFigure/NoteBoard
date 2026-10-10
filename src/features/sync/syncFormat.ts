// NoteBoard 同步相关的时间格式化（轻量模块：Home 页也会用到，不能拖入设置页表单代码）

export function formatDateTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRelative(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const diff = now - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  let text: string;
  if (minutes < 1) text = future ? '即将' : '刚刚';
  else if (minutes < 60) text = `${minutes} 分钟`;
  else if (minutes < 60 * 24) text = `${Math.round(minutes / 60)} 小时`;
  else text = `${Math.round(minutes / 60 / 24)} 天`;
  if (minutes < 1) return text;
  return future ? `${text}后` : `${text}前`;
}
