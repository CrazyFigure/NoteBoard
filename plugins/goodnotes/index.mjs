// 独立 Goodnotes 只读插件，全部资源随插件离线运行。
import { mountNotebook } from '../shared/noteView.mjs';
import { openGoodnotes } from './book.mjs';
export const mount = (context) => mountNotebook(context, openGoodnotes);
