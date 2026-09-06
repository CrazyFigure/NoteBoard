// NoteBoard 前端入口
// 防首屏闪烁：render 前同步读 localStorage 缓存写 data-theme

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import './styles/scrollbar.css';
import { applyCachedTheme, applyCachedTypography } from './core/theme/applyTheme';
import { perfMark } from './core/perf/perfMarks';

// 🔴 性能诊断：js_entry 是模块体首行执行的代理标记（静态依赖已求值完毕）；
// head 中 __nbHtmlTs 记录了 HTML 解析的更早点，两者差值可估算入口依赖求值开销。
perfMark('js_entry', { htmlTs: (window as unknown as { __nbHtmlTs?: number }).__nbHtmlTs ?? -1 });

// 🔴 防首屏闪烁：在 React 渲染之前同步注入主题
if (!applyCachedTheme()) {
  // 没有缓存，默认使用系统主题
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = prefersDark ? 'mo-ye' : 'chen-guang';
}

// 🔴 防首屏闪烁：同步注入排版变量
applyCachedTypography();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// 🔴 性能诊断：React 首帧提交的 rAF 代理标记（不等于 shell 可见，仅用于阶段归因）
requestAnimationFrame(() => {
  perfMark('root_first_frame_raf');
});
