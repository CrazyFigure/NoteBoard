// NoteBoard Infographic 开箱即用预设模板库

export interface InfographicTemplate {
  id: string;
  label: string;
  description: string;
  code: string;
}

export const INFOGRAPHIC_TEMPLATES: InfographicTemplate[] = [
  {
    id: 'metric-cards',
    label: '核心指标看板 (KPI Cards)',
    description: '展示关键运营指标、数值量级与增减趋势',
    code: `type: metric-cards
title: 核心运营与业务指标
data:
  - label: 日活跃用户 (DAU)
    value: "148,290"
    change: "+14.8%"
    trend: up
    color: blue
    desc: 同比上月增长超预期
  - label: 核心功能转化率
    value: "38.6%"
    change: "+3.2%"
    trend: up
    color: emerald
    desc: 新版本流转流程优化
  - label: 用户平均停留时长
    value: "26.5 min"
    change: "+1.8%"
    trend: up
    color: purple
    desc: 互动与协作频次提升
  - label: 客户端崩溃与异常率
    value: "0.02%"
    change: "-0.05%"
    trend: down
    color: green
    desc: 稳定性达到 99.98%`,
  },
  {
    id: 'timeline',
    label: '项目里程碑时间线 (Timeline)',
    description: '直观展示项目演进阶段、时间节点与达成状态',
    code: `type: timeline
title: NoteBoard 产品演进路线图
data:
  - label: 2026 Q1
    title: 架构底座与性能筑基
    desc: 完成多窗口状态同步与秒级冷启动优化
    status: done
    color: emerald
  - label: 2026 Q2
    title: 画板与可视化图形生态
    desc: 深度集成 Excalidraw、Mermaid 与 PlantUML
    status: done
    color: emerald
  - label: 2026 Q3
    title: 信息图与多维表格
    desc: 推出现代化 Infographic 渲染与 Bitable 表格
    status: active
    color: blue
  - label: 2026 Q4
    title: 开放插件市场与云端协作
    desc: 打造丰富扩展生态，全面提升生产力
    status: pending
    color: purple`,
  },
  {
    id: 'process',
    label: '业务流转与步骤图 (Process Steps)',
    description: '清晰呈现业务全流程各步骤与衔接关系',
    code: `type: process
title: 需求研发与交付标准化全流程
data:
  - title: 1. 调研与需求对齐
    desc: 收集用户核心反馈，梳理业务痛点与功能边界
    color: blue
  - title: 2. 交互与架构设计
    desc: 制定 UI 规范、数据模型与前后端通信契约
    color: purple
  - title: 3. 编码实施与单元测试
    desc: 高标准代码实现，单测全量覆盖与静态校验
    color: cyan
  - title: 4. 灰度发布与持续验证
    desc: 真实环境验证交付质量，收集指标与持续迭代
    color: emerald`,
  },
  {
    id: 'funnel',
    label: '用户转化与流转漏斗 (Funnel)',
    description: '展示用户在关键链路各阶段的留存与转化',
    code: `type: funnel
title: 新用户激活与转化漏斗分析
data:
  - label: 访问落地页
    value: "100,000"
    change: "100%"
    color: blue
  - label: 完成安装注册
    value: "68,500"
    change: "68.5%"
    color: cyan
  - label: 首次创建笔记/画板
    value: "45,200"
    change: "45.2%"
    color: purple
  - label: 次周深度留存活跃
    value: "32,800"
    change: "32.8%"
    color: emerald`,
  },
  {
    id: 'comparison',
    label: '方案与特性对比表 (Comparison)',
    description: '横向对比不同技术方案、产品版本或优劣势',
    code: `type: comparison
title: 架构方案与技术特性对比
groups:
  - name: NoteBoard 方案
    badge: 推荐
    highlight: true
    color: blue
    features:
      - name: 本地数据私有存储
        value: 100% 本地明文掌控
        included: true
      - name: 启动速度与资源占用
        value: < 200ms 秒级启动
        included: true
      - name: 多维表格支持
        value: 完整支持双向切换
        included: true
      - name: 离线无网可用性
        value: 纯本地完全离线
        included: true
  - name: 传统云笔记方案
    color: gray
    features:
      - name: 本地数据私有存储
        value: 依赖厂商云端服务器
        included: false
      - name: 启动速度与资源占用
        value: 较慢 (1~3s)
        included: false
      - name: 多维表格支持
        value: 部分支持或需付费
        included: false
      - name: 离线无网可用性
        value: 断网功能严重受限
        included: false`,
  },
  {
    id: 'quadrant',
    label: '四象限优先级矩阵 (Quadrant Matrix)',
    description: '按价值与紧急/难度等维度科学划分事务优先级',
    code: `type: quadrant
title: 产品功能规划四象限分析
quadrantXLabel: 实现难度 (从低到高)
quadrantYLabel: 业务价值 (从低到高)
quadrants:
  q1:
    title: 战略重点 (高价值/低难度)
    desc: 极具性价比，应优先投入实施
  q2:
    title: 核心攻坚 (高价值/高难度)
    desc: 关键技术壁垒，需做好长期规划
  q3:
    title: 斟酌优化 (低价值/低难度)
    desc: 顺手完善或作为快速小步迭代
  q4:
    title: 暂缓考虑 (低价值/高难度)
    desc: 投入产出比低，暂不予推进
points:
  - name: Infographic 信息图
    x: 35
    y: 85
    color: emerald
    desc: 高颜值 Markdown 扩展
  - name: 多维表格
    x: 45
    y: 90
    color: blue
    desc: 极大提升结构化数据管理效率
  - name: 快捷键增强
    x: 20
    y: 65
    color: cyan
    desc: 细微体验优化
  - name: 全量 3D 渲染引擎
    x: 85
    y: 25
    color: red
    desc: 偏离笔记核心主干`,
  },
  {
    id: 'chart',
    label: '轻量统计图表 (Chart)',
    description: '柱状图、环形饼图与多系列数据直观呈现',
    code: `type: chart
title: 各模块使用频次与活跃度分布
chart:
  chartType: bar
  categories:
    - Markdown 笔记
    - Excalidraw 画板
    - 多维表格
    - 思维导图
    - 流程图表
  series:
    - name: 日均创建量 (千篇)
      data: [86, 52, 43, 38, 29]
      color: blue
    - name: 导出与分享量 (千次)
      data: [64, 41, 35, 27, 21]
      color: emerald`,
  },
];
