// NoteBoard 编辑器堆栈
// 所有已打开标签保持挂载（保活）：活动标签正常显示，其余标签移出可视区域但不卸载，
// 编辑器内核与撤销历史完整保留。桌面 AppShell 与移动端 MobileShell 共用（自 AppShell 原样抽出）。

import type { Editor } from '@tiptap/core';
import type { Tab } from '../../stores/windowStore';
import { UnsupportedView } from '../UnsupportedView';
// 🔴 S05：全部编辑器按类型懒加载（EditorHost + editorLoaders），壳不再静态导入任何编辑器
import { EditorHost } from '../../features/editor-host/EditorHost';
// 用户已确认：已打开内核保留至关闭，切换不进入回收调度。
import { EditorActivityContext } from '../../core/editor/EditorActivityContext';

export interface EditorStackProps {
  tabs: Tab[];
  activeKey: string | null;
  /** 迁移保护中的文档：阻断编辑输入（pointerEvents），避免迁移期间新修改无法同步到目标 */
  transferringKeys: string[];
  /** 是否有活动标签（无活动标签时视觉隐藏而非卸载） */
  hasActiveTab: boolean;
  getMarkdownEditorReadyHandler: (docKey: string) => (editor: Editor | null) => void;
}

export function EditorStack({
  tabs,
  activeKey,
  transferringKeys,
  hasActiveTab,
  getMarkdownEditorReadyHandler,
}: EditorStackProps) {
  if (tabs.length === 0) return null;
  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        // 🔴 N08：Home 可见时隐藏编辑器容器（视觉隐藏而非卸载）
        display: !hasActiveTab ? 'none' : 'block',
      }}
    >
      {tabs.map((tab) => {
        const isTabActive = tab.key === activeKey;
        const isTransferring = transferringKeys.includes(tab.key);

        return (
          <div
            key={tab.key}
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              height: '100%',
              overflow: 'hidden',
              ...(isTransferring
                ? { pointerEvents: 'none' as const, opacity: 0.55 }
                : {}),
              ...(isTabActive
                ? { position: 'relative' }
                : {
                    position: 'absolute',
                    top: -99999,
                    left: -99999,
                    opacity: 0,
                    pointerEvents: 'none',
                    visibility: 'hidden',
                    zIndex: -1,
                  }),
            }}
          >
            {tab.kind === 'unsupported' ? (
              <UnsupportedView
                filePath={tab.path ?? tab.key}
                fileName={tab.displayName}
              />
            ) : tab.lazySource ? (
              // 🔴 S10：恢复标签正文加载中（点击标签触发；不挂载空编辑器）
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  height: '100%',
                  background: 'var(--editor-bg)',
                  color: 'var(--editor-text-muted, #64748b)',
                  fontFamily: 'var(--ui-font-family, sans-serif)',
                  fontSize: 13,
                }}
              >
                <span>正在加载「{tab.displayName}」…</span>
              </div>
            ) : (
              // 用户确认的保活策略：稳定宿主随标签关闭才卸载，后台只暂停展示性工作。
              <EditorActivityContext.Provider value={isTabActive}>
                <EditorHost
                  tab={tab}
                  onEditorReady={tab.kind === 'markdown'
                    ? getMarkdownEditorReadyHandler(tab.key)
                    : undefined}
                  unsupportedView={null}
                />
              </EditorActivityContext.Provider>
            )}
          </div>
        );
      })}
    </div>
  );
}
