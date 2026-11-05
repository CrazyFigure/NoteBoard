// 用户头像：取用户名首字，按名称散列选色，便于在列表中快速区分不同用户。

const HUES = [212, 262, 330, 24, 152, 188, 42, 292];

function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return HUES[hash % HUES.length];
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span
      className="nb-account-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44), ['--avatar-hue' as string]: hueOf(name) }}
    >
      {initial}
    </span>
  );
}
