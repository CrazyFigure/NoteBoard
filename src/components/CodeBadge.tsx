// NoteBoard 行内代码徽标
// 以行内代码块的样式展示扩展名、快捷键等短代码文本，替代「名称 (.md)」式的括号写法。
// 色调跟随传入颜色（通常是同行图标色），底色与描边为半透明混合，自动适配各主题。

import type { CSSProperties, ReactNode } from 'react';

interface CodeBadgeProps {
  children: ReactNode;
  /** 色调来源，支持 CSS 变量；不传时使用中性灰 */
  color?: string;
  className?: string;
  style?: CSSProperties;
}

export function CodeBadge({ children, color, className, style }: CodeBadgeProps) {
  return (
    <span
      className={className ? `nb-code-badge ${className}` : 'nb-code-badge'}
      style={color ? ({ '--nb-badge-color': color, ...style } as CSSProperties) : style}
    >
      {children}
    </span>
  );
}
