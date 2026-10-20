// 工作台配置属于文档数据，卸载插件时仍完整保留；版本与插件程序版本分开演进。
import type { BitableColumn, BitableRow } from '../bitable/bitableTypes';

export interface WorkbenchSource { id: string; name: string; path: string }
export interface WorkbenchWidget {
  id: string;
  type: 'metric' | 'tasks' | 'calendar' | 'notes' | 'chart' | 'table' | 'markdown' | 'links' | 'progress';
  title: string;
  sourceId?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}
export interface WorkbenchConfig {
  schemaVersion: 1;
  title: string;
  subtitle?: string;
  sources: WorkbenchSource[];
  widgets: WorkbenchWidget[];
}
export interface WorkbenchDataset {
  id: string;
  name: string;
  columns: BitableColumn[];
  rows: BitableRow[];
  error?: string;
}
