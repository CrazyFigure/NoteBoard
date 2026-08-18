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
  if (!data.appState) data.appState = { viewBackgroundColor: '#ffffff', gridSize: null };
  if (!data.files) data.files = {};

  return data;
}

/**
 * 将 Excalidraw 场景序列化为 JSON 字符串
 */
export function serializeScene(scene: ExcalidrawScene): string {
  // 保持原生结构，不加自定义字段
  const output: ExcalidrawScene = {
    type: scene.type,
    version: scene.version,
    source: scene.source,
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files,
  };

  return JSON.stringify(output, null, 2);
}

/**
 * 创建新的空场景
 * viewBackgroundColor 按当前主题写初始值
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
