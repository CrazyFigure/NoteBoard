// NoteBoard 极窄模式控制（每个窗口独立）
// 只切换当前窗口的临时布局状态、原生尺寸约束与置顶，不触碰文档内容与撤销历史；
// 每个窗口是独立的 WebView，本模块的状态天然只作用于当前窗口。
// 极窄模式的位置与尺寸与常规模式分开记忆：常规模式由 window-state 插件负责，极窄模式存于 localStorage。
// 自动贴边的拖动约束、吸附与滑入滑出动画在 Rust（src-tauri/src/window/edge_dock.rs）完成，本模块只负责开关与置顶同步。
// 外壳精简逻辑见 AppShell / TitleBar / EditorToolbar，入口按钮见 components/titlebar/CompactModeButtons

import {
  availableMonitors,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from '@tauri-apps/api/window';
import { IS_MOBILE_UI, IS_WEB, TARGET_PLATFORM } from '../../core/platform';
import { setEdgeDock } from '../../core/ipc/commands';
import { onEdgeDock } from '../../core/ipc/events';
import { useLayoutStore } from '../../stores/layoutStore';
import { showToast } from '../../stores/toastStore';

/** 常规模式最小尺寸：与 tauri.conf.json 及 window/manager.rs 建窗参数保持一致 */
const NORMAL_MIN_WIDTH = 680;
const NORMAL_MIN_HEIGHT = 480;
/** 极窄模式默认宽度：约为常规最小宽度的 3/5 */
const COMPACT_DEFAULT_WIDTH = Math.round(NORMAL_MIN_WIDTH * 0.6);
/** 极窄模式可调宽度范围：下限保证精简操作栏完整排开，上限不超过常规最小宽度 */
const COMPACT_MIN_WIDTH = 360;
const COMPACT_MAX_WIDTH = NORMAL_MIN_WIDTH;
const COMPACT_MIN_HEIGHT = 240;
/** 最大尺寸接口需同时给出高度：取足够大的值，等同于不限制高度 */
const UNBOUNDED_HEIGHT = 16384;

/** 极窄模式记忆：尺寸全窗口共用；位置按窗口标签区分，避免多个窗口同时进入时叠在一起 */
const COMPACT_MEMORY_KEY = 'nb-compact-window';
/** 位置记录上限：新窗口标签递增，只保留最近使用的若干条 */
const MAX_REMEMBERED_POSITIONS = 8;

interface CompactMemory {
  width?: number;
  height?: number;
  positions?: Record<string, { x: number; y: number }>;
  /** 上次是否开启自动贴边：再次进入极窄模式时沿用 */
  edgeDock?: boolean;
}

/** 进入前的常规窗口外观，退出时原样还原 */
interface SavedBounds {
  width: number;
  height: number;
  position: PhysicalPosition | null;
  maximized: boolean;
}

let savedBounds: SavedBounds | null = null;
/** 用户最新期望值：异步窗口操作排队执行，过期请求据此跳过 */
let desiredCompactMode = false;
/** 串行化原生窗口操作，避免快速连点时较晚完成的旧请求覆盖最新状态 */
let windowOperation: Promise<void> = Promise.resolve();

/** 仅桌面端提供：网页无法调整浏览器窗口，移动端应用本身即全屏 */
export function supportsCompactMode(): boolean {
  return !IS_WEB && !IS_MOBILE_UI;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 读取极窄模式记忆；存储不可用或内容损坏时视为无记忆 */
function readCompactMemory(): CompactMemory {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COMPACT_MEMORY_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as CompactMemory) : {};
  } catch {
    return {};
  }
}

function writeCompactMemory(memory: CompactMemory): void {
  try {
    window.localStorage.setItem(COMPACT_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // 存储不可用时仅失去记忆，不影响模式切换
  }
}

/** 退出前记下当前极窄窗口的尺寸与位置（位置用物理像素，与读取接口一致） */
async function rememberCompactBounds(): Promise<void> {
  const win = getCurrentWindow();
  const factor = await win.scaleFactor();
  const size = (await win.innerSize()).toLogical(factor);
  const position = await win.outerPosition().catch(() => null);
  const memory = readCompactMemory();
  const positions = { ...(memory.positions ?? {}) };
  if (position) {
    // 重新插入使当前窗口成为最近使用，超出上限时淘汰最早的记录
    delete positions[win.label];
    positions[win.label] = { x: position.x, y: position.y };
    const labels = Object.keys(positions);
    for (const label of labels.slice(0, Math.max(0, labels.length - MAX_REMEMBERED_POSITIONS))) {
      delete positions[label];
    }
  }
  writeCompactMemory({ ...memory, width: Math.round(size.width), height: Math.round(size.height), positions });
}

/** 记忆的位置是否仍落在某块屏幕上（显示器拔除或分辨率变化后放弃该位置） */
async function isOnScreen(x: number, y: number): Promise<boolean> {
  try {
    const monitors = await availableMonitors();
    // 以标题栏左侧一点为准：只要标题栏可见即可拖回
    const probeX = x + 40;
    const probeY = y + 12;
    return monitors.some(({ position, size }) => (
      probeX >= position.x && probeX < position.x + size.width
      && probeY >= position.y && probeY < position.y + size.height
    ));
  } catch {
    return false;
  }
}

/** 记录常规外观后缩窄窗口；最大化或原生全屏时先还原，否则无法调整尺寸 */
async function shrinkWindow(): Promise<void> {
  const win = getCurrentWindow();
  if (await win.isFullscreen().catch(() => false)) await win.setFullscreen(false);
  const maximized = await win.isMaximized().catch(() => false);
  if (maximized) await win.unmaximize();

  const factor = await win.scaleFactor();
  const size = (await win.innerSize()).toLogical(factor);
  const position = await win.outerPosition().catch(() => null);
  savedBounds = { width: size.width, height: size.height, position, maximized };

  const memory = readCompactMemory();
  const width = clamp(memory.width ?? COMPACT_DEFAULT_WIDTH, COMPACT_MIN_WIDTH, COMPACT_MAX_WIDTH);
  const height = Math.max(COMPACT_MIN_HEIGHT, memory.height ?? size.height);
  const remembered = memory.positions?.[win.label];

  // 先放宽最小尺寸再缩窄，否则系统会把新尺寸钳回常规最小宽度
  await win.setMinSize(new LogicalSize(COMPACT_MIN_WIDTH, COMPACT_MIN_HEIGHT));
  await win.setSize(new LogicalSize(width, height));
  await win.setMaxSize(new LogicalSize(COMPACT_MAX_WIDTH, UNBOUNDED_HEIGHT));
  // 无记忆位置时保持窗口左上角不动
  if (remembered && await isOnScreen(remembered.x, remembered.y)) {
    await win.setPosition(new PhysicalPosition(remembered.x, remembered.y)).catch(() => {});
  }
  // 沿用上次的自动贴边设置；失败（如桌面环境不支持）时静默保持关闭
  if (memory.edgeDock) {
    await applyEdgeDock(true).catch((error) => console.warn('恢复自动贴边失败:', error));
  }
}

/**
 * 记下极窄外观后还原常规尺寸、位置与最大化状态，并恢复常规尺寸约束
 * @param restoreMaximized 窗口隐藏时传 false：Windows 的最大化会重新显示窗口
 */
async function restoreWindow(restoreMaximized = true): Promise<void> {
  const win = getCurrentWindow();
  // 先关闭自动贴边：收起的窗口滑回屏幕内，再记录位置
  if (useLayoutStore.getState().edgeDockEnabled) {
    await applyEdgeDock(false).catch((error) => console.warn('关闭自动贴边失败:', error));
  }
  await rememberCompactBounds().catch((error) => console.warn('记录极窄窗口位置失败:', error));
  if (useLayoutStore.getState().windowPinned) {
    useLayoutStore.getState().setWindowPinned(false);
    await win.setAlwaysOnTop(false).catch(() => {});
  }

  const bounds = savedBounds;
  savedBounds = null;
  // 先解除宽度上限再放大，最后收紧最小尺寸，避免系统按新约束先行拉伸窗口造成跳动
  await win.setMaxSize(null);
  if (bounds) {
    await win.setSize(new LogicalSize(bounds.width, bounds.height));
    if (bounds.position) await win.setPosition(bounds.position).catch(() => {});
  }
  await win.setMinSize(new LogicalSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT));
  if (bounds?.maximized && restoreMaximized) await win.maximize();
}

/**
 * 进入或退出极窄模式
 * 进入：先切换精简外壳（大窗口里显示精简 UI 无违和感），再缩窄窗口；
 * 退出：先还原窗口，再恢复完整外壳，避免完整布局被挤在窄窗口里闪现。
 */
export function requestCompactMode(enabled: boolean, options: { restoreMaximized?: boolean } = {}): Promise<void> {
  if (!supportsCompactMode()) return Promise.resolve();
  const layout = useLayoutStore.getState();
  if (desiredCompactMode === enabled && layout.compactMode === enabled) return windowOperation;
  // 沉浸阅读与画板演示占用系统全屏，与缩窄窗口互斥
  if (enabled && (layout.readingMode || layout.boardPresentationMode)) {
    showToast('请先退出全屏', 'info');
    return Promise.resolve();
  }

  desiredCompactMode = enabled;
  if (enabled) layout.setCompactMode(true);

  windowOperation = windowOperation
    .catch(() => undefined)
    .then(async () => {
      if (desiredCompactMode !== enabled) return;
      try {
        if (enabled) await shrinkWindow();
        else await restoreWindow(options.restoreMaximized ?? true);
      } catch (error) {
        // 原生尺寸调整失败不影响精简外壳本身，用户仍可手动拖拽窗口
        console.error(enabled ? '进入极窄模式失败:' : '退出极窄模式失败:', error);
        if (enabled) showToast('窗口缩窄失败，可手动调整宽度', 'warning');
      } finally {
        if (!enabled && !desiredCompactMode) useLayoutStore.getState().setCompactMode(false);
      }
    });
  return windowOperation;
}

/** 置顶 = 用户钉住，或已贴边（收起后留在屏幕边的细边须浮在其它窗口之上，鼠标才能碰到它） */
function shouldStayOnTop(): boolean {
  const { windowPinned, dockedEdge } = useLayoutStore.getState();
  return windowPinned || dockedEdge !== null;
}

let edgeDockListening = false;

/** 订阅 Rust 推送的贴边状态（只处理本窗口），吸附 / 脱离时同步置顶 */
function ensureEdgeDockListener(): void {
  if (edgeDockListening) return;
  edgeDockListening = true;
  const label = getCurrentWindow().label;
  onEdgeDock((event) => {
    if (event.label !== label) return;
    const layout = useLayoutStore.getState();
    // 关闭后迟到的吸附通知不再生效
    if (!layout.edgeDockEnabled && event.edge) return;
    if (layout.dockedEdge === event.edge) return;
    layout.setDockedEdge(event.edge);
    getCurrentWindow().setAlwaysOnTop(shouldStayOnTop()).catch(() => {});
  }).catch((error) => {
    edgeDockListening = false;
    console.warn('订阅自动贴边状态失败:', error);
  });
}

/** 通知 Rust 开关贴边；关闭时 Rust 会先把收起的窗口滑回 */
async function applyEdgeDock(enabled: boolean): Promise<void> {
  if (enabled) ensureEdgeDockListener();
  await setEdgeDock(enabled);
  const layout = useLayoutStore.getState();
  layout.setEdgeDockEnabled(enabled);
  if (!enabled && layout.dockedEdge !== null) {
    layout.setDockedEdge(null);
    await getCurrentWindow().setAlwaysOnTop(shouldStayOnTop()).catch(() => {});
  }
}

/** 切换自动贴边（仅极窄模式），并记住选择供下次进入极窄模式沿用 */
export function toggleEdgeDock(): Promise<void> {
  const next = !useLayoutStore.getState().edgeDockEnabled;
  // 与进入 / 退出极窄模式排在同一队列，避免与窗口还原交错
  windowOperation = windowOperation
    .catch(() => undefined)
    .then(async () => {
      if (!useLayoutStore.getState().compactMode) return;
      try {
        await applyEdgeDock(next);
        writeCompactMemory({ ...readCompactMemory(), edgeDock: next });
      } catch (error) {
        console.error('切换自动贴边失败:', error);
        // Rust 返回的不支持原因（如 Wayland）直接展示
        showToast(typeof error === 'string' ? error : '自动贴边切换失败', 'warning');
      }
    });
  return windowOperation;
}

/** 切换当前窗口置顶；部分 Linux 窗口管理器不支持时回滚并提示 */
export async function toggleWindowPinned(): Promise<void> {
  const layout = useLayoutStore.getState();
  const next = !layout.windowPinned;
  layout.setWindowPinned(next);
  try {
    // 贴边吸附期间无论是否钉住都保持置顶
    await getCurrentWindow().setAlwaysOnTop(shouldStayOnTop());
  } catch (error) {
    console.error('切换窗口置顶失败:', error);
    useLayoutStore.getState().setWindowPinned(!next);
    showToast('当前系统不支持窗口置顶', 'warning');
  }
}

/**
 * 关闭窗口前还原常规尺寸：window-state 在关闭时记录窗口尺寸，
 * 不还原会让下次启动沿用极窄尺寸（极窄外观在还原前已另行记忆）。
 * Windows 先隐藏再还原，避免关闭前闪现放大（隐藏窗口在 Windows 上仍能正确记录尺寸；
 * macOS / Linux 隐藏后读数不可靠，直接还原）。
 * @returns 是否为此隐藏了窗口（关闭失败时调用方需重新显示）
 */
export async function settleCompactModeBeforeClose(): Promise<boolean> {
  if (!supportsCompactMode() || (!useLayoutStore.getState().compactMode && !savedBounds)) return false;
  const hide = TARGET_PLATFORM === 'windows';
  if (hide) await getCurrentWindow().hide().catch(() => {});
  await requestCompactMode(false, { restoreMaximized: !hide });
  return hide;
}
