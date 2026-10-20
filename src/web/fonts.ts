// 浏览器不能读取服务器字体。支持 Local Font Access 时只在用户打开下拉框后请求，
// 不支持或拒绝授权时用本机字形度量检测常见字体，并始终保留通用字体和手动输入。
import type { FontFamily } from '../core/ipc/types';

/** 仅返回当前浏览器可使用的字体，检测过程不下载字体、不发起网络请求。 */
export async function browserSystemFonts(allowPrompt = false): Promise<FontFamily[]> {
  const host = window as Window & { queryLocalFonts?: () => Promise<Array<{family:string}>> };
  let names: string[] = [];
  if (allowPrompt && window.isSecureContext && navigator.userActivation?.isActive && host.queryLocalFonts) {
    try { names = [...new Set((await host.queryLocalFonts()).map((font) => font.family))]; } catch { /* 拒绝权限时继续使用无权限检测。 */ }
  }
  if (!names.length) {
    const context = document.createElement('canvas').getContext('2d');
    const sample = 'WWiiii012345中文字体';
    const bases = ['monospace', 'serif', 'sans-serif'];
    const measure = (family:string) => { if (!context) return 0; context.font=`72px ${family}`; return context.measureText(sample).width; };
    const candidates = ['Maple Mono Normal NF CN','JetBrains Mono','Microsoft YaHei','SimSun','Consolas','Arial','Segoe UI','PingFang SC','Songti SC','Menlo','Monaco','Helvetica Neue','Noto Sans CJK SC','Noto Sans SC','Noto Serif SC','WenQuanYi Micro Hei','DejaVu Sans','Liberation Mono','Roboto','Droid Sans'];
    names = candidates.filter((family) => context && bases.some((base) => Math.abs(measure(`"${family}",${base}`) - measure(base)) > .1));
  }
  return [...new Set([...names,'sans-serif','serif','monospace'])].map((family) => ({family,isMonospace:/mono|consolas|menlo|monaco/i.test(family),hasCjk:/[\u4e00-\u9fff]|maple|yahei|simsun|pingfang|songti|cjk|noto.*sc|wenquanyi/i.test(family)}));
}
