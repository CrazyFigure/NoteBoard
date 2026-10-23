// NoteBoard 文档历史记录：Draw.io 差异查看
// 上方按页面列出新增 / 修改 / 删除的图形，下方为解码后的逐行对比（每个图形一行）。
// 全部在本地完成，不依赖在线的 Draw.io 编辑器；无法解码时回退原始 XML 对比。

import { Suspense, lazy, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { decodeDrawio, diffDrawio, drawioText, type DrawioPageDiff } from '../diff/drawioDiff';
import type { VersionViewerProps } from './viewerTypes';

const TextVersionViewer = lazy(() => import('./TextVersionViewer'));

interface Decoded {
  base: string | null;
  target: string;
  pages: DrawioPageDiff[];
}

/** 名称列表最多显示几个 */
const MAX_NAMES = 6;

function names(list: string[]): string {
  const shown = list.slice(0, MAX_NAMES).join('、');
  return list.length > MAX_NAMES ? `${shown} 等 ${list.length} 个` : shown;
}

export default function DrawioVersionViewer(props: VersionViewerProps) {
  const { base, target, showChanges } = props;
  const [decoded, setDecoded] = useState<Decoded | null | 'failed'>(null);

  useEffect(() => {
    let alive = true;
    setDecoded(null);
    void (async () => {
      const t = await decodeDrawio(target);
      const b = base === null ? null : await decodeDrawio(base);
      if (!alive) return;
      if (!t || (base !== null && !b)) {
        setDecoded('failed');
        return;
      }
      setDecoded({ base: b ? drawioText(b) : null, target: drawioText(t), pages: diffDrawio(b, t) });
    })().catch(() => alive && setDecoded('failed'));
    return () => {
      alive = false;
    };
  }, [base, target]);

  if (decoded === null) {
    return (
      <div className="nb-vh-loading">
        <Loader2 size={16} className="nb-sync-spin" />
        正在解析图表
      </div>
    );
  }
  if (decoded === 'failed') {
    return (
      <Suspense fallback={null}>
        <TextVersionViewer {...props} />
      </Suspense>
    );
  }
  return (
    <div className="nb-vh-drawio">
      {showChanges && decoded.pages.length > 0 && (
        <div className="nb-vh-drawio-summary">
          {decoded.pages.map((p) => (
            <div key={p.name} className="nb-vh-drawio-page">
              <span className="nb-vh-drawio-name">{p.name}</span>
              {p.ins.length > 0 && <span className="is-ins">新增 {names(p.ins)}</span>}
              {p.mod.length > 0 && <span className="is-mod">修改 {names(p.mod)}</span>}
              {p.del.length > 0 && <span className="is-del">删除 {names(p.del)}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="nb-vh-drawio-text">
        <Suspense fallback={null}>
          <TextVersionViewer {...props} kind="code" base={decoded.base} target={decoded.target} />
        </Suspense>
      </div>
    </div>
  );
}
