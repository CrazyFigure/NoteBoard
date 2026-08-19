// NoteBoard Excalidraw 场景读写
// .excalidraw 读写，保持原生结构（type/version/source/elements/appState/files）
// 详见 docs/09-开发路线图.md 10.2
//
// 不加自定义顶层字段，确保互操作性（NFR-506）

/** Excalidraw 文件原生结构 */
export interface ExcalidrawScene {
  type: 'excalidraw' | string;
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: ExcalidrawAppState;
  files?: Record<string, ExcalidrawFileData>;
}

/** Excalidraw 元素基础类型 */
export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId?: string | null;
  roundness?: unknown;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements?: unknown[];
  updated: number;
  link?: string | null;
  locked?: boolean;
  // 文本元素额外字段
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  originalText?: string;
  // 其他类型的字段
  [key: string]: unknown;
}

/** Excalidraw 应用状态 */
export interface ExcalidrawAppState {
  viewBackgroundColor: string;
  gridSize: number | null;
  /** 是否启用靠近自动吸附对齐（智能对齐辅助线） */
  objectsSnapModeEnabled?: boolean;
  currentItemStrokeColor?: string;
  currentItemBackgroundColor?: string;
  [key: string]: unknown;
}

/** Excalidraw 文件数据（二进制资源） */
export interface ExcalidrawFileData {
  id: string;
  dataURL: string;
  mimeType: string;
  created: number;
}

/** 支持的 Excalidraw 版本上限 */
export const SUPPORTED_VERSION = 2;

/**
 * 清洗并规范化 Excalidraw AppState
 * 彻底过滤 collaborators（Map 经 JSON 序列化后会退化为 plain object，传给 Excalidraw 必导致 collaborators.forEach 报错）
 * 以及选区、拖拽、菜单、实时辅助线等运行时临时交互状态，仅保留必要的外观和工具偏好设置
 */
export function cleanAppState(appState?: Partial<ExcalidrawAppState> | null): ExcalidrawAppState {
  if (!appState || typeof appState !== 'object') {
    return { viewBackgroundColor: '#ffffff', gridSize: null, objectsSnapModeEnabled: true };
  }

  const {
    // 剔除所有协同及运行时临时状态
    collaborators: _collaborators,
    selectedElementIds: _selectedElementIds,
    previousSelectedElementIds: _previousSelectedElementIds,
    selectedGroupIds: _selectedGroupIds,
    editingGroupId: _editingGroupId,
    editingElement: _editingElement,
    resizingElement: _resizingElement,
    draggingElement: _draggingElement,
    cursorButton: _cursorButton,
    openMenu: _openMenu,
    openSidebar: _openSidebar,
    activeEmbeddable: _activeEmbeddable,
    // 剔除对齐辅助线与偏移量等临时运行态数据，避免持久化至文件
    snapLines: _snapLines,
    originSnapOffset: _originSnapOffset,
    searchMatches: _searchMatches,
    toast: _toast,
    ...rest
  } = appState as Record<string, unknown>;

  return {
    viewBackgroundColor: (rest.viewBackgroundColor as string) ?? '#ffffff',
    gridSize: (rest.gridSize as number | null) ?? null,
    // 默认启用自动吸附对齐，若显式配置则遵从具体文件的设置
    objectsSnapModeEnabled: typeof rest.objectsSnapModeEnabled === 'boolean' ? rest.objectsSnapModeEnabled : true,
    ...rest,
  } as ExcalidrawAppState;
}

/**
 * 将 JSON 字符串解析为 Excalidraw 场景
 */
export function parseScene(json: string): ExcalidrawScene {
  const data = JSON.parse(json) as ExcalidrawScene;

  // 验证基本结构
  if (!data.elements || !Array.isArray(data.elements)) {
    throw new Error('Invalid Excalidraw file: missing elements array');
  }

  // 确保必要字段存在
  if (!data.type) data.type = 'excalidraw';
  if (!data.version) data.version = 2;
  if (!data.source) data.source = 'noteboard';
  if (!data.appState) {
    data.appState = { viewBackgroundColor: '#ffffff', gridSize: null, objectsSnapModeEnabled: true };
  } else {
    // 防御性清洗反序列化后的 appState，剔除导致崩溃的非标准或普通对象属性
    data.appState = cleanAppState(data.appState);
  }
  if (!data.files) data.files = {};

  return data;
}

/**
 * 将 Excalidraw 场景序列化为 JSON 字符串
 */
export function serializeScene(scene: ExcalidrawScene): string {
  // 保持原生结构，清理运行态 appState 字段
  const output: ExcalidrawScene = {
    type: scene.type,
    version: scene.version,
    source: scene.source,
    elements: scene.elements,
    appState: cleanAppState(scene.appState),
    files: scene.files,
  };

  return JSON.stringify(output, null, 2);
}

/**
 * 创建新的空场景
 * viewBackgroundColor 按当前主题写初始值，默认开启自动吸附对齐
 */
export function createEmptyScene(themeIsDark: boolean): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'noteboard',
    elements: [],
    appState: {
      viewBackgroundColor: themeIsDark ? '#1e1e1e' : '#ffffff',
      gridSize: null,
      // 默认开启智能吸附对齐
      objectsSnapModeEnabled: true,
      currentItemStrokeColor: themeIsDark ? '#e6e6e6' : '#1e1e1e',
      currentItemBackgroundColor: 'transparent',
    },
    files: {},
  };
}

/**
 * 检查版本是否高于支持版本
 */
export function isVersionSupported(scene: ExcalidrawScene): boolean {
  return (scene.version ?? 0) <= SUPPORTED_VERSION;
}

/**
 * 获取元素数量
 */
export function getElementCount(scene: ExcalidrawScene): number {
  return scene.elements.filter((e) => !e.isDeleted).length;
}
