// 网页多用户：只读共享的文档在编辑器中禁止输入，避免编辑后才在保存时被服务端拒绝。
// 仅作用于 /shared 下的文档，不改变原生端与本人文件的只读属性处理方式。
import { IS_WEB } from '../../core/platform';
import { useDocumentStore } from '../../stores/documentStore';
import { isSharedPath } from './accountState';

export function isSharedReadonly(docKey: string): boolean {
  return IS_WEB && isSharedPath(docKey) && !!useDocumentStore.getState().documents.get(docKey)?.readonly;
}

export function useSharedReadonly(docKey: string): boolean {
  return useDocumentStore((state) => IS_WEB && isSharedPath(docKey) && !!state.documents.get(docKey)?.readonly);
}
