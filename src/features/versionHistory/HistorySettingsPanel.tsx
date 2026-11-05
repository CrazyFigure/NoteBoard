// NoteBoard 设置页：历史记录
// 三档模式（关闭 / 仅本机 / 跨设备同步）、保留时长、合并间隔与占用空间。
// 切换模式由后端迁移或清理已有历史后才生效；关闭会删除全部历史，需二次确认。

import { useCallback, useEffect, useState } from 'react';
import { History, HardDrive, Loader2, Trash2 } from 'lucide-react';
import * as ipc from '../../core/ipc/commands';
import type { HistoryConfigView, HistoryMode, HistoryUsage } from '../../core/ipc/types';
import { Tooltip } from '../../components/Tooltip';
import { SettingsSelect } from '../../components/settings/SettingsSelect';
import { showToast } from '../../stores/toastStore';
import { ConfirmDialog, errorText } from '../sync/SyncControls';
import { formatBytes } from './historyFormat';
import { useVersionHistoryStore } from './versionHistoryStore';
import '../sync/sync.css';

const MODE_OPTIONS: { value: HistoryMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'local', label: '仅本机' },
  { value: 'sync', label: '跨设备同步' },
];

const MODE_HINT: Record<HistoryMode, string> = {
  off: '开启后每次保存都会留下版本',
  local: '版本只保存在本机',
  sync: '同步文件夹内的文档在各设备共享历史',
};

const RETENTION_OPTIONS = [
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
  { value: '0', label: '永久' },
] as const;

const WINDOW_OPTIONS = [
  { value: '1', label: '1 分钟' },
  { value: '3', label: '3 分钟' },
  { value: '5', label: '5 分钟' },
  { value: '10', label: '10 分钟' },
  { value: '30', label: '30 分钟' },
] as const;

const FULL_KEEP_OPTIONS = [
  { value: '7', label: '7 天' },
  { value: '14', label: '14 天' },
  { value: '30', label: '30 天' },
  { value: '180', label: '180 天' },
] as const;

export function HistorySettingsPanel() {
  const [config, setConfig] = useState<HistoryConfigView | null>(null);
  const [usage, setUsage] = useState<HistoryUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'off' | 'clear' | null>(null);
  // 网页部署未构建原生工作进程等情况：显示原因，不给出可操作入口
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const cfg = await ipc.historyGetConfig();
      setConfig(cfg);
      setUsage(cfg.mode === 'off' ? null : await ipc.historyUsage());
      setUnavailable(null);
    } catch (error) {
      setUnavailable(errorText(error));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 设置变化后同步刷新已打开的历史查看界面 */
  const afterChange = async () => {
    await reload();
    if (useVersionHistoryStore.getState().open) void useVersionHistoryStore.getState().refresh();
  };

  const applyMode = async (mode: HistoryMode) => {
    setBusy(true);
    try {
      await ipc.historySetMode(mode);
      showToast(mode === 'off' ? '已关闭历史记录' : '已开启历史记录', 'success');
      await afterChange();
    } catch (error) {
      showToast(`切换失败：${errorText(error)}`, 'error', 6000);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const chooseMode = (mode: HistoryMode) => {
    if (!config || mode === config.mode || busy) return;
    // 关闭会删除已有历史：有数据时先确认
    if (mode === 'off' && (usage?.entries ?? 0) > 0) {
      setConfirm('off');
      return;
    }
    void applyMode(mode);
  };

  const saveOptions = async (patch: Partial<Pick<HistoryConfigView, 'retentionDays' | 'mergeWindowMin' | 'fullKeepDays'>>) => {
    if (!config) return;
    try {
      const next = await ipc.historySetOptions({
        retentionDays: patch.retentionDays ?? config.retentionDays,
        mergeWindowMin: patch.mergeWindowMin ?? config.mergeWindowMin,
        fullKeepDays: patch.fullKeepDays ?? config.fullKeepDays,
        maxTotalMb: config.maxTotalMb,
      });
      setConfig(next);
    } catch (error) {
      showToast(`保存失败：${errorText(error)}`, 'error');
    }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await ipc.historyClearAll();
      showToast('已清空历史记录', 'success');
      await afterChange();
    } catch (error) {
      showToast(`清空失败：${errorText(error)}`, 'error');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (unavailable && !config) {
    return (
      <div className="nb-sync-panel">
        <div className="nb-sync-muted">{unavailable}</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="nb-sync-panel">
        <div className="nb-sync-muted">
          <Loader2 size={14} className="nb-sync-spin" style={{ verticalAlign: -2, marginRight: 6 }} />
          正在加载
        </div>
      </div>
    );
  }

  const enabled = config.mode !== 'off';

  return (
    <div className="nb-sync-panel">
      {/* 页级仅保留标题，记录方式与还原规则由具体设置项说明。 */}
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>历史记录</h3>
      </div>

      <div className="nb-sync-card">
        <div className="nb-sync-card-title">
          <History size={15} />
          <span>记录方式</span>
        </div>
        <div className="nb-sync-segment" role="radiogroup" aria-label="历史记录方式">
          {MODE_OPTIONS.map((option) => {
            const syncBlocked = option.value === 'sync' && !config.syncAvailable;
            const button = (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={config.mode === option.value}
                className={`nb-sync-segment-btn${config.mode === option.value ? ' is-active' : ''}`}
                disabled={busy || syncBlocked}
                onClick={() => chooseMode(option.value)}
              >
                {option.label}
              </button>
            );
            return syncBlocked ? (
              <Tooltip key={option.value} content="需先开启多端同步" side="top" sideOffset={4} delayDuration={100}>
                <span style={{ flex: 1, display: 'flex' }}>{button}</span>
              </Tooltip>
            ) : button;
          })}
        </div>
        <div className="nb-sync-muted">
          {busy ? '正在处理…' : MODE_HINT[config.mode]}
          {config.mode === 'sync' && config.gitBackend && ' · Git 仓库会永久保留历史文件'}
        </div>
      </div>

      {enabled && (
        <div className="nb-sync-card">
          <div className="nb-sync-card-title">
            <HardDrive size={15} />
            <span>保留与空间</span>
          </div>
          <div className="nb-sync-row">
            <div>
              <div>保留时长</div>
              <div className="nb-sync-muted">更早的版本自动删除</div>
            </div>
            <SettingsSelect
              ariaLabel="保留时长"
              value={String(config.retentionDays) as (typeof RETENTION_OPTIONS)[number]['value']}
              options={RETENTION_OPTIONS}
              onChange={(v) => void saveOptions({ retentionDays: Number(v) })}
            />
          </div>
          <div className="nb-sync-row">
            <div>
              <div>完整保留</div>
              <div className="nb-sync-muted">更早的版本每天只留一个</div>
            </div>
            <SettingsSelect
              ariaLabel="完整保留"
              value={String(config.fullKeepDays) as (typeof FULL_KEEP_OPTIONS)[number]['value']}
              options={FULL_KEEP_OPTIONS}
              onChange={(v) => void saveOptions({ fullKeepDays: Number(v) })}
            />
          </div>
          <div className="nb-sync-row">
            <div>
              <div>合并间隔</div>
              <div className="nb-sync-muted">间隔内的连续保存合为一版</div>
            </div>
            <SettingsSelect
              ariaLabel="合并间隔"
              value={String(config.mergeWindowMin) as (typeof WINDOW_OPTIONS)[number]['value']}
              options={WINDOW_OPTIONS}
              onChange={(v) => void saveOptions({ mergeWindowMin: Number(v) })}
            />
          </div>
          <div className="nb-sync-row">
            <div>
              <div>占用空间</div>
              <div className="nb-sync-muted">
                {usage ? `${formatBytes(usage.bytes)} / ${config.effectiveMaxMb} MB · ${usage.docs} 个文档 · ${usage.entries} 个版本` : '统计中…'}
              </div>
            </div>
            <button
              type="button"
              className="nb-btn-secondary"
              disabled={busy || !usage || usage.entries === 0}
              onClick={() => setConfirm('clear')}
            >
              <Trash2 size={14} />
              清空
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'off'}
        title="关闭历史记录"
        confirmLabel="关闭并删除"
        danger
        busy={busy}
        onConfirm={() => void applyMode('off')}
        onClose={() => setConfirm(null)}
      >
        <div>将删除全部历史版本（{formatBytes(usage?.bytes ?? 0)}），文档本身不受影响。</div>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'clear'}
        title="清空历史记录"
        confirmLabel="清空"
        danger
        busy={busy}
        onConfirm={() => void clearAll()}
        onClose={() => setConfirm(null)}
      >
        <div>将删除全部历史版本，文档本身不受影响。</div>
      </ConfirmDialog>
    </div>
  );
}
