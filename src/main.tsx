// NoteBoard 前端入口
// 防首屏闪烁：render 前同步读 localStorage 缓存写 data-theme

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import './styles/scrollbar.css';
import './styles/mobile.css';
import { applyCachedTheme, applyCachedTypography } from './core/theme/applyTheme';
import { perfMark } from './core/perf/perfMarks';
import { IS_MOBILE_UI } from './core/platform';
import { installInputModalityTracking } from './core/inputModality';
import { installNumberInputWheelGuard } from './core/numberInputGuard';
import { installMobileFocusGuard } from './mobile/focusGuard';

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

// 记录指针类型，供 hover 菜单区分触屏补发的兼容鼠标事件
installInputModalityTracking();

// 数字输入框：滚轮经过时失焦，避免滚动页面时误改数值（上下微调按钮由全局样式隐藏）
installNumberInputWheelGuard();

// 移动端：标记平台供样式切换，并禁止双击/双指缩放整页（编辑器内容缩放由各编辑器自行处理）
if (IS_MOBILE_UI) {
  document.documentElement.dataset.platform = 'mobile';
  // 拦截非用户意图的程序化聚焦，避免打开文档 / 选中单元格时自动弹出软键盘
  installMobileFocusGuard();
  const viewport = document.querySelector('meta[name="viewport"]');
  viewport?.setAttribute(
    'content',
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content',
  );
}

/** 挂载 React 根组件 */
function renderApp(): void {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

declare const __NB_DEV_MOCK__: boolean | undefined;

// 开发服务器 + ?mock=1：先安装 Tauri IPC 模拟再渲染（浏览器预览界面）；生产构建中整段被常量折叠移除
if (typeof __NB_DEV_MOCK__ !== 'undefined' && __NB_DEV_MOCK__ && new URLSearchParams(window.location.search).get('mock') === '1') {
  void import('./dev/tauriMock').then((module) => {
    module.installTauriMock();
    renderApp();
  });
} else {
  renderApp();
}

// 🔴 性能诊断：React 首帧提交的 rAF 代理标记（不等于 shell 可见，仅用于阶段归因）
requestAnimationFrame(() => {
  perfMark('root_first_frame_raf');
});
