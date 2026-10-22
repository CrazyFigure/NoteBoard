// NoteBoard 沉浸阅读入口按钮
// 供各格式自带的顶部工具栏使用：样式类由调用方传入以贴合所在工具栏，
// 阅读时仍保留工具栏的格式（多维表格）同一按钮切换为退出

import type { CSSProperties } from 'react';
import { BookOpen, Minimize2 } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { requestReadingMode, useIsReading } from './readingMode';

interface ReadingModeButtonProps {
  docKey: string;
  /** 所在工具栏的按钮样式类（需自带 Hover / Active 反馈） */
  className: string;
  /** 是否显示文字标签 */
  showLabel?: boolean;
  iconSize?: number;
  /** 退出提示是否显示 Esc 快捷键（所在格式未接管 Esc 时关闭） */
  escHint?: boolean;
  style?: CSSProperties;
}

export function ReadingModeButton({ docKey, className, showLabel = false, iconSize = 13, escHint = true, style }: ReadingModeButtonProps) {
  const isReading = useIsReading(docKey);
  const label = isReading ? '退出沉浸阅读' : '沉浸阅读';
  const Icon = isReading ? Minimize2 : BookOpen;

  return (
    <Tooltip content={label} shortcut={isReading && escHint ? 'Esc' : undefined} side="bottom" sideOffset={4}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-pressed={isReading}
        onClick={() => requestReadingMode(!isReading)}
        style={style}
      >
        <Icon size={iconSize} />
        {showLabel && <span>{isReading ? '退出阅读' : '阅读'}</span>}
      </button>
    </Tooltip>
  );
}
