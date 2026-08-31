// NoteBoard 斜杠命令系统
// 采用悬展式（Flyout Submenu）二级子菜单（鼠标悬停/键盘右键直接在侧边展开，非点击跳转）
// 「清除格式」直接置于一级常用目录
// 兼顾全局模糊搜索直达能力（如直接输入 /h2, /ts, /todo, /bg 快速匹配执行）
// 详见 docs/09-开发路线图.md 8.7

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionProps } from '@tiptap/suggestion';
import type { Editor, Range } from '@tiptap/core';
import {
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  CheckSquare,
  Table as TableIcon,
  Code2,
  Quote,
  Minus,
  Image as ImageIcon,
  Sigma,
  Workflow,
  Info,
  Lightbulb,
  AlertCircle,
  AlertTriangle,
  Flame,
  Link2,
  Calendar,
  Clock,
  Pilcrow,
  RemoveFormatting,
  ChevronRight,
  Boxes,
  BarChart3,
} from 'lucide-react';
import { insertLocalImageWithDialog } from './imagePaste';
import { useWindowStore } from '../../stores/windowStore';
import { emit } from '../../core/emitter';
import { INFOGRAPHIC_TEMPLATES } from '../infographic/infographicTemplates';

/** 叶子具体执行命令项 */
export interface LeafCommandItem {
  id: string;
  label: string;
  description: string;
  groupId?: string;
  groupLabel?: string;
  aliases?: string[];
  shortcutHint?: string;
  icon: ReactNode;
  keywords?: string;
  action: (editor: Editor, range: Range) => void;
}

/** 一级分组定义 */
export interface GroupCommandItem {
  id: string;
  label: string;
  description: string;
  shortcutHint?: string;
  icon: ReactNode;
  isGroup: true;
  children: LeafCommandItem[];
}

export type MenuEntry =
  | { type: 'group'; item: GroupCommandItem }
  | { type: 'leaf'; item: LeafCommandItem };

// ── 叶子命令定义 ──

const HEADING_LEAFS: LeafCommandItem[] = [
  {
    id: 'heading1',
    label: '一级标题 (H1)',
    description: '最高层级大标题',
    groupId: 'headings',
    groupLabel: '标题',
    shortcutHint: '/h1',
    icon: <Heading1 size={17} />,
    aliases: ['h1', '1', 'biaoti1', 'bt1', 'heading1', 'title', 'yjbt'],
    keywords: '标题 一级标题 heading h1 biaoti yjbt',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'heading2',
    label: '二级标题 (H2)',
    description: '主要章节标题',
    groupId: 'headings',
    groupLabel: '标题',
    shortcutHint: '/h2',
    icon: <Heading2 size={17} />,
    aliases: ['h2', '2', 'biaoti2', 'bt2', 'heading2', 'subtitle', 'ejbt'],
    keywords: '标题 二级标题 heading h2 biaoti ejbt',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'heading3',
    label: '三级标题 (H3)',
    description: '小节与子要点标题',
    groupId: 'headings',
    groupLabel: '标题',
    shortcutHint: '/h3',
    icon: <Heading3 size={17} />,
    aliases: ['h3', '3', 'biaoti3', 'bt3', 'heading3', 'sjbt'],
    keywords: '标题 三级标题 heading h3 biaoti sjbt',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'heading4',
    label: '四级标题 (H4)',
    description: '子小节标题',
    groupId: 'headings',
    groupLabel: '标题',
    shortcutHint: '/h4',
    icon: <Heading4 size={17} />,
    aliases: ['h4', '4', 'biaoti4', 'bt4', 'heading4'],
    keywords: '标题 四级标题 heading h4 biaoti',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 4 }).run(),
  },
  {
    id: 'heading5',
    label: '五级标题 (H5)',
    description: '细分内容标题',
    groupId: 'headings',
    groupLabel: '标题',
    shortcutHint: '/h5',
    icon: <Heading5 size={17} />,
    aliases: ['h5', '5', 'biaoti5', 'bt5', 'heading5'],
    keywords: '标题 五级标题 heading h5 biaoti',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 5 }).run(),
  },
  {
    id: 'heading6',
    label: '六级标题 (H6)',
    description: '最低层级标题',
    groupId: 'headings',
    groupLabel: '标题',
    shortcutHint: '/h6',
    icon: <Heading6 size={17} />,
    aliases: ['h6', '6', 'biaoti6', 'bt6', 'heading6'],
    keywords: '标题 六级标题 heading h6 biaoti',
    action: (editor, range) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 6 }).run(),
  },
];

const LIST_LEAFS: LeafCommandItem[] = [
  {
    id: 'taskList',
    label: '任务待办列表',
    description: '带有可勾选框的任务清单',
    groupId: 'lists',
    groupLabel: '列表',
    shortcutHint: '/todo',
    icon: <CheckSquare size={17} />,
    aliases: ['renwu', 'rw', 'todo', 'task', 'checkbox', 'daiban', 'db'],
    keywords: '任务 待办 task todo checkbox renwu daiban',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: 'bulletList',
    label: '无序列表',
    description: '实心圆点项目符号列表',
    groupId: 'lists',
    groupLabel: '列表',
    shortcutHint: '/list',
    icon: <List size={17} />,
    aliases: ['wuxu', 'wx', 'list', 'bullet', 'ul', 'liebiao', 'lb'],
    keywords: '列表 无序列表 list bullet ul wuxu',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    label: '有序列表',
    description: '1, 2, 3 数字递增编号列表',
    groupId: 'lists',
    groupLabel: '列表',
    shortcutHint: '/ol',
    icon: <ListOrdered size={17} />,
    aliases: ['youxu', 'yx', 'list', 'ordered', 'ol', 'shuzi'],
    keywords: '列表 有序列表 编号 list ordered ol youxu',
    action: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
];

const ALERT_LEAFS: LeafCommandItem[] = [
  {
    id: 'alertNote',
    label: 'Note 提示块',
    description: '用于补充说明或背景信息',
    groupId: 'alerts',
    groupLabel: '提示块',
    shortcutHint: '/note',
    icon: <Info size={17} color="#3b82f6" />,
    aliases: ['note', 'tishi', 'ts', 'info', 'alert'],
    keywords: '提示 note alert info tishi ts',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'githubAlert', attrs: { kind: 'note' }, content: [{ type: 'paragraph' }] }).run();
    },
  },
  {
    id: 'alertTip',
    label: 'Tip 技巧建议',
    description: '提供操作技巧与最佳实践',
    groupId: 'alerts',
    groupLabel: '提示块',
    shortcutHint: '/tip',
    icon: <Lightbulb size={17} color="#10b981" />,
    aliases: ['tip', 'jianyi', 'jy', 'jiqiao', 'jq', 'alert'],
    keywords: '建议 技巧 tip jianyi jiqiao alert',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'githubAlert', attrs: { kind: 'tip' }, content: [{ type: 'paragraph' }] }).run();
    },
  },
  {
    id: 'alertImportant',
    label: 'Important 重要提示',
    description: '用户不应忽视的核心要点',
    groupId: 'alerts',
    groupLabel: '提示块',
    shortcutHint: '/important',
    icon: <AlertCircle size={17} color="#8b5cf6" />,
    aliases: ['important', 'zhongyao', 'zy', 'point', 'alert'],
    keywords: '重要 关键 important zhongyao zy alert',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'githubAlert', attrs: { kind: 'important' }, content: [{ type: 'paragraph' }] }).run();
    },
  },
  {
    id: 'alertWarning',
    label: 'Warning 警告块',
    description: '需要特别警惕的注意事项',
    groupId: 'alerts',
    groupLabel: '提示块',
    shortcutHint: '/warn',
    icon: <AlertTriangle size={17} color="#f59e0b" />,
    aliases: ['warning', 'warn', 'jinggao', 'jg', 'alert'],
    keywords: '警告 注意 warning alert warn jinggao jg',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'githubAlert', attrs: { kind: 'warning' }, content: [{ type: 'paragraph' }] }).run();
    },
  },
  {
    id: 'alertCaution',
    label: 'Caution 危险提示',
    description: '高风险操作或破坏性后果警示',
    groupId: 'alerts',
    groupLabel: '提示块',
    shortcutHint: '/caution',
    icon: <Flame size={17} color="#ef4444" />,
    aliases: ['caution', 'weixian', 'wx', 'danger', 'alert'],
    keywords: '危险 高危 caution danger weixian wx alert',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'githubAlert', attrs: { kind: 'caution' }, content: [{ type: 'paragraph' }] }).run();
    },
  },
];

const TABLE_LEAFS: LeafCommandItem[] = [
  {
    id: 'table',
    label: '表格 (3x3)',
    description: '插入 3 行 3 列标准数据表格',
    groupId: 'tables',
    groupLabel: '表格',
    shortcutHint: '/table',
    icon: <TableIcon size={17} />,
    aliases: ['biaoge', 'bg', 'table', 'grid', '3x3'],
    keywords: '表格 table grid biaoge bg',
    action: (editor, range) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'tableSmall',
    label: '表格 (2x2)',
    description: '插入 2 行 2 列紧凑表格',
    groupId: 'tables',
    groupLabel: '表格',
    shortcutHint: '/table2',
    icon: <TableIcon size={17} />,
    aliases: ['biaoge2', 'bg2', 'table2', '2x2'],
    keywords: '表格 紧凑表格 table small biaoge',
    action: (editor, range) => editor.chain().focus().deleteRange(range).insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(),
  },
  {
    id: 'tableLarge',
    label: '表格 (4x4)',
    description: '插入 4 行 4 列宽表格',
    groupId: 'tables',
    groupLabel: '表格',
    shortcutHint: '/table4',
    icon: <TableIcon size={17} />,
    aliases: ['biaoge4', 'bg4', 'table4', '4x4'],
    keywords: '表格 宽表格 table large 4x4 biaoge',
    action: (editor, range) => editor.chain().focus().deleteRange(range).insertTable({ rows: 4, cols: 4, withHeaderRow: true }).run(),
  },
];

const MATH_LEAFS: LeafCommandItem[] = [
  {
    id: 'mathInline',
    label: '行内公式 ($...$)',
    description: '嵌入行内的 KaTeX 数学公式',
    groupId: 'math',
    groupLabel: '公式与图表',
    shortcutHint: '/math',
    icon: <Sigma size={17} />,
    aliases: ['gongshi', 'gs', 'math', 'latex', 'inline', 'katex'],
    keywords: '公式 数学公式 math latex inline katex gongshi',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'mathInline', attrs: { latex: 'E=mc^2' } }).run();
    },
  },
  {
    id: 'mathBlock',
    label: '块级公式 ($$...$$)',
    description: '独立成段居中的 KaTeX 数学公式块',
    groupId: 'math',
    groupLabel: '公式与图表',
    shortcutHint: '/blockmath',
    icon: <Sigma size={17} />,
    aliases: ['kuaijigongshi', 'kjgs', 'math', 'latex', 'block', 'katex'],
    keywords: '块级公式 数学公式 math latex block katex',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'mathBlock', attrs: { latex: '' } }).run();
    },
  },
  {
    id: 'mermaid',
    label: 'Mermaid 图表',
    description: '流程图、时序图、状态图与类图等',
    groupId: 'math',
    groupLabel: '公式与图表',
    shortcutHint: '/mermaid',
    icon: <Workflow size={17} />,
    aliases: ['tubiao', 'tb', 'mermaid', 'diagram', 'chart', 'flowchart', 'tu'],
    keywords: '图表 流程图 mermaid diagram chart flowchart tubiao',
    action: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'mermaidBlock', attrs: { code: 'graph TD\n  A[开始] --> B[处理]\n  B --> C[完成]' } }).run();
    },
  },
  {
    id: 'infographic',
    label: 'Infographic 信息图',
    description: '指标看板、时间线、流程步骤、对比表与图表',
    groupId: 'math',
    groupLabel: '公式与图表',
    shortcutHint: '/info',
    icon: <BarChart3 size={17} color="#3b82f6" />,
    aliases: ['infographic', 'info', 'xinxitu', 'xxt', 'kpi', 'timeline', 'funnel', 'comparison'],
    keywords: '信息图 infographic info xinxitu 指标 看板 时间线 流程 对比 漏斗 象限',
    action: (editor, range) => {
      const defaultTmpl = INFOGRAPHIC_TEMPLATES[0]?.code || 'type: metric-cards\ntitle: 核心指标看板';
      editor.chain().focus().deleteRange(range).insertContent({ type: 'infographicBlock', attrs: { code: defaultTmpl } }).run();
    },
  },
];

const INFOGRAPHIC_LEAFS: LeafCommandItem[] = INFOGRAPHIC_TEMPLATES.map((tmpl) => ({
  id: `info-${tmpl.id}`,
  label: tmpl.label,
  description: tmpl.description,
  groupId: 'infographics',
  groupLabel: '信息图模板',
  shortcutHint: `/info-${tmpl.id.slice(0, 4)}`,
  icon: <BarChart3 size={17} color="#3b82f6" />,
  aliases: ['info', 'infographic', 'xxt', tmpl.id],
  keywords: `信息图 ${tmpl.label} ${tmpl.description} infographic info`,
  action: (editor, range) => {
    editor.chain().focus().deleteRange(range).insertContent({ type: 'infographicBlock', attrs: { code: tmpl.code } }).run();
  },
}));

const DATETIME_LEAFS: LeafCommandItem[] = [
  {
    id: 'date',
    label: '插入当前日期',
    description: '插入当前日期（如 ' + new Date().toISOString().slice(0, 10) + '）',
    groupId: 'datetime',
    groupLabel: '日期时间',
    shortcutHint: '/date',
    icon: <Calendar size={17} />,
    aliases: ['riqi', 'rq', 'date', 'today', 'jinri'],
    keywords: '日期 今天 riqi rq date today',
    action: (editor, range) => {
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      editor.chain().focus().deleteRange(range).insertContent(dateStr).run();
    },
  },
  {
    id: 'time',
    label: '插入当前时间',
    description: '插入当前时刻（如 ' + new Date().toTimeString().slice(0, 8) + '）',
    groupId: 'datetime',
    groupLabel: '日期时间',
    shortcutHint: '/time',
    icon: <Clock size={17} />,
    aliases: ['shijian', 'sj', 'time', 'now', 'xiansi'],
    keywords: '时间 时刻 time now shijian sj',
    action: (editor, range) => {
      const d = new Date();
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      editor.chain().focus().deleteRange(range).insertContent(timeStr).run();
    },
  },
  {
    id: 'datetime',
    label: '插入日期与时间',
    description: '插入完整日期时刻（如 ' + new Date().toISOString().slice(0, 10) + ' ' + new Date().toTimeString().slice(0, 8) + '）',
    groupId: 'datetime',
    groupLabel: '日期时间',
    shortcutHint: '/now',
    icon: <Calendar size={17} />,
    aliases: ['riqishijian', 'rqsj', 'datetime', 'now', 'dt'],
    keywords: '日期时间 日期 时间 datetime now riqishijian rqsj',
    action: (editor, range) => {
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      editor.chain().focus().deleteRange(range).insertContent(`${dateStr} ${timeStr}`).run();
    },
  },
];

/** 独立常驻执行项定义 */
const CODE_BLOCK_LEAF: LeafCommandItem = {
  id: 'codeBlock',
  label: '代码块',
  description: '带语法高亮与语言切换的多行代码框',
  shortcutHint: '/code',
  icon: <Code2 size={17} />,
  aliases: ['daima', 'daimakuai', 'dm', 'code', 'codeblock', 'pre', 'js', 'ts', 'py', 'sql', 'json', 'cpp'],
  keywords: '代码 代码块 code codeblock daima dm',
  action: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
};

const BLOCKQUOTE_LEAF: LeafCommandItem = {
  id: 'blockquote',
  label: '引用块 (Quote)',
  description: '插入引述文字或要点摘录',
  shortcutHint: '/quote',
  icon: <Quote size={17} />,
  aliases: ['yinyong', 'yy', 'quote', 'blockquote'],
  keywords: '引用 quote blockquote yinyong yy',
  action: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
};

const IMAGE_LOCAL_LEAF: LeafCommandItem = {
  id: 'image',
  label: '插入本地图片',
  description: '选择本地图片并自动保存到文档 /img 目录',
  shortcutHint: '/img',
  icon: <ImageIcon size={17} />,
  aliases: ['tupian', 'tp', 'image', 'img', 'photo', 'picture', 'bendi'],
  keywords: '图片 插入图片 本地图片 image img photo picture tupian tp bendi',
  action: (editor, range) => {
    editor.chain().focus().deleteRange(range).run();
    const activeKey = useWindowStore.getState().activeKey;
    if (activeKey) {
      insertLocalImageWithDialog(editor, activeKey);
    }
  },
};

const IMAGE_URL_LEAF: LeafCommandItem = {
  id: 'imageUrl',
  label: '插入网络图片',
  description: '通过在线网络 URL 插入图片',
  shortcutHint: '/urlimg',
  icon: <ImageIcon size={17} style={{ opacity: 0.7 }} />,
  aliases: ['urltp', 'wangluotp', 'imgurl', 'imageurl'],
  keywords: '网络图片 图片链接 image url img photo wangluo',
  action: (editor, range) => {
    const url = window.prompt('请输入图片网络 URL:');
    if (url) {
      editor.chain().focus().deleteRange(range).setImage({ src: url }).run();
    }
  },
};

const LINK_LEAF: LeafCommandItem = {
  id: 'link',
  label: '插入超链接',
  description: '插入网页链接或文档相对链接',
  shortcutHint: '/link',
  icon: <Link2 size={17} color="#3b82f6" />,
  aliases: ['link', 'url', 'lianjie', 'lj', 'chaolianjie', 'clj', 'http', 'https'],
  keywords: '超链接 链接 link url lianjie http https chaolianjie lj',
  action: (editor, range) => {
    editor.chain().focus().deleteRange(range).run();
    const activeKey = useWindowStore.getState().activeKey;
    if (activeKey) {
      emit('open-link-modal', { key: activeKey });
    }
  },
};

const PARAGRAPH_LEAF: LeafCommandItem = {
  id: 'paragraph',
  label: '正文段落',
  description: '普通纯文本段落',
  shortcutHint: '/p',
  icon: <Pilcrow size={17} />,
  aliases: ['zw', 'zhengwen', 'p', 'paragraph', 'text'],
  keywords: '正文 段落 text paragraph zhengwen zw',
  action: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
};

const DIVIDER_LEAF: LeafCommandItem = {
  id: 'divider',
  label: '水平分割线',
  description: '插入 --- 横向视觉分隔线',
  shortcutHint: '/hr',
  icon: <Minus size={17} />,
  aliases: ['fengexian', 'fgx', 'fg', 'divider', 'hr', 'horizontal', 'line'],
  keywords: '分割线 分割 华丽分割线 divider hr fengexian',
  action: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
};

const CLEAR_FORMAT_LEAF: LeafCommandItem = {
  id: 'clearFormat',
  label: '清除格式',
  description: '清除文本样式、高亮与多余格式',
  shortcutHint: '/clear',
  icon: <RemoveFormatting size={17} color="#ef4444" />,
  aliases: ['qingchu', 'qc', 'clear', 'clean', 'plain'],
  keywords: '清除格式 清空样式 clear clean format qingchu qc',
  action: (editor, range) => editor.chain().focus().deleteRange(range).unsetAllMarks().run(),
};

/** 一级菜单分组配置列表 */
const ROOT_GROUPS: GroupCommandItem[] = [
  {
    id: 'headings',
    label: '标题层级 (H1~H6)',
    description: '包含一级到六级标题',
    shortcutHint: '/h1~h6',
    icon: <Heading size={17} />,
    isGroup: true,
    children: HEADING_LEAFS,
  },
  {
    id: 'lists',
    label: '列表类型',
    description: '任务清单、无序圆点与有序编号',
    shortcutHint: '/todo, /list',
    icon: <List size={17} />,
    isGroup: true,
    children: LIST_LEAFS,
  },
  {
    id: 'alerts',
    label: 'GitHub 提示块',
    description: 'Note, Tip, Important, Warning, Caution',
    shortcutHint: '/note, /tip',
    icon: <Boxes size={17} color="#3b82f6" />,
    isGroup: true,
    children: ALERT_LEAFS,
  },
  {
    id: 'tables',
    label: '表格数据',
    description: '标准 3x3 表格、紧凑 2x2 与宽表格 4x4',
    shortcutHint: '/table',
    icon: <TableIcon size={17} />,
    isGroup: true,
    children: TABLE_LEAFS,
  },
  {
    id: 'math',
    label: '公式与图表',
    description: 'KaTeX 数学公式与 Mermaid 流程图',
    shortcutHint: '/math, /tb',
    icon: <Workflow size={17} />,
    isGroup: true,
    children: MATH_LEAFS,
  },
  {
    id: 'infographics',
    label: '信息图模板',
    description: '指标看板、时间线、步骤流程、对比表与漏斗',
    shortcutHint: '/info',
    icon: <BarChart3 size={17} color="#3b82f6" />,
    isGroup: true,
    children: INFOGRAPHIC_LEAFS,
  },
  {
    id: 'datetime',
    label: '日期时间',
    description: '当前日期、当前时刻、日期与时刻',
    shortcutHint: '/date, /time',
    icon: <Calendar size={17} />,
    isGroup: true,
    children: DATETIME_LEAFS,
  },
];

/** 全量叶子命令扁平池（优先级：标题 > 列表 > 代码块 > 提示块 > 引用块 > 表格 > 公式 > 信息图 > 图片 > 超链接 > 日期时间 > 正文 > 分割线 > 清除格式） */
const ALL_LEAFS: LeafCommandItem[] = [
  ...HEADING_LEAFS,
  ...LIST_LEAFS,
  CODE_BLOCK_LEAF,
  ...ALERT_LEAFS,
  BLOCKQUOTE_LEAF,
  ...TABLE_LEAFS,
  ...MATH_LEAFS,
  ...INFOGRAPHIC_LEAFS,
  IMAGE_LOCAL_LEAF,
  IMAGE_URL_LEAF,
  LINK_LEAF,
  ...DATETIME_LEAFS,
  PARAGRAPH_LEAF,
  DIVIDER_LEAF,
  CLEAR_FORMAT_LEAF,
];

/** 默认根级菜单项（严格遵循优先级：标题 > 列表 > 代码块 > GitHub提示 > 引用块 > 表格 > 公式与图表 > 本地图片 > 网络图片 > 超链接 > 日期时间 > 正文 > 分割线 > 清除格式） */
const ROOT_MENU_ENTRIES: MenuEntry[] = [
  { type: 'group', item: ROOT_GROUPS.find((g) => g.id === 'headings')! },
  { type: 'group', item: ROOT_GROUPS.find((g) => g.id === 'lists')! },
  { type: 'leaf', item: CODE_BLOCK_LEAF },
  { type: 'group', item: ROOT_GROUPS.find((g) => g.id === 'alerts')! },
  { type: 'leaf', item: BLOCKQUOTE_LEAF },
  { type: 'group', item: ROOT_GROUPS.find((g) => g.id === 'tables')! },
  { type: 'group', item: ROOT_GROUPS.find((g) => g.id === 'math')! },
  { type: 'leaf', item: IMAGE_LOCAL_LEAF },
  { type: 'leaf', item: IMAGE_URL_LEAF },
  { type: 'leaf', item: LINK_LEAF },
  { type: 'group', item: ROOT_GROUPS.find((g) => g.id === 'datetime')! },
  { type: 'leaf', item: PARAGRAPH_LEAF },
  { type: 'leaf', item: DIVIDER_LEAF },
  { type: 'leaf', item: CLEAR_FORMAT_LEAF },
];

/** 全局打平搜索逻辑 */
function searchLeafCommands(query: string): LeafCommandItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return ALL_LEAFS;

  const scored: { item: LeafCommandItem; score: number }[] = [];

  for (const item of ALL_LEAFS) {
    const label = item.label.toLowerCase();
    const desc = item.description.toLowerCase();
    const groupLabel = (item.groupLabel ?? '').toLowerCase();
    const keywords = (item.keywords ?? '').toLowerCase();
    const aliases = (item.aliases ?? []).map((a) => a.toLowerCase());

    let score = 0;
    if (label.startsWith(q)) score = 160;
    else if (aliases.some((a) => a === q)) score = 150;
    else if (aliases.some((a) => a.startsWith(q))) score = 120;
    else if (label.includes(q)) score = 100 - label.indexOf(q);
    else if (aliases.some((a) => a.includes(q))) score = 80;
    else if (groupLabel.startsWith(q)) score = 75;
    else if (keywords.includes(q)) score = 70;
    else if (desc.includes(q)) score = 50;

    if (score > 0) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** 斜杠命令菜单组件（支持右键风格的悬展式二级菜单） */
function SlashMenu({
  editor,
  range,
  query,
}: SuggestionProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // 当前鼠标或键盘悬展的二级分组 ID
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  // 焦点是否位于悬展二级子菜单内部
  const [isFocusInSubmenu, setIsFocusInSubmenu] = useState(false);
  const [subSelectedIndex, setSubSelectedIndex] = useState(0);
  // 二级子菜单是否因右侧空间不足而向左翻转
  const [flipSubmenuLeft, setFlipSubmenuLeft] = useState(false);
  // 二级子菜单的垂直布局：top 对齐到当前选中/悬展的一级项，maxHeight 限制以不撑出视口
  const [submenuLayout, setSubmenuLayout] = useState<{ top: number; maxHeight: number }>({
    top: 0,
    maxHeight: 370,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const subItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 是否处于搜索模式
  const isSearching = Boolean(query && query.trim().length > 0);

  // 计算当前显示的根项或搜索项
  const displayedEntries: MenuEntry[] = isSearching
    ? searchLeafCommands(query).map((leaf) => ({ type: 'leaf', item: leaf }))
    : ROOT_MENU_ENTRIES;

  // 获取当前悬展的分组对象
  const activeGroup = ROOT_GROUPS.find((g) => g.id === hoveredGroupId);

  // 重算二级子菜单的垂直位置与最大高度：让子菜单顶部对齐到当前选中/悬展的一级项，
  // 同时根据选中项之下到视口底部（避开状态栏）的剩余空间限制 maxHeight，
  // 避免选中项靠下时子菜单被裁剪或挤出底部。水平方向顺便判断是否需要向左翻转。
  useEffect(() => {
    if (!activeGroup || !containerRef.current) return;
    const activeEl = itemRefs.current[selectedIndex];
    if (!activeEl) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const itemRect = activeEl.getBoundingClientRect();

    // 水平：右侧空间不足以容纳子菜单（290 + 12 间距）则左翻
    const spaceRight = window.innerWidth - containerRect.right;
    setFlipSubmenuLeft(spaceRight < 290 + 12);

    // 垂直：让子菜单顶部与选中项顶部对齐，最小不低于容器顶部
    const offsetTop = Math.max(0, Math.round(itemRect.top - containerRect.top));

    // 下方的可用空间 = 视口底部 - 状态栏 - 边距 - 选中项在视口中的 top
    const viewportHeight = window.innerHeight;
    const statusBarHeight = 36;
    const bottomPadding = 8;
    const spaceBelow = viewportHeight - statusBarHeight - bottomPadding - itemRect.top;
    // 至少保留 180px 高度防止只剩一截窄条；上限仍维持原 370
    const maxHeight = Math.max(180, Math.min(370, Math.floor(spaceBelow)));

    setSubmenuLayout({ top: offsetTop, maxHeight });
  }, [activeGroup, selectedIndex]);

  // query 变化时重置
  useEffect(() => {
    setSelectedIndex(0);
    setHoveredGroupId(null);
    setIsFocusInSubmenu(false);
    setSubSelectedIndex(0);
  }, [query]);

  // 主列表选中项滚动定位
  useEffect(() => {
    if (!isFocusInSubmenu) {
      const currentEl = itemRefs.current[selectedIndex];
      if (currentEl) {
        currentEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, isFocusInSubmenu]);

  // 子列表选中项滚动定位
  useEffect(() => {
    if (isFocusInSubmenu) {
      const subEl = subItemRefs.current[subSelectedIndex];
      if (subEl) {
        subEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [subSelectedIndex, isFocusInSubmenu]);

  // 执行具体叶子项
  const executeLeaf = useCallback(
    (leaf: LeafCommandItem) => {
      leaf.action(editor, range);
    },
    [editor, range],
  );

  // 键盘导航
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (displayedEntries.length === 0) return;

      if (isFocusInSubmenu && activeGroup) {
        // ── 焦点在二级子菜单中 ──
        const subCount = activeGroup.children.length;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSubSelectedIndex((i) => (i + 1) % subCount);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSubSelectedIndex((i) => (i - 1 + subCount) % subCount);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const targetLeaf = activeGroup.children[subSelectedIndex];
          if (targetLeaf) {
            executeLeaf(targetLeaf);
          }
        } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
          e.preventDefault();
          setIsFocusInSubmenu(false);
        }
      } else {
        // ── 焦点在一级主菜单中 ──
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const nextIdx = (selectedIndex + 1) % displayedEntries.length;
          setSelectedIndex(nextIdx);
          const entry = displayedEntries[nextIdx];
          if (entry && entry.type === 'group') {
            setHoveredGroupId(entry.item.id);
            setSubSelectedIndex(0);
          } else {
            setHoveredGroupId(null);
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prevIdx = (selectedIndex - 1 + displayedEntries.length) % displayedEntries.length;
          setSelectedIndex(prevIdx);
          const entry = displayedEntries[prevIdx];
          if (entry && entry.type === 'group') {
            setHoveredGroupId(entry.item.id);
            setSubSelectedIndex(0);
          } else {
            setHoveredGroupId(null);
          }
        } else if (e.key === 'ArrowRight') {
          const entry = displayedEntries[selectedIndex];
          if (entry && entry.type === 'group') {
            e.preventDefault();
            setHoveredGroupId(entry.item.id);
            setIsFocusInSubmenu(true);
            setSubSelectedIndex(0);
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const entry = displayedEntries[selectedIndex];
          if (!entry) return;
          if (entry.type === 'group') {
            // 回车展开并进入二级子菜单
            setHoveredGroupId(entry.item.id);
            setIsFocusInSubmenu(true);
            setSubSelectedIndex(0);
          } else {
            // 执行单项
            executeLeaf(entry.item);
          }
        }
      }
    };

    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [displayedEntries, selectedIndex, isFocusInSubmenu, activeGroup, subSelectedIndex, executeLeaf]);

  if (displayedEntries.length === 0) {
    return (
      <div
        style={{
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
          borderRadius: 8,
          boxShadow: '0 8px 24px -4px rgba(0, 0, 0, 0.15)',
          padding: '12px 16px',
          fontSize: 13,
          color: 'var(--editor-text-secondary, #64748b)',
        }}
      >
        未找到匹配的命令
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
      }}
    >
      {/* ── 一级主菜单面板 ── */}
      <div
        style={{
          background: 'var(--editor-surface, #ffffff)',
          border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
          borderRadius: 8,
          boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.18), 0 3px 8px -2px rgba(0, 0, 0, 0.1)',
          backdropFilter: 'blur(10px)',
          overflow: 'hidden',
          width: 300,
          maxHeight: 370,
          display: 'flex',
          flexDirection: 'column',
          zIndex: 10000,
        }}
      >
        <div
          style={{
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--editor-text-secondary, #64748b)',
            borderBottom: '1px solid var(--editor-border, rgba(0,0,0,0.06))',
            background: 'var(--editor-bg, rgba(0,0,0,0.02))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{isSearching ? `搜索命令: "${query}"` : '插入块或命令'}</span>
          <span style={{ fontSize: 10, opacity: 0.8 }}>↑↓ 移动 · → 伸展子项</span>
        </div>

        <div
          style={{
            overflowY: 'auto',
            padding: '4px',
            maxHeight: 330,
          }}
        >
          {displayedEntries.map((entry, index) => {
            const isSelected = index === selectedIndex && !isFocusInSubmenu;
            const isGroup = entry.type === 'group';
            const isGroupHovered = isGroup && hoveredGroupId === entry.item.id;
            const { item } = entry;

            return (
              <button
                key={item.id}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                aria-label={item.shortcutHint ? `快捷触发词：${item.shortcutHint}` : undefined}
                onMouseEnter={() => {
                  setSelectedIndex(index);
                  if (isGroup) {
                    setHoveredGroupId(item.id);
                    setSubSelectedIndex(0);
                  } else {
                    setHoveredGroupId(null);
                  }
                  setIsFocusInSubmenu(false);
                }}
                onClick={() => {
                  if (isGroup) {
                    setHoveredGroupId(item.id);
                    setIsFocusInSubmenu(true);
                    setSubSelectedIndex(0);
                  } else {
                    executeLeaf(item as LeafCommandItem);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '7px 10px',
                  textAlign: 'left',
                  border: 'none',
                  background:
                    isSelected || isGroupHovered
                      ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                      : 'transparent',
                  borderRadius: 6,
                  color: 'var(--editor-text, #1e293b)',
                  cursor: 'pointer',
                  transition: 'background 100ms ease',
                  userSelect: 'none',
                }}
              >
                {/* 图标 */}
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 6,
                    background:
                      isSelected || isGroupHovered
                        ? 'var(--editor-surface, #ffffff)'
                        : 'var(--editor-bg, rgba(0,0,0,0.04))',
                    border: '1px solid var(--editor-border, rgba(0,0,0,0.08))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color:
                      isSelected || isGroupHovered
                        ? 'var(--accent-500, #3b82f6)'
                        : 'var(--editor-text-secondary, #475569)',
                    flexShrink: 0,
                  }}
                >
                  {item.icon}
                </div>

                {/* 文本 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: 13,
                      fontWeight: 500,
                      lineHeight: 1.3,
                    }}
                  >
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.label}
                    </span>
                    {!isGroup && 'groupLabel' in item && item.groupLabel && isSearching && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: '1px 4px',
                          borderRadius: 3,
                          background: 'rgba(59, 130, 246, 0.1)',
                          color: 'var(--accent-500, #3b82f6)',
                          marginLeft: 6,
                          flexShrink: 0,
                        }}
                      >
                        {item.groupLabel}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--editor-text-secondary, #64748b)',
                      lineHeight: 1.2,
                      marginTop: 1,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.description}
                  </div>
                </div>

                {/* 快捷斜杠触发命令优雅 Badge */}
                {item.shortcutHint && (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      padding: '2px 6px',
                      borderRadius: 4,
                      background:
                        isSelected || isGroupHovered
                          ? 'rgba(59, 130, 246, 0.15)'
                          : 'var(--editor-bg, rgba(0, 0, 0, 0.05))',
                      color:
                        isSelected || isGroupHovered
                          ? 'var(--accent-500, #3b82f6)'
                          : 'var(--editor-text-secondary, #64748b)',
                      fontWeight: 500,
                      flexShrink: 0,
                      letterSpacing: '0.01em',
                      transition: 'all 120ms ease',
                    }}
                  >
                    {item.shortcutHint}
                  </span>
                )}

                {/* 悬展箭头 */}
                {isGroup && (
                  <ChevronRight
                    size={15}
                    style={{
                      color:
                        isSelected || isGroupHovered
                          ? 'var(--accent-500, #3b82f6)'
                          : 'var(--editor-text-secondary, #94a3b8)',
                      flexShrink: 0,
                      marginLeft: -2,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 伸展式二级子菜单面板 (Flyout Submenu) ── */}
      {!isSearching && activeGroup && (
        <div
          onMouseEnter={() => setIsFocusInSubmenu(true)}
          style={{
            position: 'absolute',
            top: submenuLayout.top,
            ...(flipSubmenuLeft
              ? { right: 'calc(100% + 6px)' }
              : { left: 'calc(100% + 6px)' }),
            width: 290,
            maxHeight: submenuLayout.maxHeight,
            background: 'var(--editor-surface, #ffffff)',
            border: '1px solid var(--editor-border, rgba(0,0,0,0.12))',
            borderRadius: 8,
            boxShadow: '0 10px 30px -4px rgba(0, 0, 0, 0.2), 0 3px 8px -2px rgba(0, 0, 0, 0.08)',
            backdropFilter: 'blur(10px)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 10001,
          }}
        >
          <div
            style={{
              padding: '6px 10px',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--accent-500, #3b82f6)',
              borderBottom: '1px solid var(--editor-border, rgba(0,0,0,0.06))',
              background: 'var(--editor-bg, rgba(0,0,0,0.02))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>{activeGroup.label}</span>
            <span style={{ fontSize: 10, color: 'var(--editor-text-secondary, #64748b)' }}>
              {activeGroup.children.length} 个选项
            </span>
          </div>

          <div
            style={{
              overflowY: 'auto',
              padding: '4px',
              flex: 1,
              minHeight: 0,
            }}
          >
            {activeGroup.children.map((subLeaf, subIdx) => {
              const isSubSelected = isFocusInSubmenu && subIdx === subSelectedIndex;

              return (
                <button
                  key={subLeaf.id}
                  ref={(el) => {
                    subItemRefs.current[subIdx] = el;
                  }}
                  type="button"
                  aria-label={subLeaf.shortcutHint ? `快捷触发词：${subLeaf.shortcutHint}` : undefined}
                  onMouseEnter={() => {
                    setIsFocusInSubmenu(true);
                    setSubSelectedIndex(subIdx);
                  }}
                  onClick={() => executeLeaf(subLeaf)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '7px 10px',
                    textAlign: 'left',
                    border: 'none',
                    background: isSubSelected
                      ? 'var(--editor-selection-background, rgba(59, 130, 246, 0.12))'
                      : 'transparent',
                    borderRadius: 6,
                    color: 'var(--editor-text, #1e293b)',
                    cursor: 'pointer',
                    transition: 'background 100ms ease',
                    userSelect: 'none',
                  }}
                >
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 5,
                      background: isSubSelected
                        ? 'var(--editor-surface, #ffffff)'
                        : 'var(--editor-bg, rgba(0,0,0,0.04))',
                      border: '1px solid var(--editor-border, rgba(0,0,0,0.08))',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: isSubSelected
                        ? 'var(--accent-500, #3b82f6)'
                        : 'var(--editor-text-secondary, #475569)',
                      flexShrink: 0,
                    }}
                  >
                    {subLeaf.icon}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        lineHeight: 1.3,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {subLeaf.label}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--editor-text-secondary, #64748b)',
                        lineHeight: 1.2,
                        marginTop: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {subLeaf.description}
                    </div>
                  </div>

                  {/* 二级菜单快捷斜杠触发命令优雅 Badge */}
                  {subLeaf.shortcutHint && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: isSubSelected
                          ? 'rgba(59, 130, 246, 0.15)'
                          : 'var(--editor-bg, rgba(0, 0, 0, 0.05))',
                        color: isSubSelected
                          ? 'var(--accent-500, #3b82f6)'
                          : 'var(--editor-text-secondary, #64748b)',
                        fontWeight: 500,
                        flexShrink: 0,
                        letterSpacing: '0.01em',
                        transition: 'all 120ms ease',
                      }}
                    >
                      {subLeaf.shortcutHint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 斜杠命令 suggestion 配置 */
export const slashSuggestion = {
  char: '/',
  items: ({ query }: { query: string }) => {
    return searchLeafCommands(query).map((i) => ({ label: i.label, id: i.id }));
  },
  render: () => {
    let component: ReactRenderer | null = null;
    let popup: HTMLElement | null = null;

    // 精确计算斜杠菜单弹出位置，自动避开底部状态栏与顶部工具栏
    const updatePosition = (props: SuggestionProps) => {
      if (!props.clientRect || !popup) return;
      const rect = props.clientRect();
      if (!rect) return;

      const menuWidth = 300;
      const submenuWidth = 270;
      const totalWidth = menuWidth + 6 + submenuWidth; // ~576px
      const menuHeight = 370;
      const statusbarHeight = 36;
      const topbarHeight = 40;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // 1. 水平位置计算：优先跟随光标，若右侧空间不足则向左移动，确保二级子菜单完整显示
      let left = rect.left;
      if (left + totalWidth > windowWidth - 16) {
        left = Math.max(16, windowWidth - totalWidth - 16);
      }
      if (left < 16) {
        left = 16;
      }

      // 2. 垂直位置计算：判断下方是否有足够空间（扣除底部状态栏高度）
      const spaceBelow = windowHeight - statusbarHeight - rect.bottom - 8;
      const spaceAbove = rect.top - topbarHeight - 8;

      // 判断是否在光标上方展开：下方空间不足且上方空间更大时向上展开
      const isAbove = spaceBelow < menuHeight && (spaceAbove >= menuHeight || spaceAbove >= spaceBelow);

      if (isAbove) {
        // 向上展开：将底部锚定在光标上方 8px，使用 bottom 定位使筛选时内容变少自适应贴近光标
        popup.style.top = 'auto';
        popup.style.bottom = `${Math.round(windowHeight - rect.top + 8)}px`;
        const maxAvailableHeight = Math.max(100, spaceAbove);
        popup.style.maxHeight = `${Math.min(menuHeight, maxAvailableHeight)}px`;
      } else {
        // 向下展开：将顶部锚定在光标下方 8px，使用 top 定位
        popup.style.bottom = 'auto';
        popup.style.top = `${Math.round(rect.bottom + 8)}px`;
        const maxAvailableHeight = Math.max(100, spaceBelow);
        popup.style.maxHeight = `${Math.min(menuHeight, maxAvailableHeight)}px`;
      }

      popup.style.left = `${Math.round(left)}px`;
      popup.style.right = 'auto';
    };

    return {
      onStart: (props: SuggestionProps) => {
        component = new ReactRenderer(SlashMenu, {
          props,
          editor: props.editor,
        });

        if (props.clientRect && component.element) {
          popup = document.createElement('div');
          popup.style.position = 'fixed';
          popup.style.zIndex = '9999';
          updatePosition(props);
          popup.appendChild(component.element);
          document.body.appendChild(popup);
        }
      },
      onUpdate: (props: SuggestionProps) => {
        component?.updateProps(props);
        if (props.clientRect && popup) {
          updatePosition(props);
        }
      },
      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (props.event.key === 'Escape') {
          if (popup) {
            popup.remove();
            popup = null;
          }
          return true;
        }
        return false;
      },
      onExit: () => {
        if (popup) {
          popup.remove();
          popup = null;
        }
        component?.destroy();
        component = null;
      },
    };
  },
};


