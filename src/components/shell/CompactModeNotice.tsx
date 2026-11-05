// NoteBoard 极窄模式格式提示条
// 部分格式的界面依赖横向空间（左右分栏、宽表格、内嵌第三方编辑器），
// 极窄模式下仍可正常使用但显示受限：在编辑区顶部给出一行可关闭的提示与一键退出入口

import { useState } from 'react';
import { Info, X } from 'lucide-react';
import type { Tab } from '../../stores/windowStore';
import { Tooltip } from '../Tooltip';
import { requestCompactMode } from '../../features/window/compactMode';

/** 极窄模式下显示受限的格式及提示文案；未列出的格式已适配窄宽度 */
function limitedReason(tab: Tab): string | null {
  if (tab.toolKind === 'textdiff') return '文本对比需要较宽窗口';
  switch (tab.kind) {
    case 'drawio':
      return 'Draw.io 在窄窗口中显示受限';
    case 'bitable':
      return '表格较宽时需左右滚动查看';
    default:
      return null;
  }
}

/** 本次运行中已关闭提示的格式：关闭一次后同类文件不再打扰 */
const dismissedReasons = new Set<string>();

export function CompactModeNotice({ tab }: { tab: Tab }) {
  const [, setVersion] = useState(0);
  const reason = limitedReason(tab);
  if (!reason || dismissedReasons.has(reason)) return null;

  const dismiss = () => {
    dismissedReasons.add(reason);
    setVersion((v) => v + 1);
  };

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 28,
        padding: '0 4px 0 10px',
        background: 'color-mix(in srgb, var(--accent-strong) 8%, var(--editor-bg))',
        borderBottom: '1px solid var(--editor-border)',
        color: 'var(--editor-text-secondary)',
        fontFamily: 'var(--ui-font-family, inherit)',
        fontSize: 12,
        flexShrink: 0,
        userSelect: 'none',
        animation: 'nb-fade-in 160ms ease-out',
      }}
    >
      <Info size={13} style={{ color: 'var(--accent-strong)', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {reason}
      </span>
      <button
        type="button"
        className="nb-compact-notice-action"
        onClick={() => void requestCompactMode(false)}
      >
        退出极窄
      </button>
      <Tooltip content="不再提示" side="bottom" sideOffset={6}>
        <button
          type="button"
          className="nb-compact-notice-close"
          aria-label="不再提示"
          onClick={dismiss}
        >
          <X size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
