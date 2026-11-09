// 画板手写字体（小赖）下载卡片：桌面/安卓按需下载，网页版随前端内置。
import { useEffect, useState } from 'react';
import { Download, PenLine, Trash2 } from 'lucide-react';

import { IS_WEB } from '../../core/platform';
import { useBoardFontPackStore } from '../../stores/boardFontPackStore';
import { showToast } from '../../stores/toastStore';
import { Tooltip } from '../../components/Tooltip';
import { syncBoardHandwritingFaces } from '../board/excalidrawAssetPath';
import { ProgressRing } from './ProgressRing';

const SAMPLE = '把想法画下来，让灵感慢慢生长。';

/** 以 MB 显示体积，保留一位小数 */
const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function PluginBoardFont() {
  const { status, action, progress, error, ensureStatus, download, remove } = useBoardFontPackStore();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { void ensureStatus(); }, [ensureStatus]);

  const ready = IS_WEB || status?.state === 'ready';
  // 预览需要窗口里存在小赖字体面；画板未打开过时由这里补注册（只登记，用到的分片才读取）
  useEffect(() => { if (!IS_WEB) syncBoardHandwritingFaces(status, true); }, [status]);

  const percent = action === 'download' ? progress?.percent ?? null : null;
  const state = IS_WEB ? '已内置' : status?.state === 'ready' ? '已安装' : status?.state === 'invalid' ? '已损坏' : '未下载';

  const handleDownload = async () => {
    const result = await download();
    if (result?.state === 'ready') showToast('画板手写字体已就绪', 'success');
  };
  const handleRemove = async () => {
    setConfirming(false);
    const result = await remove();
    if (result?.state === 'missing') showToast('画板手写字体已卸载', 'success');
  };

  return <div className="nb-plugin-fonts-sub">
    <div className="nb-plugin-fonts-heading">
      <div>
        <h4>画板手写字体</h4>
        <p>画板中文显示为手写体{status ? ` · 约 ${formatMb(status.downloadSizeBytes)}` : ''}</p>
      </div>
      {!IS_WEB && <div className="nb-plugin-actions">
        {ready ? confirming ? <>
          <span className="nb-plugin-confirm-text">卸载手写字体？</span>
          <button type="button" className="nb-plugin-button" onClick={() => setConfirming(false)}>取消</button>
          <button type="button" className="nb-plugin-button danger" disabled={!!action} onClick={() => void handleRemove()}>卸载</button>
        </> : <Tooltip content="卸载画板手写字体"><button type="button" className="nb-plugin-button icon" aria-label="卸载画板手写字体" disabled={!!action} onClick={() => setConfirming(true)}>{action === 'remove' ? <ProgressRing percent={null} /> : <Trash2 size={14} />}</button></Tooltip>
          : <button type="button" className="nb-plugin-button primary" disabled={!!action || !status} onClick={() => void handleDownload()}>
            {action === 'download' ? <ProgressRing percent={percent} /> : <Download size={14} />}
            {action === 'download' ? percent == null ? '正在下载' : `${percent}%` : status?.state === 'invalid' ? '修复' : '下载'}
          </button>}
      </div>}
    </div>
    <article className="nb-plugin-card nb-plugin-font-card">
      <div className="nb-plugin-icon"><PenLine size={18} /></div>
      <div className="nb-plugin-info">
        <div className="nb-plugin-name">小赖 Xiaolai</div>
        <div className="nb-plugin-meta"><span>画板中文 · SIL OFL 1.1</span><span className={`nb-plugin-chip${ready ? ' is-ready' : ''}`}>{state}</span></div>
        <p className="nb-font-sample" style={{ fontFamily: ready ? 'Xiaolai, var(--ui-font-family)' : undefined }}>{SAMPLE}</p>
      </div>
    </article>
    {error && <p className="nb-plugin-error" role="alert">{error}</p>}
  </div>;
}
