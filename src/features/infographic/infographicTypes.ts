// NoteBoard Infographic 信息图核心类型定义
// 统一支持指标看板、时间线、流程步骤、对比矩阵、四象限与数据图表等多种信息图结构

export type InfographicType =
  | 'metric-cards'
  | 'timeline'
  | 'process'
  | 'funnel'
  | 'comparison'
  | 'quadrant'
  | 'chart'
  | 'list';

export type InfographicTheme = 'default' | 'modern' | 'minimal' | 'gradient';

/** 基础通用数据项定义 */
export interface InfographicItem {
  id?: string;
  name?: string;
  title?: string;
  label?: string;
  value?: string | number;
  description?: string;
  desc?: string;
  icon?: string;
  color?: string; // blue, green, purple, amber, red, cyan, emerald, etc.
  tag?: string;
  change?: string; // 如 "+12.5%", "-3.2%"
  trend?: 'up' | 'down' | 'neutral';
  status?: 'done' | 'active' | 'pending' | 'blocked';
  category?: string;
  score?: number;
  highlight?: boolean;
}

/** 对比组数据定义 */
export interface ComparisonGroup {
  name: string;
  badge?: string;
  highlight?: boolean;
  color?: string;
  features: Array<{
    name: string;
    value?: string | boolean;
    included?: boolean;
    note?: string;
  }>;
}

/** 象限数据定义 */
export interface QuadrantItem {
  name: string;
  desc?: string;
  x?: number; // 0 ~ 100
  y?: number; // 0 ~ 100
  quadrant?: 1 | 2 | 3 | 4; // 1: 右上, 2: 左上, 3: 左下, 4: 右下
  color?: string;
}

/** 数据图表配置与系列定义 */
export interface ChartConfig {
  chartType?: 'bar' | 'pie' | 'donut' | 'line' | 'radar';
  categories?: string[];
  series?: Array<{
    name: string;
    data: number[];
    color?: string;
  }>;
}

/** 完整 Infographic 数据结构 */
export interface InfographicData {
  type: InfographicType;
  title?: string;
  subtitle?: string;
  theme?: InfographicTheme;
  columns?: number;
  // 通用列表/卡片项
  data?: InfographicItem[];
  items?: InfographicItem[];
  // 对比结构
  groups?: ComparisonGroup[];
  // 象限结构
  quadrantXLabel?: string;
  quadrantYLabel?: string;
  quadrants?: {
    q1?: { title: string; desc?: string };
    q2?: { title: string; desc?: string };
    q3?: { title: string; desc?: string };
    q4?: { title: string; desc?: string };
  };
  points?: QuadrantItem[];
  // 图表结构
  chart?: ChartConfig;
}
