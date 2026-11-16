// NoteBoard 「整理现有图片」对话框
// 流程：扫描（只读）→ 预览统计与跳过明细 → 用户确认后执行 → 结果报告。
// 迁移方向由当前图片存放模式决定：统一模式整理为「同级 → 统一」，同级模式整理为「统一 → 同级」。
// 更换统一目录位置（含开启同步 / 备份后移入同步文件夹）时，旧统一目录作为额外来源一并迁移。

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Images, Loader2, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import * as ipc from '../../core/ipc/commands';
import { showToast } from '../../stores/toastStore';
import { SYNC_TOAST_KEY, useSyncStore } from '../../stores/syncStore';
import { useEscapeToClose } from '../sync/SyncControls';
import { dirnameOf, pathKey } from '../explorer/pathUtils';
import { refreshExplorerDir } from './imageActions';
import {
  createIpcReadFs,
  createIpcWriteFs,
  executeImageMigration,
  outermostRoots,
  planImageMigration,
  type MigrationOptions,
  type MigrationPlan,
  type MigrationReport,
} from './imageMigration';
import { DEFAULT_IMAGE_DIR_NAME, sanitizeDirName } from './imageStorage';
import '../sync/sync.css';

/** 预览中最多列出的跳过明细条数 */
const MAX_SKIPPED_SHOWN = 50;

type Phase = 'planning' | 'preview' | 'running' | 'done' | 'error';

interface Progress {
  done: number;
  total: number;
  label: string;
}

/** 统计格子 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--editor-surface)', border: '1px solid var(--editor-border)' }}>
      <span style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--editor-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

/** 进度条 */
function ProgressBar({ progress }: { progress: Progress }) {
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--editor-border)', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: 'var(--accent-strong)', transition: 'width 0.15s ease-out' }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--editor-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {progress.done} / {progress.total}
        {progress.label ? ` · ${progress.label}` : ''}
      </div>
    </div>
  );
}

export function ImageMigrationDialog({ open, options, onClose }: { open: boolean; options: MigrationOptions; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('planning');
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0, label: '' });
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [errorText, setErrorText] = useState('');
  // 对话框关闭或重新打开后，过期的扫描结果不再写入状态
  const runIdRef = useRef(0);

  const canBackup = useSyncStore((s) => !!s.config?.sync.rootDir?.trim());
  const busy = phase === 'running';
  useEscapeToClose(open && !busy, onClose);

  // 两种模式共用同一个目录名，只是所在位置不同；统一目录展示完整路径
  const dirLabel = `/${sanitizeDirName(options.imageDirName, DEFAULT_IMAGE_DIR_NAME)}`;
  const toGlobal = options.direction === 'toGlobal';
  const siblingLabel = `各文档同级 ${dirLabel}`;
  const legacyDirs = (options.legacyGlobalDirs ?? []).filter((dir) => dir && pathKey(dir) !== pathKey(options.globalDir));
  const globalLabel = `统一目录 ${options.globalDir}`;
  const legacyLabel = legacyDirs.map((dir) => `原统一目录 ${dir}`).join('、');
  const fromLabel = toGlobal ? [siblingLabel, legacyLabel].filter(Boolean).join('、') : [globalLabel, legacyLabel].filter(Boolean).join('、');
  const toLabel = toGlobal ? globalLabel : siblingLabel;

  // 打开时扫描生成计划（只读）
  useEffect(() => {
    if (!open) return;
    const runId = ++runIdRef.current;
    setPhase('planning');
    setPlan(null);
    setReport(null);
    setErrorText('');
    setProgress({ done: 0, total: 0, label: '' });
    planImageMigration(options, createIpcReadFs(), (done, total, label) => {
      if (runIdRef.current === runId) setProgress({ done, total, label });
    })
      .then((result) => {
        if (runIdRef.current !== runId) return;
        setPlan(result);
        setPhase('preview');
      })
      .catch((error) => {
        if (runIdRef.current !== runId) return;
        console.error('[imageMigration] 扫描失败:', error);
        setErrorText(error instanceof Error ? error.message : String(error));
        setPhase('error');
      });
    return () => {
      runIdRef.current += 1;
    };
    // options 由调用方在打开时确定，打开期间不变，只随打开状态重新扫描
  }, [open]);

  if (!open) return null;

  /** 执行迁移 */
  const run = async () => {
    if (!plan) return;
    setPhase('running');
    setProgress({ done: 0, total: plan.ops.length + plan.docs.length, label: '' });
    try {
      const result = await executeImageMigration(plan, createIpcWriteFs(), (done, total, label) => setProgress({ done, total, label }));
      setReport(result);
      setPhase('done');
      // 刷新资源管理器中受影响的目录（文件监听也会同步，这里让结果立即可见）
      const dirs = new Map<string, string>();
      for (const op of plan.ops) {
        for (const dir of [dirnameOf(op.from), dirnameOf(op.to), dirnameOf(dirnameOf(op.to))]) dirs.set(pathKey(dir), dir);
      }
      for (const dir of plan.emptyDirCandidates) dirs.set(pathKey(dirnameOf(dir)), dirnameOf(dir));
      dirs.forEach((dir) => void refreshExplorerDir(dir));
    } catch (error) {
      console.error('[imageMigration] 执行失败:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  /** 迁移前手动触发一次备份（后台执行，结果由同步提示展示） */
  const backupNow = async () => {
    try {
      await ipc.backupNow();
      showToast('正在备份…完成后会有提示', 'info', 3000, SYNC_TOAST_KEY);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'warning', 5000, SYNC_TOAST_KEY);
    }
  };

  const nothingToDo = phase === 'preview' && plan !== null && plan.ops.length === 0;

  return (
    <div className="nb-sync-dialog-overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
      <div className="nb-sync-dialog">
        <div className="nb-sync-dialog-head">
          <div className="nb-sync-dialog-title">
            <Images size={16} color="var(--accent-strong)" />
            整理现有图片
          </div>
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button type="button" className="nb-sync-icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>
              <X size={15} />
            </button>
          </Tooltip>
        </div>

        <div className="nb-sync-dialog-body">
          {/* 迁移方向 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: 'var(--editor-text)', wordBreak: 'break-all' }}>
            <span>{fromLabel}</span>
            <ArrowRight size={14} color="var(--accent-strong)" style={{ flexShrink: 0 }} />
            <span>{toLabel}</span>
          </div>
          <div style={{ fontSize: 12, wordBreak: 'break-all' }}>
            扫描范围：{outermostRoots(options.scanRoots).join('、')}
          </div>

          {phase === 'planning' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Loader2 size={14} className="nb-sync-spin" />
                正在扫描 Markdown 文档（只读，不会改动任何文件）…
              </div>
              {progress.total > 0 && <ProgressBar progress={progress} />}
            </>
          )}

          {phase === 'preview' && plan && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                <Stat label="扫描文档" value={plan.stats.scannedDocs} />
                <Stat label="需改写文档" value={plan.stats.docs} />
                <Stat label="涉及图片" value={plan.stats.images} />
                <Stat label="改写引用" value={plan.stats.refs} />
                <Stat label="相同内容去重" value={plan.stats.deduped} />
                <Stat label="同名自动改名" value={plan.stats.renamed} />
              </div>
              {nothingToDo ? (
                <div>没有需要整理的图片。</div>
              ) : (
                <div style={{ fontSize: 12 }}>
                  {toGlobal
                    ? '图片会移动到统一目录，所有引用它们的文档（含其他目录的文档）一并改写为新的相对路径；搬空的旧图片目录移入回收站。'
                    : '图片会复制到各文档的同级目录（只被一个目录引用时直接移动），文档改写为新的相对路径；不再被引用的原图片移入回收站。'}
                  改写的文档可在历史版本中找回，移走的文件可在回收站中恢复。建议先备份。
                </div>
              )}
              {plan.skipped.length > 0 && (
                <details>
                  <summary style={{ cursor: 'pointer', color: 'var(--editor-text)' }}>
                    跳过 {plan.skipped.length} 处
                  </summary>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, maxHeight: 180, overflowY: 'auto' }}>
                    {plan.skipped.slice(0, MAX_SKIPPED_SHOWN).map((item, index) => (
                      <li key={index} style={{ wordBreak: 'break-all' }}>
                        {item.doc.split(/[\\/]/).pop()}
                        {item.src ? `：${item.src}` : ''}（{item.reason}）
                      </li>
                    ))}
                    {plan.skipped.length > MAX_SKIPPED_SHOWN && <li>…其余 {plan.skipped.length - MAX_SKIPPED_SHOWN} 处未列出</li>}
                  </ul>
                </details>
              )}
            </>
          )}

          {phase === 'running' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Loader2 size={14} className="nb-sync-spin" />
                正在整理，请勿关闭…
              </div>
              <ProgressBar progress={progress} />
            </>
          )}

          {phase === 'done' && report && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--editor-text)' }}>
                {report.errors.length > 0 ? <AlertTriangle size={16} color="var(--warning-500, #f59e0b)" /> : <CheckCircle2 size={16} color="var(--success-500, #22c55e)" />}
                {report.errors.length > 0 ? '整理完成，部分文件未能处理' : '整理完成'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                <Stat label="移动 / 复制图片" value={report.files} />
                <Stat label="改写文档" value={report.docs} />
                <Stat label="改写引用" value={report.refs} />
                <Stat label="移入回收站" value={report.trashed + report.removedDirs} />
              </div>
              {report.errors.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, maxHeight: 180, overflowY: 'auto', color: 'var(--error-500, #ef4444)' }}>
                  {report.errors.slice(0, MAX_SKIPPED_SHOWN).map((message, index) => (
                    <li key={index} style={{ wordBreak: 'break-all' }}>{message}</li>
                  ))}
                </ul>
              )}
              {report.errors.length > 0 && <div style={{ fontSize: 12 }}>未处理的引用仍指向原图片，不会出现断图，可稍后重新整理。</div>}
            </>
          )}

          {phase === 'error' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--error-500, #ef4444)' }}>
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 3 }} />
              <span style={{ wordBreak: 'break-all' }}>{errorText || '整理失败'}</span>
            </div>
          )}
        </div>

        <div className="nb-sync-dialog-foot">
          {/* 备份的是同步文件夹，未设置时不提供 */}
          {phase === 'preview' && !nothingToDo && canBackup && (
            <button type="button" className="nb-btn-secondary" style={{ marginRight: 'auto' }} onClick={() => void backupNow()}>
              立即备份
            </button>
          )}
          {phase === 'done' || phase === 'error' || nothingToDo ? (
            <button type="button" className="nb-btn-primary" onClick={onClose}>完成</button>
          ) : (
            <>
              <button type="button" className="nb-btn-secondary" disabled={busy} onClick={onClose}>取消</button>
              <button type="button" className="nb-btn-primary" disabled={phase !== 'preview' || !plan} onClick={() => void run()}>
                {busy && <Loader2 size={14} className="nb-sync-spin" />}
                开始整理
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
