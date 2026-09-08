// 活动状态仅控制展示性工作，不控制正文同步、暂存、保存或关闭保护。
import { createContext, useContext } from 'react';

/** 独立编辑器宿主默认可见；AppShell 按当前活动标签覆盖，保持所有内核身份稳定。 */
export const EditorActivityContext = createContext(true);

/** 供编辑器及 React NodeView 暂停后台菜单、主题重绘等非必要工作。 */
export function useEditorActive(): boolean {
  return useContext(EditorActivityContext);
}
