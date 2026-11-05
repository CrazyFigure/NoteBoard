// NoteBoard 思维导图节点文件链接条目
// 导图画布（固定行高的列表行）与大纲（可换行的胶囊）共用：图标 + 文件名 + 移除按钮，
// Ctrl/Cmd + 单击（触屏直接点按）或鼠标中键在应用内打开目标文件。

import React from 'react';
import { X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { IS_MOBILE_UI } from '../../core/platform';
import { getExplorerFileIcon } from '../explorer/fileIcons';
import { fileLinkName } from './mindmapAttachments';
import { FILE_LINK_OPEN_HINT, isFileLinkOpenGesture } from './mindmapFileLinks';

interface MindmapFileLinkProps {
  path: string;
  onOpen: () => void;
  /** 未提供时不显示移除按钮 */
  onRemove?: () => void;
  /** row：导图节点内整行；chip：大纲中的胶囊 */
  variant?: 'row' | 'chip';
}

export function MindmapFileLink({ path, onOpen, onRemove, variant = 'row' }: MindmapFileLinkProps) {
  const name = fileLinkName(path);

  const handleClick = (e: React.MouseEvent) => {
    // 普通单击交给节点（选中）；带打开修饰键时拦截，避免同时触发节点多选
    if (!isFileLinkOpenGesture(e)) return;
    e.preventDefault();
    e.stopPropagation();
    onOpen();
  };

  return (
    <div className={`nb-mindmap-file${variant === 'chip' ? ' is-chip' : ''}`} data-mindmap-file>
      <Tooltip content={path} shortcut={IS_MOBILE_UI ? undefined : 'Ctrl+单击'} side="bottom" sideOffset={4}>
        <span
          className="nb-mindmap-file-main"
          role="link"
          aria-label={`${name}（${FILE_LINK_OPEN_HINT}）`}
          onClick={handleClick}
          // 鼠标中键同样打开（与 Markdown 中的链接一致）
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            onOpen();
          }}
        >
          {getExplorerFileIcon(path, { size: 13 })}
          <span className="nb-mindmap-file-name">{name}</span>
        </span>
      </Tooltip>
      {onRemove && (
        <Tooltip content="移除链接" side="top" sideOffset={4}>
          <button
            type="button"
            className="nb-mindmap-file-remove"
            aria-label="移除链接"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <X size={10} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
