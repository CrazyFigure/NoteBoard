// NoteBoard 设置 · 图片目录卡片
// 图片存放位置二选一：文档同级子目录（默认）/ 统一目录。
// 统一目录的位置可随时任选（留空跟随同步文件夹）；同时开启同步 / 备份时必须位于同步文件夹内，
// 否则新图片改存同步文件夹下的同名目录，并在此处与「同步与备份」页提示一键迁移。
// 切换只影响之后插入的图片；老文档引用的是相对路径，图片文件未动，始终可正常显示。
// 已有图片可通过「整理现有图片」按当前模式迁移（先预览，确认后执行）。

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FolderOpen, FolderOutput, Image as ImageIcon, Images } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Tooltip } from '../Tooltip';
import * as ipc from '../../core/ipc/commands';
import type { ImageStorageMode } from '../../core/ipc/types';
import { IS_MOBILE_UI } from '../../core/platform';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSyncStore } from '../../stores/syncStore';
import { showToast } from '../../stores/toastStore';
import { useExplorerStore } from '../../features/explorer/explorerStore';
import {
  DEFAULT_IMAGE_DIR_NAME,
  resolveGlobalDir,
  sameDir,
  sanitizeDirName,
  syncSnapshotOf,
} from '../../features/editor-md/imageStorage';
import { ImageMigrationDialog } from '../../features/editor-md/ImageMigrationDialog';
import { outermostRoots, type MigrationOptions } from '../../features/editor-md/imageMigration';
import './imageStorageSettings.css';

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  border: '1px solid var(--editor-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--editor-surface)',
  color: 'var(--editor-text)',
  outline: 'none',
  width: '100%',
  maxWidth: 280,
  boxSizing: 'border-box',
};

/** 图片目录设置的状态与操作（设置卡片与「同步与备份」页的提示共用） */
function useImageDirModel() {
  const file = useSettingsStore((s) => s.settings.file);
  const setFile = useSettingsStore((s) => s.setFile);
  const syncConfig = useSyncStore((s) => s.config);
  const explorerRoot = useExplorerStore((s) => s.root);
  // 同步配置由 App 启动时统一初始化（桌面、移动端、网页共用），这里只订阅结果
  const sync = useMemo(() => syncSnapshotOf(syncConfig), [syncConfig]);
  const [migration, setMigration] = useState<MigrationOptions | null>(null);

  const mode: ImageStorageMode = file.imageStorageMode ?? 'sibling';
  // 两种模式共用同一个目录名，只是所在位置不同
  const dirName = sanitizeDirName(file.imageDirName, DEFAULT_IMAGE_DIR_NAME);
  const globalRoot = file.imageGlobalRoot?.trim() ?? '';
  const state = resolveGlobalDir({ globalRoot, imageDirName: file.imageDirName, sync });
  // 整理图片时扫描同步文件夹与当前打开的文件夹
  const scanRoots = outermostRoots([sync.root, explorerRoot]);

  /** 开启的是同步、自动备份还是两者，用于提示文案 */
  const syncLabel = syncConfig?.sync.enabled && syncConfig.backup.autoEnabled
    ? '多端同步与自动备份'
    : syncConfig?.sync.enabled ? '多端同步' : '自动备份';

  /**
   * 更换统一目录位置；nextRoot 为空表示跟随同步文件夹。
   * 同步 / 备份开启时拒绝同步文件夹外的位置；原统一目录已存在时打开迁移预览，把旧图片一并搬过去。
   */
  const changeLocation = async (nextRoot: string) => {
    const next = nextRoot.trim();
    if (next === globalRoot || (next && sameDir(next, globalRoot))) return;
    const nextState = resolveGlobalDir({ globalRoot: next, imageDirName: file.imageDirName, sync });
    if (nextState.outsideSync) {
      showToast(`已开启${syncLabel}，统一目录必须位于同步文件夹内，请选择同步文件夹或其中的子文件夹`, 'warning', 6000);
      return;
    }
    setFile({ imageGlobalRoot: next });
    const target = nextState.effectiveDir;
    if (!target) return;
    // 原来实际使用与用户设置的统一目录都可能存有图片
    const oldDirs = [state.configuredDir, state.effectiveDir]
      .filter((dir): dir is string => !!dir && !sameDir(dir, target))
      .filter((dir, index, list) => list.findIndex((other) => sameDir(other, dir)) === index);
    const existing: string[] = [];
    for (const dir of oldDirs) {
      const result = await ipc.pathExists(dir).catch(() => null);
      if (result?.exists && result.isDir) existing.push(dir);
    }
    showToast(`统一目录已改为 ${target}`, 'success');
    if (existing.length > 0 && scanRoots.length > 0) {
      setMigration({ direction: 'toGlobal', scanRoots, imageDirName: file.imageDirName, globalDir: target, legacyGlobalDirs: existing });
    }
  };

  /** 选择统一目录位置（桌面端、网页端使用文件夹选择框） */
  const pickLocation = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string' && selected) await changeLocation(selected);
  };

  return { file, setFile, sync, mode, dirName, globalRoot, state, scanRoots, explorerRoot, syncLabel, migration, setMigration, changeLocation, pickLocation };
}

type ImageDirModel = ReturnType<typeof useImageDirModel>;

/** 同步 / 备份已开启但统一目录在同步文件夹外：说明原因并提供一键迁移 */
function OutsideSyncWarning({ model }: { model: ImageDirModel }) {
  const { mode, state, syncLabel, changeLocation } = model;
  if (mode !== 'global' || !state.outsideSync) return null;
  return (
    <div className="nb-image-mode-warning" role="alert">
      <AlertTriangle size={15} color="var(--warning-500, #f59e0b)" style={{ flexShrink: 0, marginTop: 2 }} />
      <div className="nb-image-mode-warning-body">
        <span>
          已开启{syncLabel}，统一目录需要位于同步文件夹内，图片才能随笔记一起同步和备份。
          当前设置的 {state.configuredDir} 在同步文件夹之外，新插入的图片已改存到 {state.effectiveDir}。
        </span>
        <div className="nb-image-mode-warning-actions">
          <button type="button" className="nb-btn-primary" onClick={() => void changeLocation('')}>
            迁移到同步文件夹
          </button>
        </div>
      </div>
    </div>
  );
}

/** 统一模式下，同步 / 备份已开启而统一目录位于同步文件夹外 */
export function useImageDirOutsideSync(): boolean {
  const file = useSettingsStore((s) => s.settings.file);
  const syncConfig = useSyncStore((s) => s.config);
  return useMemo(
    () => (file.imageStorageMode ?? 'sibling') === 'global'
      && resolveGlobalDir({ globalRoot: file.imageGlobalRoot, imageDirName: file.imageDirName, sync: syncSnapshotOf(syncConfig) }).outsideSync,
    [file.imageStorageMode, file.imageGlobalRoot, file.imageDirName, syncConfig],
  );
}

/** 「同步与备份」页使用的提示：统一目录在同步文件夹外时出现，可直接迁移 */
export function ImageDirOutsideSyncNotice() {
  const model = useImageDirModel();
  return (
    <>
      <OutsideSyncWarning model={model} />
      {model.migration && <ImageMigrationDialog open options={model.migration} onClose={() => model.setMigration(null)} />}
    </>
  );
}

export function ImageStorageSettingsCard() {
  const model = useImageDirModel();
  const { file, setFile, sync, mode, dirName, globalRoot, state, scanRoots, explorerRoot, migration, setMigration, changeLocation, pickLocation } = model;
  // 移动端没有文件夹选择框，直接输入路径，失焦时生效
  const [mobileLocation, setMobileLocation] = useState(globalRoot);
  useEffect(() => setMobileLocation(globalRoot), [globalRoot]);

  /** 切换存放模式：只影响之后插入的图片 */
  const selectMode = (next: ImageStorageMode) => {
    if (next === mode) return;
    if (next === 'sibling') {
      setFile({ imageStorageMode: 'sibling' });
      showToast(`之后插入的图片将存入各文档同级的 /${dirName}，已有图片不受影响`, 'success');
      return;
    }
    // 统一目录随时可选：既没设置位置也没有同步文件夹时，默认放在当前打开的文件夹
    if (!state.effectiveDir && explorerRoot) {
      setFile({ imageStorageMode: 'global', imageGlobalRoot: explorerRoot });
      const fallback = resolveGlobalDir({ globalRoot: explorerRoot, imageDirName: file.imageDirName, sync });
      showToast(`之后插入的图片将存入 ${fallback.effectiveDir}，可随时更改位置，已有图片不受影响`, 'success', 5000);
      return;
    }
    setFile({ imageStorageMode: 'global' });
    if (state.effectiveDir) {
      showToast(`之后插入的图片将存入 ${state.effectiveDir}，已有图片不受影响`, 'success', 5000);
    } else {
      showToast('请为统一目录选择一个位置', 'info');
      if (!IS_MOBILE_UI) void pickLocation();
    }
  };

  /** 打开迁移对话框：方向由当前模式决定 */
  const migrationOptions = (): MigrationOptions | null => {
    if (!state.effectiveDir || scanRoots.length === 0) return null;
    return {
      direction: mode === 'global' ? 'toGlobal' : 'toSibling',
      scanRoots,
      imageDirName: file.imageDirName,
      globalDir: state.effectiveDir,
      // 设置的位置与实际使用的不同（同步文件夹外）时，原位置的图片一并整理
      legacyGlobalDirs: state.configuredDir && !sameDir(state.configuredDir, state.effectiveDir) ? [state.configuredDir] : [],
    };
  };
  const migrationDisabledReason = scanRoots.length === 0
    ? '需要先打开文件夹或设置同步文件夹'
    : !state.effectiveDir ? '需要先选择统一目录的位置' : '';

  return (
    <div data-setting-id="imageDir" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', background: 'var(--editor-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--editor-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13, color: 'var(--editor-text)' }}>
        <ImageIcon size={15} color="var(--accent-strong)" />
        <span>图片目录设置</span>
      </div>

      {/* 存放位置 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--editor-text)' }}>图片存放位置</div>
        <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
          插入或粘贴本地图片时保存的位置，文档中始终写入相对路径。切换只影响之后插入的图片，已有图片不受影响。
        </div>
        <div className="nb-image-mode-options" role="group" aria-label="图片存放位置">
          <button
            type="button"
            className={`nb-image-mode-option${mode === 'sibling' ? ' is-selected' : ''}`}
            aria-pressed={mode === 'sibling'}
            onClick={() => selectMode('sibling')}
          >
            <span className="nb-image-mode-option-title"><FolderOpen size={14} />文档同级目录</span>
            <span className="nb-image-mode-option-desc">每篇文档的图片存放在其所在目录的子文件夹中</span>
          </button>
          <button
            type="button"
            className={`nb-image-mode-option${mode === 'global' ? ' is-selected' : ''}`}
            aria-pressed={mode === 'global'}
            onClick={() => selectMode('global')}
          >
            <span className="nb-image-mode-option-title"><Images size={14} />统一目录</span>
            <span className="nb-image-mode-option-desc">全部文档的图片集中存放在一个目录，位置可自选</span>
          </button>
        </div>
      </div>

      {/* 图片目录名称：两种模式共用，说明随模式切换 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--editor-text)' }}>图片目录名称</div>
        <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginBottom: 2 }}>
          {mode === 'global' ? (
            <>统一目录的文件夹名称，创建在下方所选位置中（默认 <code>{DEFAULT_IMAGE_DIR_NAME}</code>）</>
          ) : (
            <>在当前 Markdown 文档所在目录同一层自动创建的子文件夹名称（默认 <code>{DEFAULT_IMAGE_DIR_NAME}</code>）</>
          )}
        </div>
        <input
          type="text"
          value={file.imageDirName ?? DEFAULT_IMAGE_DIR_NAME}
          onChange={(e) => setFile({ imageDirName: e.target.value })}
          placeholder={DEFAULT_IMAGE_DIR_NAME}
          style={inputStyle}
        />
      </div>

      {/* 统一目录位置：随时可选；同步 / 备份开启时必须在同步文件夹内 */}
      {mode === 'global' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--editor-text)' }}>统一目录位置</div>
          <div style={{ fontSize: 11, color: 'var(--editor-text-muted)' }}>
            /{dirName} 所在的文件夹，可随时更改，更改后可将原有图片一并迁移。{sync.root ? '未选择时跟随同步文件夹。' : ''}开启同步或备份时需位于同步文件夹内。
          </div>
          <div className="nb-image-mode-location">
            {IS_MOBILE_UI ? (
              <input
                className="nb-image-mode-location-input"
                type="text"
                value={mobileLocation}
                placeholder={sync.root ? `跟随同步文件夹（${sync.root}）` : '例如 /storage/emulated/0/Notes'}
                onChange={(e) => setMobileLocation(e.target.value)}
                onBlur={() => void changeLocation(mobileLocation)}
              />
            ) : (
              <Tooltip content={globalRoot} disabled={!globalRoot} side="top" sideOffset={4}>
                <input
                  className="nb-image-mode-location-input"
                  type="text"
                  readOnly
                  value={globalRoot}
                  placeholder={sync.root ? `跟随同步文件夹（${sync.root}）` : '尚未选择'}
                />
              </Tooltip>
            )}
            {!IS_MOBILE_UI && (
              <button type="button" className="nb-btn-secondary" onClick={() => void pickLocation()}>
                <FolderOpen size={14} />
                选择文件夹
              </button>
            )}
            {globalRoot && sync.root && (
              <Tooltip content={`统一目录改为同步文件夹下的 /${dirName}`} side="top" sideOffset={4}>
                <button type="button" className="nb-btn-secondary" onClick={() => void changeLocation('')}>
                  跟随同步文件夹
                </button>
              </Tooltip>
            )}
          </div>
          {state.effectiveDir ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="nb-image-mode-path">图片存入：{state.effectiveDir}</span>
              {!IS_MOBILE_UI && (
                <Tooltip content="在文件管理器中打开" side="top" sideOffset={4}>
                  <button
                    type="button"
                    className="nb-sync-icon-btn"
                    aria-label="在文件管理器中打开"
                    onClick={() => void ipc.revealInExplorer(state.effectiveDir!).catch(() => showToast('统一目录尚未创建，插入第一张图片后自动创建', 'info'))}
                  >
                    <FolderOutput size={14} />
                  </button>
                </Tooltip>
              )}
            </div>
          ) : (
            <div className="nb-image-mode-path" style={{ color: 'var(--warning-500, #f59e0b)' }}>
              尚未选择位置，图片暂时存入文档同级目录。
            </div>
          )}
          <OutsideSyncWarning model={model} />
        </div>
      )}

      {/* 整理现有图片 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', flex: '1 1 200px' }}>
          {mode === 'global'
            ? `可将各文档同级 /${dirName} 中的图片整理到统一目录，并自动改写引用。`
            : `可将统一目录中的图片整理回各文档同级的 /${dirName}，并自动改写引用。`}
        </div>
        <Tooltip content={migrationDisabledReason} side="top" sideOffset={4} disabled={!migrationDisabledReason}>
          <span style={{ display: 'inline-flex' }}>
            <button type="button" className="nb-btn-secondary" disabled={!!migrationDisabledReason} onClick={() => setMigration(migrationOptions())}>
              整理现有图片
            </button>
          </span>
        </Tooltip>
      </div>

      {migration && <ImageMigrationDialog open options={migration} onClose={() => setMigration(null)} />}
    </div>
  );
}
