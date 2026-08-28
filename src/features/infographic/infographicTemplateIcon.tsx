// NoteBoard Infographic 预设模板图标渲染
// 把 iconName 映射到 lucide 图标，供 Markdown 内嵌块与独立文件编辑器复用

import React from 'react';
import { Activity, Milestone, Route, Filter, Columns3, LayoutGrid, BarChart3, Sparkles } from 'lucide-react';

export interface InfographicTemplateIconProps {
  iconName: string;
  color?: string;
  size?: number;
}

/** 根据模板 iconName 渲染对应彩色图标 */
export function InfographicTemplateIcon({ iconName, color = 'var(--editor-accent, #3b82f6)', size = 14 }: InfographicTemplateIconProps) {
  const iconProps = { size, color };

  switch (iconName) {
    case 'Activity':
      return <Activity {...iconProps} />;
    case 'Milestone':
      return <Milestone {...iconProps} />;
    case 'Route':
      return <Route {...iconProps} />;
    case 'Filter':
      return <Filter {...iconProps} />;
    case 'Columns3':
      return <Columns3 {...iconProps} />;
    case 'LayoutGrid':
      return <LayoutGrid {...iconProps} />;
    case 'BarChart3':
      return <BarChart3 {...iconProps} />;
    default:
      return <Sparkles {...iconProps} />;
  }
}
