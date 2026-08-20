// NoteBoard PlantUML 编码与渲染工具
// 使用 plantuml-encoder 标准规范 + 官方服务渲染 + LRU 200 内存缓存
// 详见 docs/09-开发路线图.md

import plantumlEncoder from 'plantuml-encoder';

/** LRU 内存缓存 */
class LRUCache<K, V> {
  private capacity: number;
  private map: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}

/** PlantUML 官方公开服务根地址 */
const PLANTUML_SERVER_URL = 'https://www.plantuml.com/plantuml';

/** SVG 渲染结果缓存（LRU 200） */
const plantUmlSvgCache = new LRUCache<string, { svg: string; error?: string }>(200);

/**
 * 编码 PlantUML 文本为标准 URL 格式（支持中文 UTF-8 与全图表类型）
 */
export function compressAndEncodePlantUml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  // 补全 @startuml ... @enduml
  let source = trimmed;
  if (
    !source.includes('@startuml') &&
    !source.includes('@startmindmap') &&
    !source.includes('@startsalt') &&
    !source.includes('@startwbs') &&
    !source.includes('@startgantt')
  ) {
    source = `@startuml\n${source}\n@enduml`;
  }

  try {
    return plantumlEncoder.encode(source);
  } catch {
    // 降级使用 PlantUML 官方支持的 HEX 编码 (~h 前缀)
    const utf8Encoder = new TextEncoder();
    const bytes = utf8Encoder.encode(source);
    let hex = '~h';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
}

/**
 * 获取 PlantUML 在线 SVG 地址
 */
export function getPlantUmlSvgUrl(code: string, serverUrl = PLANTUML_SERVER_URL): string {
  const encoded = compressAndEncodePlantUml(code);
  if (!encoded) return '';
  const baseUrl = serverUrl.replace(/\/+$/, '');
  return `${baseUrl}/svg/${encoded}`;
}

/** 别名导出 */
export const encodePlantUml = compressAndEncodePlantUml;

/**
 * 异步渲染 PlantUML 为 SVG 内容（带 LRU 缓存）
 */
export async function renderPlantUmlToSvg(code: string): Promise<{ svg: string; error?: string }> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { svg: '' };
  }

  const cached = plantUmlSvgCache.get(trimmed);
  if (cached) return cached;

  try {
    const url = getPlantUmlSvgUrl(trimmed);
    if (!url) return { svg: '', error: '代码为空' };

    const resp = await fetch(url);
    if (!resp.ok) {
      const errResult = { svg: '', error: `HTTP ${resp.status}: 渲染服务请求失败` };
      plantUmlSvgCache.set(trimmed, errResult);
      return errResult;
    }

    const svgText = await resp.text();
    // 检查是否包含 PlantUML 错误信息
    if (svgText.includes('Syntax Error?') || svgText.includes('[PlantUML error]') || svgText.includes('does not look like HUFFMAN data')) {
      const errResult = { svg: svgText, error: 'PlantUML 语法或格式错误' };
      plantUmlSvgCache.set(trimmed, errResult);
      return errResult;
    }

    const okResult = { svg: svgText };
    plantUmlSvgCache.set(trimmed, okResult);
    return okResult;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { svg: '', error: `无法连接 PlantUML 渲染服务器 (${errorMsg})` };
  }
}

/** 清理 PlantUML 缓存 */
export function clearPlantUmlCache(): void {
  plantUmlSvgCache.clear();
}
