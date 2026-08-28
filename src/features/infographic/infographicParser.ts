// NoteBoard Infographic 源码解析器
// 支持 JSON 与常见声明式 YAML 文本解析，提供健壮的容错与错误诊断

import type { InfographicData, InfographicType } from './infographicTypes';

/**
 * 极简轻量 YAML 解析器（针对 Infographic 常见配置语法）
 * 支持对象、数组、缩进嵌套、基础键值对
 */
export function parseYamlSimple(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> | unknown[] }> = [{ indent: -1, obj: root }];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // 跳过空行和纯注释行
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.search(/\S/);
    const content = rawLine.trim();

    // 缩进回退处理
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const currentContext = stack[stack.length - 1].obj;

    // 1. 处理列表项 (以 - 开头)
    if (content.startsWith('- ')) {
      const itemContent = content.slice(2).trim();
      const list = Array.isArray(currentContext) ? currentContext : [];

      if (!Array.isArray(currentContext)) {
        // 如果当前容器不是数组，不能直接 push
        continue;
      }

      if (itemContent.includes(':')) {
        // 列表项是一个对象 (如: - label: 活跃用户)
        const colonIdx = itemContent.indexOf(':');
        const key = itemContent.slice(0, colonIdx).trim();
        let val: unknown = itemContent.slice(colonIdx + 1).trim();
        val = parsePrimitiveValue(val as string);

        const newObj: Record<string, unknown> = { [key]: val };
        list.push(newObj);
        stack.push({ indent, obj: newObj });
      } else {
        // 纯标量列表项 (如: - 选项A)
        list.push(parsePrimitiveValue(itemContent));
      }
      continue;
    }

    // 2. 处理键值对 (key: value 或 key:)
    if (content.includes(':')) {
      const colonIdx = content.indexOf(':');
      const key = content.slice(0, colonIdx).trim();
      const rawVal = content.slice(colonIdx + 1).trim();

      if (rawVal === '') {
        // 嵌套子对象或子数组
        // 查看下一非空行的前缀决定是对象还是数组
        let isNextList = false;
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrim = lines[j].trim();
          if (!nextTrim || nextTrim.startsWith('#')) continue;
          if (nextTrim.startsWith('- ')) isNextList = true;
          break;
        }

        const newChild = isNextList ? [] : {};
        if (Array.isArray(currentContext)) {
          // 当前是数组中的对象
        } else {
          currentContext[key] = newChild;
        }
        stack.push({ indent, obj: newChild });
      } else {
        // 普通常规键值对
        const parsedVal = parsePrimitiveValue(rawVal);
        if (!Array.isArray(currentContext)) {
          currentContext[key] = parsedVal;
        }
      }
    }
  }

  return root;
}

/** 解析基础值（字符串、数字、布尔值、引号脱壳） */
function parsePrimitiveValue(val: string): unknown {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;

  // 剥除首尾单双引号
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }

  // 尝试解析纯数字
  if (/^-?\d+(\.\d+)?$/.test(val)) {
    const num = Number(val);
    if (!isNaN(num)) return num;
  }

  return val;
}

/**
 * 将源码字符串统一解析为 InfographicData 对象
 * 智能自适应 JSON 与 YAML 两种格式
 */
export function parseInfographicCode(code: string): { data: InfographicData | null; error: string | null } {
  const trimmed = code.trim();
  if (!trimmed) {
    return { data: null, error: null };
  }

  try {
    let parsed: Record<string, unknown> | null = null;

    // 优先检测是否为标准 JSON
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } else {
      // 走轻量 YAML 解析
      parsed = parseYamlSimple(trimmed);
    }

    if (!parsed || typeof parsed !== 'object') {
      return { data: null, error: '信息图语法错误：无法解析为结构化数据' };
    }

    // 规范化 type 字段
    const rawType = String(parsed.type || parsed.kind || 'metric-cards').toLowerCase();
    let type: InfographicType = 'metric-cards';

    if (rawType.includes('time') || rawType.includes('lichengbei')) {
      type = 'timeline';
    } else if (rawType.includes('proc') || rawType.includes('step') || rawType.includes('liucheng')) {
      type = 'process';
    } else if (rawType.includes('funnel') || rawType.includes('loudou')) {
      type = 'funnel';
    } else if (rawType.includes('comp') || rawType.includes('vs') || rawType.includes('duibi')) {
      type = 'comparison';
    } else if (rawType.includes('quad') || rawType.includes('matrix') || rawType.includes('xiangxian')) {
      type = 'quadrant';
    } else if (rawType.includes('chart') || rawType.includes('bar') || rawType.includes('pie') || rawType.includes('tubiao')) {
      type = 'chart';
    } else if (rawType.includes('list') || rawType.includes('qingdan')) {
      type = 'list';
    } else {
      type = 'metric-cards';
    }

    const data: InfographicData = {
      type,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : undefined,
      theme: (parsed.theme as InfographicData['theme']) || 'default',
      columns: typeof parsed.columns === 'number' ? parsed.columns : undefined,
      data: Array.isArray(parsed.data) ? parsed.data : undefined,
      items: Array.isArray(parsed.items) ? parsed.items : undefined,
      groups: Array.isArray(parsed.groups) ? parsed.groups : undefined,
      quadrantXLabel: typeof parsed.quadrantXLabel === 'string' ? parsed.quadrantXLabel : undefined,
      quadrantYLabel: typeof parsed.quadrantYLabel === 'string' ? parsed.quadrantYLabel : undefined,
      quadrants: typeof parsed.quadrants === 'object' && parsed.quadrants !== null ? parsed.quadrants : undefined,
      points: Array.isArray(parsed.points) ? parsed.points : undefined,
      chart: typeof parsed.chart === 'object' && parsed.chart !== null ? (parsed.chart as InfographicData['chart']) : undefined,
    };

    return { data, error: null };
  } catch (err) {
    return {
      data: null,
      error: `信息图解析失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
