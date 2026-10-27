// NoteBoard 新建格式入口布局
// 主页欢迎卡片与标签栏「+」菜单共用一份配置：哪些格式直接展示、哪些收进「更多」，以及各自顺序。
// 本文件只放元数据与归一化逻辑，不引入新建动作，避免设置面板为展示列表而装载编辑器链路。

import type { LucideIcon } from 'lucide-react';
import {
  Braces,
  ChartColumn,
  Database,
  FilePlus,
  FileText,
  GitCompare,
  GitMerge,
  Layout,
  Network,
  PencilRuler,
  Table2,
  Workflow,
} from 'lucide-react';
import type { CreateFormatsLayout } from '../../core/ipc/types';

export type CreateFormatId =
  | 'markdown'
  | 'text'
  | 'bitable'
  | 'board'
  | 'mindmap'
  | 'textdiff'
  | 'drawio'
  | 'infographic'
  | 'mermaid'
  | 'plantuml'
  | 'json'
  | 'sql';

export interface CreateFormatMeta {
  id: CreateFormatId;
  /** 显示名称，如「Markdown 笔记」 */
  name: string;
  /** 扩展名后缀，如「.md」；工具视图没有 */
  ext?: string;
  desc: string;
  icon: LucideIcon;
  /** 「+」菜单与主页卡片图标不同时单独指定 */
  menuIcon?: LucideIcon;
  color: string;
}

export const CREATE_FORMATS: readonly CreateFormatMeta[] = [
  { id: 'markdown', name: 'Markdown 笔记', ext: '.md', desc: '富文本与源码双模笔记', icon: FilePlus, menuIcon: FileText, color: 'var(--editor-accent, #3b82f6)' },
  { id: 'text', name: '文本文档', ext: '.txt', desc: '轻量纯文本记录与备忘', icon: FileText, color: '#64748b' },
  { id: 'bitable', name: '多维表格', ext: '.bitable', desc: '结构化数据与看板视图', icon: Table2, color: '#2563eb' },
  { id: 'board', name: '手绘风白板', ext: '.excalidraw', desc: 'Excalidraw 自由手绘与白板', icon: PencilRuler, color: 'var(--accent-strong, #8b5cf6)' },
  { id: 'mindmap', name: '思维导图', ext: '.mindmap', desc: '大纲 ⇄ 脑图双模切换', icon: Network, color: '#f97316' },
  { id: 'textdiff', name: '文本对比', desc: '左右对照实时比对差异', icon: GitCompare, color: '#10b981' },
  { id: 'drawio', name: '架构图', ext: '.drawio', desc: '专业系统架构与业务流程图', icon: Layout, color: '#ea580c' },
  { id: 'infographic', name: '信息图', ext: '.infographic', desc: '指标看板、时间线与漏斗等可视化', icon: ChartColumn, color: '#14b8a6' },
  { id: 'mermaid', name: 'Mermaid 图表', ext: '.mmd', desc: '时序图、流程图与状态机脚本', icon: Workflow, color: '#00bfb2' },
  { id: 'plantuml', name: 'PlantUML 建模', ext: '.puml', desc: '类图、时序图与系统组件图', icon: GitMerge, color: '#a855f7' },
  { id: 'json', name: 'JSON 配置文件', ext: '.json', desc: 'JSON 数据、格式化与校验', icon: Braces, color: '#eab308' },
  { id: 'sql', name: 'SQL 数据库脚本', ext: '.sql', desc: 'SQL 数据库查询与 DDL 语句', icon: Database, color: '#3b82f6' },
];

const FORMAT_MAP = new Map<string, CreateFormatMeta>(CREATE_FORMATS.map((f) => [f.id, f]));

export function getCreateFormat(id: CreateFormatId): CreateFormatMeta {
  return FORMAT_MAP.get(id)!;
}

/** 默认布局：常用笔记与绘图格式直接展示，文本对比与脚本类格式收进更多 */
export const DEFAULT_CREATE_FORMATS: CreateFormatsLayout = {
  primary: ['markdown', 'text', 'bitable', 'mindmap', 'board', 'drawio'],
  more: ['textdiff', 'infographic', 'mermaid', 'plantuml', 'json', 'sql'],
};

export interface ResolvedCreateFormats {
  primary: CreateFormatId[];
  more: CreateFormatId[];
}

/**
 * 归一化已保存的布局：剔除未知与重复项；后续版本新增的格式按默认分组追加到末尾，
 * 保证每个格式恰好出现一次，旧配置升级后也不会丢失入口。
 */
export function resolveCreateFormats(saved: Partial<CreateFormatsLayout> | null | undefined): ResolvedCreateFormats {
  const seen = new Set<string>();
  const pick = (list: unknown): CreateFormatId[] => {
    if (!Array.isArray(list)) return [];
    const result: CreateFormatId[] = [];
    for (const id of list) {
      if (typeof id !== 'string' || !FORMAT_MAP.has(id) || seen.has(id)) continue;
      seen.add(id);
      result.push(id as CreateFormatId);
    }
    return result;
  };
  const primary = pick(saved?.primary);
  const more = pick(saved?.more);
  for (const id of DEFAULT_CREATE_FORMATS.primary) if (!seen.has(id)) primary.push(id as CreateFormatId);
  for (const id of DEFAULT_CREATE_FORMATS.more) if (!seen.has(id)) more.push(id as CreateFormatId);
  return { primary, more };
}

export function isDefaultCreateFormats(layout: ResolvedCreateFormats): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  return same(layout.primary, DEFAULT_CREATE_FORMATS.primary) && same(layout.more, DEFAULT_CREATE_FORMATS.more);
}

/** 显示名：名称后附扩展名，直接展示与收进更多均不加「新建」 */
export function createFormatLabel(meta: CreateFormatMeta): string {
  return meta.ext ? `${meta.name} (${meta.ext})` : meta.name;
}
