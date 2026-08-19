// NoteBoard 前端入口
// 防首屏闪烁：render 前同步读 localStorage 缓存写 data-theme

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import './styles/scrollbar.css';
// 引入内置字体（JetBrains Mono 与 Maple Mono）
import './styles/fonts.css';
import { applyCachedTheme, applyCachedTypography } from './core/theme/applyTheme';

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
