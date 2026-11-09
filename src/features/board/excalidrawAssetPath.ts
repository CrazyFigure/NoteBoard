// Excalidraw 画布字体的本地资源路径配置。
//
// 🔴 Excalidraw 0.18 的字体不随 npm 包自动加载：未设置 window.EXCALIDRAW_ASSET_PATH 时，
//    Excalifont / Xiaolai / Nunito 等字体会去 esm.sh 下载，被桌面版 CSP 拦截、离线也不可用，
//    画布于是退回系统字体。vite.config.ts 的 excalidrawFontsPlugin 把包内字体发布到同源目录，
//    这里必须在 import('@excalidraw/excalidraw') 之前把路径指过去。

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

// 与 vite.config.ts 中 EXCALIDRAW_ASSET_DIR 保持一致
const EXCALIDRAW_ASSET_DIR = 'excalidraw-assets/';

/** 设置 Excalidraw 字体根目录（幂等）；Excalidraw 会在其后拼接 fonts/<族名>/<文件>。 */
export function configureExcalidrawAssetPath(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.EXCALIDRAW_ASSET_PATH) return;
  // base 为 './' 且应用只有 index.html 一个入口、无路由改写地址，
  // 以 document.baseURI 解析即可同时覆盖 Tauri、安卓与网页子路径部署。
  window.EXCALIDRAW_ASSET_PATH = new URL(EXCALIDRAW_ASSET_DIR, document.baseURI).href;
}
