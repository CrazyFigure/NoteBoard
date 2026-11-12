// 设置中心的栏目元数据与设置搜索索引
// 页名、栏目可见性与可搜索设置项集中在此维护；每个条目的 id 对应页面上的 data-setting-id 锚点，
// 修改设置页布局时需同步本文件（test/components/settingsSearch.test.tsx 会校验锚点一致性）。

import { IS_MOBILE_UI, IS_NATIVE_MOBILE, IS_WEB } from '../../core/platform';
import { isAdmin, isMultiUser } from '../../features/account/accountState';
import { SUPPORTS_LOCAL_SEARCH } from '../../features/localSearch/localSearchStore';

export type TabType = 'account' | 'users' | 'general' | 'appearance' | 'typography' | 'editor' | 'file' | 'sync' | 'history' | 'plugins' | 'shortcuts' | 'about';

// 多端同步仅管理员可用：多用户部署中普通用户不显示同步页
export const SHOW_ACCOUNT = () => IS_WEB && isMultiUser();
export const SHOW_SYNC = () => !IS_WEB || !isMultiUser() || isAdmin();

// 托盘与全局快捷键仅原生桌面端可用（网页与移动端没有系统托盘）
export const SUPPORTS_SYSTEM_INTEGRATION = !IS_NATIVE_MOBILE && !IS_WEB;

/** 导航顺序即搜索结果的排序依据 */
export const TAB_ORDER: TabType[] = ['account', 'users', 'general', 'appearance', 'typography', 'editor', 'file', 'sync', 'history', 'plugins', 'shortcuts', 'about'];

/** 导航与搜索结果共用的页名 */
export const TAB_LABELS: Record<TabType, string> = {
  account: '账号',
  users: '用户管理',
  general: '通用',
  appearance: '外观',
  typography: '排版与字体',
  editor: '编辑器',
  file: '文件与保存',
  sync: '同步与备份',
  history: '历史记录',
  plugins: '插件和字体',
  shortcuts: '快捷键',
  about: '关于',
};

/** 栏目在当前平台 / 账号下是否展示 */
export function isTabVisible(tab: TabType): boolean {
  switch (tab) {
    case 'account': return SHOW_ACCOUNT();
    case 'users': return SHOW_ACCOUNT() && isAdmin();
    case 'sync': return SHOW_SYNC();
    // 移动端没有物理键盘快捷键
    case 'shortcuts': return !IS_MOBILE_UI;
    default: return true;
  }
}

export interface SettingsSearchEntry {
  /** 对应页面元素的 data-setting-id */
  id: string;
  tab: TabType;
  /** 所在卡片 / 分区名 */
  section: string;
  label: string;
  /** 同义词与相关词，提高命中率 */
  keywords?: string[];
  /** 平台不支持时不出现在搜索结果中 */
  available?: () => boolean;
}

const DESKTOP_ONLY = () => SUPPORTS_SYSTEM_INTEGRATION;
const NOT_MOBILE = () => !IS_MOBILE_UI;

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // 账号（网页多用户部署）
  { id: 'account', tab: 'account', section: '账号', label: '账号与密码', keywords: ['修改密码', '退出登录', '共享', '我的共享'] },
  { id: 'users', tab: 'users', section: '用户管理', label: '用户管理', keywords: ['新建用户', '停用', '重置密码', '删除用户'] },

  // 通用
  { id: 'closeToTray', tab: 'general', section: '窗口与托盘', label: '关闭按钮最小化到托盘', keywords: ['托盘', '后台', '关闭窗口', '最小化'], available: DESKTOP_ONLY },
  { id: 'restoreSession', tab: 'general', section: '启动与会话', label: '保留最近文件', keywords: ['启动', '恢复标签', '会话', '上次打开'] },
  { id: 'restoreReadingPosition', tab: 'general', section: '启动与会话', label: '重新打开时恢复上次阅读位置', keywords: ['滚动位置', '阅读进度', '光标位置'] },
  { id: 'localSearch', tab: 'general', section: IS_WEB ? '全局搜索' : '本地文件搜索', label: IS_WEB ? '全局搜索' : '本地文件搜索', keywords: ['搜索', '索引', '全文搜索', '磁盘'], available: () => SUPPORTS_LOCAL_SEARCH && !IS_MOBILE_UI },
  { id: 'createFormats', tab: 'general', section: '新建入口', label: '新建入口', keywords: ['主页', '新建菜单', '格式', '加号', '更多'] },
  { id: 'htmlOpenMode', tab: 'general', section: 'HTML 链接', label: 'HTML 链接打开方式', keywords: ['浏览器', '网页', 'html'], available: DESKTOP_ONLY },

  // 外观
  { id: 'theme', tab: 'appearance', section: '主题配色方案', label: '主题配色', keywords: ['主题', '晨光', '琥珀', '墨夜', '跟随系统', '深色', '暗色', '夜间', '浅色', '颜色'] },
  { id: 'titleBarButtons', tab: 'appearance', section: '标题栏按钮', label: '标题栏按钮', keywords: ['回到主界面', '检查更新按钮', '切换主题', '极窄模式', '隐藏按钮'], available: NOT_MOBILE },

  // 排版与字体
  { id: 'fontPack', tab: 'typography', section: '推荐字体', label: '下载推荐字体', keywords: ['字体包', '字体下载'] },
  { id: 'uiFont', tab: 'typography', section: '软件界面 UI 排版', label: '界面字体与字号', keywords: ['界面字号', 'ui 字体', '菜单字体', '字体', '字号'] },
  { id: 'contentFont', tab: 'typography', section: 'Markdown 正文排版', label: '正文字体与字号', keywords: ['正文字号', '字体', '字号', '笔记字体'] },
  { id: 'contentLineHeight', tab: 'typography', section: 'Markdown 正文排版', label: '正文行高', keywords: ['行距', '行间距'] },
  { id: 'paragraphSpacing', tab: 'typography', section: 'Markdown 正文排版', label: '正文段落间距', keywords: ['段距', '段间距'] },
  { id: 'contentWidth', tab: 'typography', section: 'Markdown 正文排版', label: 'Markdown 编辑区最大宽度', keywords: ['内容宽度', '页宽', '宽屏', '全宽'] },
  { id: 'monoFont', tab: 'typography', section: '代码与纯文本排版', label: '代码字体、字号与行高', keywords: ['等宽', '代码行高', '代码字号', '字体'] },
  { id: 'monoPadding', tab: 'typography', section: '代码与纯文本排版', label: '编辑区边距', keywords: ['留白', '内边距'] },
  { id: 'monoWidth', tab: 'typography', section: '代码与纯文本排版', label: '代码 / 纯文本 / MD 源码编辑区最大宽度', keywords: ['内容宽度', '页宽'] },
  { id: 'explorerFont', tab: 'typography', section: '文件树排版', label: '文件树字体、字号与行高', keywords: ['资源管理器', '侧栏', '目录字体'] },

  // 编辑器
  { id: 'showWhitespace', tab: 'editor', section: '代码与纯文本', label: '显示空格（点）', keywords: ['空白字符', '制表符'] },
  { id: 'showLineEndings', tab: 'editor', section: '代码与纯文本', label: '显示换行符号 (↵)', keywords: ['行尾', '换行符'] },
  { id: 'showLineNumbers', tab: 'editor', section: '代码与纯文本', label: '显示行号', keywords: ['行号'] },
  { id: 'softWrap', tab: 'editor', section: '代码与纯文本', label: '软换行 (自动折行)', keywords: ['自动换行', '折行', '横向滚动'] },
  { id: 'indentGuides', tab: 'editor', section: '代码与纯文本', label: '缩进参考导线', keywords: ['缩进线', '导线'] },
  { id: 'columnEdit', tab: 'editor', section: '代码与纯文本', label: '列编辑模式', keywords: ['多光标', '块选择', 'alt'] },
  { id: 'tabSize', tab: 'editor', section: '代码与纯文本', label: 'Tab 缩进宽度', keywords: ['缩进', '空格数'] },
  { id: 'insertSpaces', tab: 'editor', section: '代码与纯文本', label: '空格代替 Tab', keywords: ['缩进', '制表符'] },
  { id: 'defaultViewMode', tab: 'editor', section: 'Markdown', label: 'Markdown 默认视图模式', keywords: ['源码模式', '可视化', '所见即所得'] },
  { id: 'codeBlockExpanded', tab: 'editor', section: 'Markdown', label: '代码块默认展开', keywords: ['收起代码块', '折叠代码'] },
  { id: 'detailsExpanded', tab: 'editor', section: 'Markdown', label: '折叠块默认展开', keywords: ['details', '折叠'] },
  { id: 'outlinePosition', tab: 'editor', section: 'Markdown', label: 'Markdown 大纲位置', keywords: ['大纲', '目录', 'toc'] },
  { id: 'copyFormat', tab: 'editor', section: 'Markdown', label: 'Markdown 复制格式', keywords: ['复制', '纯文本', '带格式', 'ctrl+c'] },
  { id: 'swapEnterKeys', tab: 'editor', section: 'Markdown', label: 'Enter 与 Shift + Enter 互换', keywords: ['回车', '换行', '换段落', 'shift+enter', '段内换行'] },
  { id: 'enableMath', tab: 'editor', section: 'Markdown', label: 'LaTeX 数学公式渲染 (KaTeX)', keywords: ['公式', 'katex', '数学'] },
  { id: 'enableMermaid', tab: 'editor', section: 'Markdown', label: 'Mermaid 图表实时渲染', keywords: ['流程图', '图表', '时序图'] },
  { id: 'blockHandle', tab: 'editor', section: 'Markdown', label: '悬浮块把手 (拖拽与菜单)', keywords: ['拖拽', '拖动段落', '把手'] },
  { id: 'mindmapWidth', tab: 'editor', section: '思维导图', label: '节点默认宽度', keywords: ['脑图', '导图'] },
  { id: 'mindmapAlign', tab: 'editor', section: '思维导图', label: '节点文字对齐', keywords: ['脑图', '导图', '居中'] },
  { id: 'mindmapImage', tab: 'editor', section: '思维导图', label: '节点图片显示', keywords: ['脑图', '导图', '图片裁切'] },

  // 文件与保存
  { id: 'autoSave', tab: 'file', section: '自动保存设置', label: '自动保存与保存间隔', keywords: ['保存', '间隔', '自动'] },
  { id: 'showHiddenFiles', tab: 'file', section: '文件树与打开', label: '显示隐藏文件 / 文件夹', keywords: ['点文件', '系统文件', '隐藏'] },
  { id: 'explorerOpenMode', tab: 'file', section: '文件树与打开', label: '打开文件的方式', keywords: ['单击', '双击', '资源管理器', '文件树'] },
  { id: 'largeFile', tab: 'file', section: '文件树与打开', label: '大文件打开确认阈值 (MB)', keywords: ['大文件', '性能提示'] },
  { id: 'staging', tab: 'file', section: '未保存文件暂存区', label: '未保存文件暂存区', keywords: ['暂存', '崩溃', '异常退出', '草稿', '恢复'] },
  { id: 'imageDir', tab: 'file', section: '图片目录设置', label: '图片目录名称', keywords: ['粘贴图片', 'img', '附件', '图片保存'] },

  // 同步与备份（面板内的卡片锚点）
  { id: 'sync', tab: 'sync', section: '多端同步', label: '开启多端同步', keywords: ['同步', '同步文件夹', '云'] },
  { id: 'syncMethod', tab: 'sync', section: '同步方式', label: '同步方式', keywords: ['webdav', 's3', 'git', 'github', 'gitee', 'oss', 'cos', 'obs', '坚果云', '对象存储'] },
  { id: 'syncTiming', tab: 'sync', section: '同步时机', label: '同步时机', keywords: ['定时同步', '自动同步', '保存后同步', '启动后同步'] },
  { id: 'trash', tab: 'sync', section: '回收站', label: '回收站', keywords: ['删除', '恢复删除'] },
  { id: 'backup', tab: 'sync', section: '备份', label: '备份', keywords: ['自动备份', '恢复备份', '备份位置'] },

  // 历史记录
  { id: 'historyMode', tab: 'history', section: '记录方式', label: '历史记录方式', keywords: ['版本', '快照', '历史版本'] },
  { id: 'historyRetention', tab: 'history', section: '保留与空间', label: '保留时长与空间', keywords: ['清理', '占用', '保留'] },

  // 插件和字体
  { id: 'plugins', tab: 'plugins', section: '插件', label: '插件管理', keywords: ['word', 'excel', 'powerpoint', 'ppt', 'pdf', 'cad', 'epub', '查看器', '扩展'] },
  { id: 'pluginFonts', tab: 'plugins', section: '字体', label: '字体下载', keywords: ['手写体', '小赖', '画板字体', '字体包'] },

  // 快捷键
  { id: 'shortcutList', tab: 'shortcuts', section: '快捷键一览', label: '快捷键一览', keywords: ['热键', '按键', '键盘'] },
  { id: 'globalShortcut', tab: 'shortcuts', section: '全局与文件操作', label: '全局唤起窗口', keywords: ['热键', '唤起', '全局快捷键'], available: DESKTOP_ONLY },

  // 关于
  { id: 'checkUpdate', tab: 'about', section: '关于', label: '检测更新', keywords: ['升级', '版本', '新版本', '仓库'] },
  { id: 'autoCheckUpdate', tab: 'about', section: '关于', label: '自动检查更新', keywords: ['更新', '升级', '静默检查', '新版本提醒'], available: () => !IS_WEB },
  { id: 'updateChannel', tab: 'about', section: '关于', label: '更新渠道', keywords: ['github', 'cnb', '镜像', '下载源'] },
  { id: 'releaseNotes', tab: 'about', section: '关于', label: '更新日志', keywords: ['版本说明', 'changelog'] },
];

/** 统一大小写并去掉空白，「Shift + Enter」与「shift+enter」视为相同 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/** 按包含关系匹配页名、分区、设置项与同义词；不可用的条目与隐藏栏目不参与，结果按导航顺序排列 */
export function searchSettings(query: string): SettingsSearchEntry[] {
  const q = normalize(query);
  if (!q) return [];
  return SETTINGS_SEARCH_INDEX
    .filter((entry) => isTabVisible(entry.tab) && (entry.available?.() ?? true))
    .filter((entry) => [TAB_LABELS[entry.tab], entry.section, entry.label, ...(entry.keywords ?? [])].some((text) => normalize(text).includes(q)))
    // Array.prototype.sort 稳定，同一栏目内保持索引顺序
    .sort((a, b) => TAB_ORDER.indexOf(a.tab) - TAB_ORDER.indexOf(b.tab));
}
