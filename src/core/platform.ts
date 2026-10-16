// NoteBoard 平台判定
// 1. 构建目标平台：由 Vite 在构建期注入（Tauri CLI 执行 beforeDev/BuildCommand 时提供 TAURI_ENV_PLATFORM），
//    同步可用、可被打包器常量折叠；单元测试与纯浏览器开发环境缺省视为 Windows（保持既有路径语义）。
// 2. 移动界面：原生移动端始终使用；桌面开发调试可用 localStorage `nb-force-mobile=1` 或 URL `?mobile=1`
//    在 Windows 上强制移动布局（路径语义仍按真实系统）。

declare const __NB_TARGET_PLATFORM__: string | undefined;

/** Tauri CLI 使用 darwin / androideabi 等目标三元组名称，先统一为应用内平台名。 */
const BUILD_PLATFORM: string =
  (typeof __NB_TARGET_PLATFORM__ !== 'undefined' && __NB_TARGET_PLATFORM__) || 'windows';
export const TARGET_PLATFORM: string = ({ darwin: 'macos', androideabi: 'android', win32: 'windows' } as Record<string, string>)[BUILD_PLATFORM] ?? BUILD_PLATFORM;

/** 原生移动端（Android / iOS） */
export const IS_NATIVE_MOBILE = TARGET_PLATFORM === 'android' || TARGET_PLATFORM === 'ios';

/** 网页部署使用服务器工作区和浏览器能力，不调用本机桌面窗口。 */
export const IS_WEB = TARGET_PLATFORM === 'web';

/** macOS / Linux 使用系统标题栏，避免重复显示 Windows 风格窗口控制。 */
export const USES_NATIVE_WINDOW_CHROME = TARGET_PLATFORM === 'macos' || TARGET_PLATFORM === 'linux';

/** Mac 的主修饰键为 Command；网页端根据访问设备判断，不受服务器系统影响。 */
export const USES_COMMAND_KEY = TARGET_PLATFORM === 'macos' || IS_WEB && typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

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
export const IS_MOBILE_UI: boolean = IS_NATIVE_MOBILE
  // 仅网页依据访问设备宽度选择移动外壳，原生 Windows 缩窄窗口仍保持原有桌面布局。
  || IS_WEB && typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches
  || readForceMobileFlag();
