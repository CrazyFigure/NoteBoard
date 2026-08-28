// NoteBoard 多维表格字段类型元数据
// 表头、列菜单、记录详情侧边栏共用同一套图标与文案，避免多处各写一份造成不一致

import type { BitableFieldType } from './bitableTypes';
import {
  Type,
  Hash,
  Tag,
  Tags,
  Calendar,
  CheckSquare,
  Star,
  BarChart2,
  Link,
} from 'lucide-react';

export interface FieldTypeMeta {
  icon: React.ReactNode;
  label: string;
}

/** 获取字段类型的展示元数据（图标 + 中文名） */
export function getFieldTypeMeta(type: BitableFieldType): FieldTypeMeta {
  switch (type) {
    case 'text':
      return { icon: <Type size={13} color="#3b82f6" />, label: '文本' };
    case 'number':
      return { icon: <Hash size={13} color="#10b981" />, label: '数字' };
    case 'select':
      return { icon: <Tag size={13} color="#8b5cf6" />, label: '单选' };
    case 'multiSelect':
      return { icon: <Tags size={13} color="#ec4899" />, label: '多选' };
    case 'date':
      return { icon: <Calendar size={13} color="#f59e0b" />, label: '日期' };
    case 'checkbox':
      return { icon: <CheckSquare size={13} color="#06b6d4" />, label: '勾选' };
    case 'rating':
      return { icon: <Star size={13} color="#eab308" />, label: '评分' };
    case 'progress':
      return { icon: <BarChart2 size={13} color="#3b82f6" />, label: '进度' };
    case 'link':
      return { icon: <Link size={13} color="#6366f1" />, label: '超链接' };
  }
}
