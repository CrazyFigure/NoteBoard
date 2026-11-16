// NoteBoard 设置 · 图片目录卡片
// 图片存放位置二选一：文档同级子目录（默认）/ 同步目录下的统一目录。
// 切换只影响之后插入的图片；老文档引用的是相对路径，图片文件未动，始终可正常显示。
// 已有图片可通过「整理现有图片」按当前模式迁移（先预览，确认后执行）。

import { useState } from 'react';
import { FolderOpen, Image as ImageIcon, Images } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import * as ipc from '../../core/ipc/commands';
import type { ImageStorageMode } from '../../core/ipc/types';
import { IS_MOBILE_UI } from '../../core/platform';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSyncStore } from '../../stores/syncStore';
import { showToast } from '../../stores/toastStore';
import { DEFAULT_IMAGE_DIR_NAME, globalImageDir, sanitizeDirName } from '../../features/editor-md/imageStorage';
import { ImageMigrationDialog } from '../../features/editor-md/ImageMigrationDialog';
import type { MigrationOptions } from '../../features/editor-md/imageMigration';
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

interface ImageStorageSettingsCardProps {
  /** 跳转到「同步与备份」页签；同步页签不可见时不传 */
  onOpenSync?: () => void;
}

export function ImageStorageSettingsCard({ onOpenSync }: ImageStorageSettingsCardProps) {
  const file = useSettingsStore((s) => s.settings.file);
  const setFile = useSettingsStore((s) => s.setFile);
  const syncRoot = useSyncStore((s) => s.config?.sync.rootDir?.trim() ?? '');
  // 同步配置由 App 启动时统一初始化（桌面、移动端、网页共用），这里只订阅结果
  const [migration, setMigration] = useState<MigrationOptions | null>(null);

  const mode: ImageStorageMode = file.imageStorageMode ?? 'sibling';
  // 两种模式共用同一个目录名，只是所在位置不同
  const dirName = sanitizeDirName(file.imageDirName, DEFAULT_IMAGE_DIR_NAME);
  const globalPath = globalImageDir(syncRoot, file.imageDirName);
  const globalAvailable = !!globalPath;

  /** 切换存放模式：只影响之后插入的图片 */
  const selectMode = (next: ImageStorageMode) => {
    if (next === mode) return;
    setFile({ imageStorageMode: next });
    showToast(
      next === 'global'
        ? `之后插入的图片将存入同步文件夹下的 /${dirName}，已有图片不受影响`
        : `之后插入的图片将存入各文档同级的 /${dirName}，已有图片不受影响`,
      'success',
    );
  };

  /** 打开迁移对话框：方向由当前模式决定 */
  const openMigration = () => {
    if (!syncRoot) {
      showToast('请先在「同步与备份」中设置同步文件夹', 'warning');
      return;
    }
    setMigration({
      direction: mode === 'global' ? 'toGlobal' : 'toSibling',
      syncRoot,
      imageDirName: file.imageDirName,
    });
  };

  const globalOption = (
    <button
      type="button"
      className={`nb-image-mode-option${mode === 'global' ? ' is-selected' : ''}`}
      aria-pressed={mode === 'global'}
      // 已选中统一模式但同步目录被清空时仍允许切回，不能禁用当前项
      disabled={!globalAvailable && mode !== 'global'}
      onClick={() => selectMode('global')}
    >
      <span className="nb-image-mode-option-title"><Images size={14} />统一目录</span>
      <span className="nb-image-mode-option-desc">全部文档的图片集中存放在同步文件夹下的一个目录</span>
    </button>
  );

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
          {globalAvailable || mode === 'global' ? (
            globalOption
          ) : (
            // 禁用的按钮不触发指针事件，外包一层承载提示
            <Tooltip content="需要先在「同步与备份」中设置同步文件夹" side="top" sideOffset={4}>
              <span style={{ display: 'flex' }}>{globalOption}</span>
            </Tooltip>
          )}
        </div>
      </div>

      {/* 图片目录名称：两种模式共用，说明随模式切换 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--editor-text)' }}>图片目录名称</div>
        <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', marginBottom: 2 }}>
          {mode === 'global' ? (
            <>同步文件夹根目录下的文件夹名称（默认 <code>{DEFAULT_IMAGE_DIR_NAME}</code>），随同步与备份一起保存；不在同步文件夹内的文档仍存入其同级的同名文件夹</>
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

      {/* 统一目录的完整位置 */}
      {mode === 'global' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: -6 }}>
          {globalPath ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="nb-image-mode-path">{globalPath}</span>
              {!IS_MOBILE_UI && (
                <button
                  type="button"
                  className="nb-image-mode-link"
                  onClick={() => void ipc.revealInExplorer(globalPath).catch(() => showToast('统一目录尚未创建，插入第一张图片后自动创建', 'info'))}
                >
                  在资源管理器中打开
                </button>
              )}
            </div>
          ) : (
            <div className="nb-image-mode-path" style={{ color: 'var(--warning-500, #f59e0b)' }}>
              尚未设置同步文件夹，图片暂时存入文档同级目录。
              {onOpenSync && (
                <button type="button" className="nb-image-mode-link" style={{ marginLeft: 6 }} onClick={onOpenSync}>
                  去设置
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 整理现有图片 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: 'var(--editor-text-muted)', flex: '1 1 200px' }}>
          {mode === 'global'
            ? `可将同步文件夹内各文档同级 /${dirName} 中的图片整理到同步文件夹下的 /${dirName}，并自动改写引用。`
            : `可将同步文件夹下 /${dirName} 中的图片整理回各文档同级的 /${dirName}，并自动改写引用。`}
        </div>
        <Tooltip content="需要先设置同步文件夹" side="top" sideOffset={4} disabled={!!syncRoot}>
          <span style={{ display: 'inline-flex' }}>
            <button type="button" className="nb-btn-secondary" disabled={!syncRoot} onClick={openMigration}>
              整理现有图片…
            </button>
          </span>
        </Tooltip>
      </div>

      {migration && <ImageMigrationDialog open options={migration} onClose={() => setMigration(null)} />}
    </div>
  );
}
