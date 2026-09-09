// NoteBoard 编辑器加载表（S05 懒加载边界，docs/启动性能与低内存根治计划.md §E）
//
// 🔴 依赖红线：
//   1. loader 表只存工厂函数，模块顶层不执行任何 import —— 本文件可安全留在首屏闭包。
//   2. 用 kind + language 选择入口：infographic/mermaid/plantuml 属于 kind=code，
//      不能只按 kind 全送进 CodeEditor。
//   3. 各编辑器的具体组件类型在加载处一次性收窄为统一签名（LazyEditorComponent），
//     props 适配集中在 EditorHost 完成。
//   4. 失败请求可以重建，类型级订阅不可随请求被替换；已就绪组件跨宿主直接复用。
//   5. 🔴 R4-02：编辑器资源注册表在模块作用域维护 idle/loading/ready/error——
//     成功资源（Promise/组件/lazy 包装）跨宿主复用，只有失败重试才替换包装。

import { lazy } from 'react';
import { loaderFactories } from './editorLoaderFactories';
import type { ComponentType } from 'react';
import type { Tab } from '../../stores/windowStore';

/** dev 环境诊断日志开关（资源就绪/失败时输出；生产零输出） */
const isDev = typeof import.meta !== 'undefined' && Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

/** 统一的编辑器组件签名（各编辑器真实 props 由 EditorHost 适配构造） */
export type LazyEditorComponent = ComponentType<Record<string, unknown>>;

/** 可懒加载的编辑器入口类型 */
export type EditorLoaderKind =
  | 'code'
  | 'markdown'
  | 'board'
  | 'mindmap'
  | 'drawio'
  | 'bitable'
  | 'image'
  | 'diagram'
  | 'infographic'
  | 'textdiff';

/** 按 kind + language 解析编辑器入口；unsupported 由轻量常驻视图处理（不懒加载） */
export function resolveEditorKind(tab: Pick<Tab, 'kind' | 'language' | 'toolKind'>): EditorLoaderKind | 'unsupported' {
  // 工具型视图优先分派（不落盘、无文档模型；kind/language 仅为兼容 Tab 结构的占位）
  if (tab.toolKind === 'textdiff') return 'textdiff';
  if (tab.kind === 'code') {
    // 信息图 / Mermaid / PlantUML 是独立图表编辑入口（kind=code + 专属 language）
    if (tab.language === 'infographic') return 'infographic';
    if (tab.language === 'mermaid' || tab.language === 'plantuml') return 'diagram';
    return 'code';
  }
  switch (tab.kind) {
    case 'markdown':
      return 'markdown';
    case 'board':
      return 'board';
    case 'mindmap':
      return 'mindmap';
    case 'drawio':
      return 'drawio';
    case 'bitable':
      return 'bitable';
    case 'image':
      return 'image';
    default:
      return 'unsupported';
  }
}

// 工厂表只声明目标入口，资源状态和订阅由本模块统一管理。
// ── 🔴 R4-02：编辑器资源注册表（模块作用域 idle/loading/ready/error） ──
//
// 模块已加载 ≠ lazy 包装已 fulfilled：每次 createLazyEditor 新建 lazy 会让
// 重挂载的宿主重新进入 Suspense 加载边界（已复现 D08）。注册表在模块作用域
// 缓存 loader Promise、成功组件与**稳定的 lazy 包装**——同一入口成功后所有
// 宿主复用同一已完成 lazy，重挂载不再显示模块加载页；只有失败重试才替换
// 该失败项的包装（React.lazy 缓存 rejection，重建包装是唯一的恢复手段）。
// 🔴 P0-1b：在 lazy 之外补充**组件直渲染通道**——React.lazy 的 ctor 即便返回
//    已 resolve 的 promise，首次渲染仍要经 pending→微任务→retry（本次渲染必
//    suspend，fallback 必提交一次；慢环境下该 fallback 期被放大为"一直显示
//    正在加载"）。EditorHost 改经 useSyncExternalStore 订阅资源状态：ready
//    时直接同步渲染缓存组件（零 fallback），loading/error 时不进入 Suspense。

interface EditorResourceEntry {
  /** 稳定的 lazy 包装（entry 存活期间所有宿主复用；失败重试时随 entry 一起替换） */
  lazyComponent: LazyEditorComponent;
  /** 底层加载 Promise（lazy 的 loader 返回同一引用——单次 import，状态可观测） */
  promise: Promise<{ default: LazyEditorComponent }>;
  /** 资源状态：loading → ready / error（诊断与失败重试判断依据） */
  status: 'loading' | 'ready' | 'error';
  /** 失败原因（status=error 时存在） */
  error: unknown;
  /** 🔴 P0-1b：加载成功的组件（ready 后直渲染通道使用——同步渲染零 fallback） */
  component: LazyEditorComponent | null;
}

/** 资源请求可替换，类型级订阅必须稳定；重试不能让已挂载宿主遗留在旧请求上。 */
const resourceListeners = new Map<EditorLoaderKind, Set<() => void>>();
const editorResources = new Map<EditorLoaderKind, EditorResourceEntry>();

/** 通知当前类型的所有宿主；复制订阅集合，避免回调期间增删订阅改变本次遍历。 */
function notifyResource(kind: EditorLoaderKind): void {
  for (const listener of [...(resourceListeners.get(kind) ?? [])]) listener();
}

// ── 🔴 R4-02 定位闭环诊断：加载阶段计数（"持续加载"分类用） ──
// 字段：loading 数（in-flight）/ ready 数 / error 数 / fallback 提交次数
// （EditorHost 加载占位每次提交计入——重挂载不应再产生新 fallback）
const diagnostics = { inflight: 0, ready: 0, error: 0, fallbacks: 0 };

/** 读取加载阶段诊断计数（诊断面板/测试用；不记录路径与正文） */
export function getEditorLoadDiagnostics(): { inflight: number; ready: number; error: number; fallbacks: number } {
  return { ...diagnostics };
}

/** 🔴 R4-02：加载占位提交计数（EditorHost 的加载 UI 渲染时调用——
 *    成功资源复用后正常重挂载不再提交占位，此计数应保持稳定） */
export function noteEditorFallbackShown(): void {
  diagnostics.fallbacks += 1;
  if (isDev) console.debug(`[editorResource] fallback shown (total ${diagnostics.fallbacks})`);
}

/** 取或建立该入口的资源条目（幂等——并发调用共享同一 Promise 与 lazy 包装） */
function getEditorResource(kind: EditorLoaderKind): EditorResourceEntry {
  const existing = editorResources.get(kind);
  if (existing) return existing;
  // 🔴 loader 只发起一次：lazy 的 loader 闭包固定返回同一 Promise 引用
  const promise = loaderFactories[kind]();
  const entry: EditorResourceEntry = {
    promise,
    status: 'loading',
    error: null,
    component: null,
    lazyComponent: lazy(() => promise) as unknown as LazyEditorComponent,
  };
  editorResources.set(kind, entry);
  diagnostics.inflight += 1;
  promise.then(
    (moduleObject) => {
      // 已被测试重置或未来的资源失效操作替换的请求，不再修改当前诊断或通知新宿主。
      if (editorResources.get(kind) !== entry) return;
      entry.status = 'ready';
      entry.component = moduleObject.default;
      diagnostics.inflight -= 1;
      diagnostics.ready += 1;
      if (isDev) console.debug(`[editorResource] ${kind} ready`);
      // 🔴 P0-1b：通知全部订阅者（useSyncExternalStore 触发重渲染——比 lazy 的
      //    微任务 retry 链直接可靠）
      notifyResource(kind);
    },
    (error) => {
      // 旧请求迟到失败不能覆盖新请求状态。
      if (editorResources.get(kind) !== entry) return;
      entry.status = 'error';
      entry.error = error;
      diagnostics.inflight -= 1;
      diagnostics.error += 1;
      if (isDev) console.debug(`[editorResource] ${kind} error`, error);
      notifyResource(kind);
    },
  );
  return entry;
}

/**
 * 🔴 P0-1b：资源状态订阅（useSyncExternalStore 的 subscribe 入口）。
 * 未加载的 kind 订阅即建立条目（触发加载）——与渲染/预取共享同一状态机。
 */
export function subscribeEditorResource(kind: EditorLoaderKind, listener: () => void): () => void {
  getEditorResource(kind);
  let listeners = resourceListeners.get(kind);
  if (!listeners) {
    listeners = new Set();
    resourceListeners.set(kind, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // 最后一个宿主卸载后释放订阅集合；成功模块仍共享缓存。
    if (listeners.size === 0 && resourceListeners.get(kind) === listeners) resourceListeners.delete(kind);
  };
}

/**
 * 🔴 P0-1b：资源快照（useSyncExternalStore 的 getSnapshot）。
 * 返回稳定对象（同状态同引用——状态不变不触发重渲染）；含 ready 组件与错误。
 */
export interface EditorResourceSnapshot {
  status: 'loading' | 'ready' | 'error';
  component: LazyEditorComponent | null;
  error: unknown;
}
const snapshotCache = new Map<EditorLoaderKind, EditorResourceSnapshot>();
export function getEditorResourceSnapshot(kind: EditorLoaderKind): EditorResourceSnapshot {
  const entry = getEditorResource(kind);
  let snap = snapshotCache.get(kind);
  if (!snap || snap.status !== entry.status || snap.component !== entry.component || snap.error !== entry.error) {
    snap = { status: entry.status, component: entry.component, error: entry.error };
    snapshotCache.set(kind, snap);
  }
  return snap;
}

/**
 * 预取唯一目标入口（不渲染）：
 * 打开路径解析出 kind 后立即调用，与读文件并行，避免"先读完再 import"的新瀑布。
 * 🔴 R4-02：预取与实际渲染复用同一资源条目（同一 Promise/lazy）——预取完成后
 *    渲染直接命中 fulfilled 状态，不再经过加载边界。
 */
export function prefetchEditor(kind: EditorLoaderKind): void {
  // 🔴 R10：预取失败必须捕获（未处理 rejection）；失败不清除模块缓存，
  //    真正渲染时由 EditorHost 的错误边界呈现并支持重试
  getEditorResource(kind).promise.catch((error) => {
    console.warn(`[editorLoaders] 预取 ${kind} 编辑器失败（渲染时将重试）:`, error);
  });
}

/**
 * 🔴 R4-02：取该入口的 lazy 组件（成功资源模块级缓存复用）。
 * 保留兼容调用方的稳定包装，首次使用仍可能 suspend；生产 EditorHost 使用 ready
 * 快照里的组件直接渲染，不依赖这个兼容入口的 Promise 重试链。
 */
export function createLazyEditor(kind: EditorLoaderKind): LazyEditorComponent {
  return getEditorResource(kind).lazyComponent;
}

/**
 * 🔴 R4-02：失败资源重试——仅在该入口上次加载失败时重建（丢弃缓存了 rejection
 * 的旧包装；渲染期错误不重建，成功资源保持复用）。返回是否实际重建。
 * 订阅属于编辑器类型，不属于某次请求；立即建立新请求，再向同一订阅集合通知
 * loading 与后续 ready/error，多个宿主无需重新订阅或再次切换标签。
 */
export function retryEditorLoad(kind: EditorLoaderKind): boolean {
  const entry = editorResources.get(kind);
  if (!entry || entry.status !== 'error') return false;
  editorResources.delete(kind);
  snapshotCache.delete(kind);
  diagnostics.error -= 1;
  getEditorResource(kind);
  notifyResource(kind);
  return true;
}

/** 读取资源状态（诊断：定位"持续加载"卡在哪个入口/阶段） */
export function getEditorResourceStatus(
  kind: EditorLoaderKind,
): { status: 'idle' | 'loading' | 'ready' | 'error'; error: unknown } {
  const entry = editorResources.get(kind);
  if (!entry) return { status: 'idle', error: null };
  return { status: entry.status, error: entry.error };
}

/** 仅供测试：清空资源注册表与诊断计数（隔离用例间的模块资源状态） */
export function resetEditorResourcesForTest(): void {
  editorResources.clear();
  snapshotCache.clear();
  resourceListeners.clear();
  diagnostics.inflight = 0;
  diagnostics.ready = 0;
  diagnostics.error = 0;
  diagnostics.fallbacks = 0;
}
