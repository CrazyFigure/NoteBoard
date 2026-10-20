// 插件与字体下载共用的小型进度圈：已知进度画弧线，未知进度时旋转。

/** percent 为 null 时显示不确定进度，不伪造百分比。 */
export function ProgressRing({ percent, size = 14 }: { percent: number | null | undefined; size?: number }) {
  const radius = 6, length = 2 * Math.PI * radius;
  const known = typeof percent === 'number';
  const value = known ? Math.min(100, Math.max(0, percent)) : 28;
  return <svg className={`nb-progress-ring${known ? '' : ' is-indeterminate'}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" />
    <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeDasharray={`${length * value / 100} ${length}`} transform="rotate(-90 8 8)" />
  </svg>;
}
