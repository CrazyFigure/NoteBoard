// NoteBoard 平台判定
// 1. 构建目标平台：由 Vite 在构建期注入（Tauri CLI 执行 beforeDev/BuildCommand 时提供 TAURI_ENV_PLATFORM），
//    同步可用、可被打包器常量折叠；单元测试与纯浏览器开发环境缺省视为 Windows（保持既有路径语义）。
// 2. 移动界面：原生移动端始终使用；桌面开发调试可用 localStorage `nb-force-mobile=1` 或 URL `?mobile=1`
//    在 Windows 上强制移动布局（路径语义仍按真实系统）。

declare const __NB_TARGET_PLATFORM__: string | undefined;

/** 构建目标平台：windows / macos / linux / android / ios */
export const TARGET_PLATFORM: string =
  (typeof __NB_TARGET_PLATFORM__ !== 'undefined' && __NB_TARGET_PLATFORM__) || 'windows';

/** 原生移动端（Android / iOS） */
export const IS_NATIVE_MOBILE = TARGET_PLATFORM === 'android' || TARGET_PLATFORM === 'ios';

/** 文件路径是否为 Windows 语义（反斜杠 + 大小写不敏感） */
export const USES_WINDOWS_PATHS = TARGET_PLATFORM === 'windows';

/** 读取桌面调试用的强制移动布局开关（访问 localStorage 可能抛错，需兜底） */
function readForceMobileFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('mobile') === '1') return true;
    return window.localStorage.getItem('nb-force-mobile') === '1';
  } catch {
    return false;
  }
}

/** 是否使用移动端界面（原生移动端，或桌面强制移动布局调试） */
export const IS_MOBILE_UI: boolean = IS_NATIVE_MOBILE || readForceMobileFlag();
