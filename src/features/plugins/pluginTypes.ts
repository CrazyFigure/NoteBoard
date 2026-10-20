// 官方插件协议独立于 React 和编辑器内核，插件更新不要求重新构建主程序。
export type PluginId = 'word' | 'excel' | 'powerpoint' | 'pdf' | 'cad' | 'workbench';

export interface PluginManifest {
  id: PluginId;
  name: string;
  description: string;
  version: string;
  apiVersion: number;
  minAppVersion: string;
  codeSha256: string;
  changelog: string;
  licenses: string;
}

export interface PluginPackage { manifest: PluginManifest; code: string }
export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  invalid?: boolean;
  error?: string;
}
export interface CatalogPlugin extends PluginManifest { url: string; sha256: string; size: number }
export interface PluginCatalog { schemaVersion: number; plugins: CatalogPlugin[] }

/** 插件只接收本次用户打开的文件和显式选择的数据源。Office 查看器不提供写入接口。 */
export interface PluginContext {
  container: HTMLElement;
  name: string;
  bytes?: Uint8Array;
  signal: AbortSignal;
  notify: (message: string) => void;
}
export interface PluginModule {
  mount: (context: PluginContext) => Promise<(() => void) | void>;
}

/** 固定官方插件标识，同时作为未联网时的设置页目录。 */
export const OFFICIAL_PLUGINS: Array<{ id: PluginId; name: string; description: string; formats: string }> = [
  { id: 'word', name: 'Word 查看', description: '阅读文档、选择与复制文字', formats: 'DOC · DOCX' },
  { id: 'excel', name: 'Excel 查看', description: '切换工作表、选择与复制单元格', formats: 'XLS · XLSX' },
  { id: 'powerpoint', name: 'PowerPoint 查看', description: '浏览幻灯片、选择与复制文字', formats: 'PPT · PPTX' },
  { id: 'pdf', name: 'PDF 查看', description: '分页阅读、缩放与文字选择', formats: 'PDF' },
  { id: 'cad', name: 'CAD 查看', description: '本地图纸阅读、平移缩放与文字复制', formats: 'DWG · DXF' },
  { id: 'workbench', name: '多维表格工作台', description: '自由组合数据、任务、日程与笔记', formats: '多维表格视图' },
];

/** 按扩展名选取查看插件，完全独立于插件是否已经安装。 */
export function previewPluginFor(path: string): PluginId | null {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'xls' || ext === 'xlsx') return 'excel';
  if (ext === 'ppt' || ext === 'pptx') return 'powerpoint';
  if (ext === 'dwg' || ext === 'dxf') return 'cad';
  return ext === 'pdf' ? 'pdf' : null;
}

/** 更新只接受更高的三段版本，成功切换后由后端清理旧包。 */
export function isNewerPluginVersion(next: string, current: string): boolean {
  const a=next.split('.').map(Number),b=current.split('.').map(Number);
  if(a.length!==3||b.length!==3||[...a,...b].some((n)=>!Number.isInteger(n)||n<0))return false;
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return false;
}
