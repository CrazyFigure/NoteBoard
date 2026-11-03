// 独立 Notability 只读插件，与 Goodnotes 分别安装和启用。
import { mountNotebook } from '../shared/noteView.mjs';
import { openNotability } from './book.mjs';
export const mount = (context) => mountNotebook(context, openNotability);
