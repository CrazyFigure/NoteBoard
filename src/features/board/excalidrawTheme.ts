// NoteBoard Excalidraw 主题映射
// theme prop 映射 + 覆盖 --board-* CSS 变量
// 详见 docs/09-开发路线图.md 10.3
//
// 晨光/琥珀都是 'light'，靠变量区分
// viewBackgroundColor 不跟随主题（10.4）

/** Excalidraw theme 类型 */
export type ExcalidrawTheme = 'light' | 'dark';

/**
 * 从 NoteBoard 主题名映射到 Excalidraw theme prop
 */
export function mapTheme(noteboardTheme: string): ExcalidrawTheme {
  switch (noteboardTheme) {
    case 'midnight':
      return 'dark';
    case 'dawn':
    case 'amber':
    default:
      return 'light';
  }
}

/**
 * 设置 --board-* CSS 变量
 * 用于覆盖 Excalidraw 的 UI 颜色
 */
export function applyBoardCSSVars(noteboardTheme: string): void {
  const root = document.documentElement;

  switch (noteboardTheme) {
    case 'midnight':
      // 暗色主题
      root.style.setProperty('--board-bg', '#1e1e1e');
      root.style.setProperty('--board-panel-bg', '#252526');
      root.style.setProperty('--board-border', '#3c3c3c');
      root.style.setProperty('--board-text', '#cccccc');
      root.style.setProperty('--board-text-muted', '#969696');
      root.style.setProperty('--board-accent', '#0e7fd6');
      root.style.setProperty('--board-hover', '#2a2d2e');
      break;
    case 'dawn':
      // 晨光
      root.style.setProperty('--board-bg', '#fffef7');
      root.style.setProperty('--board-panel-bg', '#faf8f0');
      root.style.setProperty('--board-border', '#e8e2d4');
      root.style.setProperty('--board-text', '#3d3929');
      root.style.setProperty('--board-text-muted', '#8a8475');
      root.style.setProperty('--board-accent', '#c0870e');
      root.style.setProperty('--board-hover', '#f5f1e6');
      break;
    case 'amber':
      // 琥珀
      root.style.setProperty('--board-bg', '#fffbf0');
      root.style.setProperty('--board-panel-bg', '#fff8e6');
      root.style.setProperty('--board-border', '#e0d8c0');
      root.style.setProperty('--board-text', '#4a3f28');
      root.style.setProperty('--board-text-muted', '#9a8a6a');
      root.style.setProperty('--board-accent', '#b8860b');
      root.style.setProperty('--board-hover', '#fff2cc');
      break;
    default:
      // 默认浅色
      root.style.setProperty('--board-bg', '#ffffff');
      root.style.setProperty('--board-panel-bg', '#f8f8f8');
      root.style.setProperty('--board-border', '#e0e0e0');
      root.style.setProperty('--board-text', '#333333');
      root.style.setProperty('--board-text-muted', '#888888');
      root.style.setProperty('--board-accent', '#0066cc');
      root.style.setProperty('--board-hover', '#f0f0f0');
      break;
  }
}

/** 中文字体回退配置 */
export const FONT_FAMILY_MAP = {
  // Excalidraw 字体 ID 映射
  1: 'Virgil, "Noto Sans SC", "Microsoft YaHei", sans-serif', // 手写体 + 中文回退
  2: 'Helvetica, "Noto Sans SC", "Microsoft YaHei", sans-serif', // 无衬线
  3: 'Cascadia Code, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace', // 等宽
} as const;
