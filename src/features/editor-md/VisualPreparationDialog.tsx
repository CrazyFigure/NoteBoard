// 可视化切换的阶段反馈：解析阶段不伪造百分比，装载阶段显示真实节点进度，取消始终回到原文。
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FileCode2, LoaderCircle } from 'lucide-react';
import type { PreparationStage } from './visualPreparation.worker';

export interface VisualPreparationProgress {
  stage: PreparationStage | 'starting' | 'mounting' | 'revealing';
  loaded?: number;
  total?: number;
}

const STAGE_LABELS = { starting: '正在启动编辑器', parsing: '正在解析 Markdown', checking: '正在检查回写格式', comparing: '正在整理规范化差异', mounting: '正在装载可视化正文', revealing: '正在完成页面排版' };

/** 使用模态焦点管理保护原文；Esc 与按钮都只取消切换，不能关闭文档或接受规范化。 */
export function VisualPreparationDialog({ displayName, progress, onCancel }: { displayName: string; progress: VisualPreparationProgress; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const percent = progress.total ? Math.round((progress.loaded ?? 0) / progress.total * 100) : undefined;
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="nb-modal-overlay nb-md-preparation-overlay">
          <Dialog.Content className="nb-modal-dialog nb-md-preparation-dialog" aria-describedby="nb-md-preparation-description">
            <div className="nb-md-preparation-icon"><LoaderCircle size={24} aria-hidden="true" /></div>
            <Dialog.Title className="nb-md-preparation-title">正在准备可视化</Dialog.Title>
            <Dialog.Description id="nb-md-preparation-description" className="nb-md-preparation-name">{displayName}</Dialog.Description>
            <div className="nb-md-preparation-stage" role="status" aria-live="polite">{STAGE_LABELS[progress.stage]}</div>
            <div className={`nb-md-preparation-track${percent === undefined ? ' is-indeterminate' : ''}`} role="progressbar" aria-label="可视化准备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
            </div>
            <p className="nb-md-preparation-hint">{elapsed >= 8 ? `已等待 ${elapsed} 秒，可随时返回源码。` : '大文档需要一些时间，完成后即可继续编辑。'}</p>
            <button type="button" className="nb-btn-secondary nb-md-preparation-cancel" onClick={onCancel}><FileCode2 size={15} />取消并返回源码</button>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
