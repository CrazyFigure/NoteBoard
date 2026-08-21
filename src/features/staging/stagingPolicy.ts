// NoteBoard 未保存内容判定
// 空白未命名文件可直接关闭；有内容的未命名文件与有修改的磁盘文件进入关闭保护。

import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';

/** 判断标签是否包含值得保存或暂存的内容。空字符串不算，用户输入的空格会因脏态而保留。 */
export function hasUnsavedWork(key: string): boolean {
  const document = useDocumentStore.getState().getDocument(key);
  const tab = useWindowStore.getState().getTab(key);
  if (!document || !tab) return false;
  if (document.isDirty || tab.isDirty) return true;
  return key.startsWith('untitled:') && (document.content?.length ?? 0) > 0;
}
