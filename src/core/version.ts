// NoteBoard 前端版本号导出模块
// 单一真相来源：直接导出自 package.json，避免在各组件中硬编码版本号

import packageJson from '../../package.json';

/** 应用全局版本号（如 '0.1.2'） */
export const APP_VERSION: string = packageJson.version;
