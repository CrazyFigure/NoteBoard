// Excalidraw 画布字体的本地资源路径配置。
//
// 🔴 Excalidraw 0.18 的字体不随 npm 包自动加载：未设置 window.EXCALIDRAW_ASSET_PATH 时，
//    Excalifont / Xiaolai / Nunito 等字体会去 esm.sh 下载，被桌面版 CSP 拦截、离线也不可用，
//    画布于是退回系统字体。vite.config.ts 的 excalidrawFontsPlugin 把包内字体发布到同源目录，
//    这里必须在 import('@excalidraw/excalidraw') 之前把路径指过去。
//
// 小赖中文手写体（约 13 MB）桌面/安卓不随安装包分发，改由「设置 → 插件 → 字体」下载画板手写字体包：
//   - 启动画板时包已就绪：把包目录追加为第二个资源根目录（Excalidraw 对每个分片依次尝试各根目录），
//     画布渲染与 SVG 导出内嵌字体都能使用；
//   - 画板已加载后才下载：Excalidraw 的小赖字体面已固定为旧地址，改为按分片补注册同名 FontFace
//     （实测 Chromium 会跳过加载失败的同名字体面而采用补注册的），document.fonts 的 loadingdone
//     会触发 Excalidraw 重绘文字，无需重启。SVG 导出内嵌小赖要到下次启动才生效。

import { convertFileSrc } from '@tauri-apps/api/core';

import { IS_WEB } from '../../core/platform';
import { useBoardFontPackStore } from '../../stores/boardFontPackStore';
import type { BoardFontPackStatus } from '../../core/ipc/types';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

// 与 vite.config.ts 中 EXCALIDRAW_ASSET_DIR 保持一致
const EXCALIDRAW_ASSET_DIR = 'excalidraw-assets/';

let configurePromise: Promise<void> | null = null;
// 资源路径是否已包含字体包目录（包含时无需补注册字体面）
let packInAssetPath = false;
// 本模块补注册的字体面，卸载字体包时撤销
let supplementaryFaces: FontFace[] = [];

/** 字体包目录转为 WebView 可访问的根地址（以 / 结尾，Excalidraw 在其后拼接 fonts/<族名>/<分片>） */
export function boardFontPackBaseUrl(status: BoardFontPackStatus): string {
  const url = IS_WEB ? status.baseDir : convertFileSrc(status.baseDir);
  // 统一为绝对地址：补注册字体面时要以它为基准拼接分片路径
  return new URL(url.endsWith('/') ? url : `${url}/`, document.baseURI).href;
}

/**
 * 按分片补注册小赖字体面；状态非 ready 时撤销已补注册的字体面。
 * force=true 供设置页预览使用：画板尚未加载时窗口里没有任何小赖字体面，也要注册以显示示例。
 */
export function syncBoardHandwritingFaces(status: BoardFontPackStatus | null, force = false) {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const ready = status?.state === 'ready' && status.faces.length > 0;
  if (!ready) {
    supplementaryFaces.forEach((face) => document.fonts.delete(face));
    supplementaryFaces = [];
    return;
  }
  if ((packInAssetPath && !force) || supplementaryFaces.length) return;
  const base = boardFontPackBaseUrl(status);
  // 只登记不主动加载：画布用到哪个分片才读取哪个，避免一次读入 13 MB
  supplementaryFaces = status.faces.map((face) => new FontFace(
    status.family,
    `url(${JSON.stringify(new URL(`fonts/${status.family}/${face.file}`, base).href)}) format('woff2')`,
    { unicodeRange: face.unicodeRange, display: 'swap' },
  ));
  supplementaryFaces.forEach((face) => document.fonts.add(face));
}

// Excalidraw 中只有 Excalifont（fontFamily=5）的中文回退到小赖，其它字体直接用系统中文字体
const EXCALIFONT_FAMILY_ID = 5;
const CJK_PATTERN = /[㐀-鿿豈-﫿]/;
const HINT_THROTTLE_MS = 1500;
let handwritingHinted = false;
let lastHintCheck = 0;

/** 手写体中文缺少字体包时提示一次（每个会话最多一次；onChange 高频调用时节流） */
export function hintBoardHandwritingIfMissing(elements: readonly unknown[]): void {
  if (IS_WEB || handwritingHinted) return;
  const now = Date.now();
  if (now - lastHintCheck < HINT_THROTTLE_MS) return;
  lastHintCheck = now;
  const status = useBoardFontPackStore.getState().status;
  // 状态未知（查询未完成或失败）时不打扰
  if (!status || status.state === 'ready') return;
  const needsHandwriting = elements.some((element) => {
    const item = element as { type?: string; fontFamily?: number; text?: string; isDeleted?: boolean };
    return item.type === 'text' && !item.isDeleted && item.fontFamily === EXCALIFONT_FAMILY_ID && CJK_PATTERN.test(item.text ?? '');
  });
  if (!needsHandwriting) return;
  handwritingHinted = true;
  void import('../../stores/toastStore').then(({ showToast }) => {
    showToast('中文手写体需下载：设置 → 插件 → 字体', 'info', 6000, 'board-handwriting-font');
  });
}

/**
 * 设置 Excalidraw 字体根目录（幂等，并发调用共享同一次配置）。
 * 必须在 import('@excalidraw/excalidraw') 之前 await，Excalidraw 构造字体面时读取该路径。
 */
export function configureExcalidrawAssetPath(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve();
  if (configurePromise) return configurePromise;
  configurePromise = (async () => {
    // base 为 './' 且应用只有 index.html 一个入口、无路由改写地址，
    // 以 document.baseURI 解析即可同时覆盖 Tauri、安卓与网页子路径部署。
    const paths = [new URL(EXCALIDRAW_ASSET_DIR, document.baseURI).href];
    const store = useBoardFontPackStore;
    // 状态查询失败不阻塞画板，按未安装处理
    const status = await store.getState().ensureStatus().catch(() => null);
    if (status?.state === 'ready') {
      paths.push(boardFontPackBaseUrl(status));
      packInAssetPath = true;
    }
    window.EXCALIDRAW_ASSET_PATH = paths;
    // 之后的安装/卸载（含其它窗口广播）只影响补注册字体面
    store.subscribe((state, previous) => {
      if (state.status !== previous.status) syncBoardHandwritingFaces(state.status);
    });
  })();
  return configurePromise;
}
