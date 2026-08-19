// NoteBoard 文件拖拽释放提示浮层
// 当用户从外部将文件拖入 NoteBoard 窗口时展示视觉反馈
// 详见 docs/07-UI布局与交互规范.md

import { Files } from 'lucide-react';
import { useLayoutStore } from '../stores/layoutStore';

export function FileDropOverlay() {
  const isDraggingFile = useLayoutStore((s) => s.isDraggingFile);

  if (!isDraggingFile) {
    return null;
  }

  return (
    // 全屏遮罩层：必须设置 pointerEvents: 'none'，防止阻断原生 WebView 拖拽事件
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        boxSizing: 'border-box',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(3px)',
        animation: 'fadeIn 150ms ease-out',
      }}
    >
      {/* 拖拽释放视觉中心卡片 */}
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          padding: '40px 32px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          borderRadius: 16,
          background: 'var(--editor-surface, #1e1e1e)',
          border: '2px dashed var(--editor-accent, #3b82f6)',
          boxShadow: '0 12px 36px rgba(0, 0, 0, 0.35)',
          gap: 16,
        }}
      >
        {/* 顶部图标 */}
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            background: 'var(--editor-bg, #141414)',
            border: '1px solid var(--editor-border, #333)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--editor-accent, #3b82f6)',
          }}
        >
          <Files size={32} />
        </div>

        {/* 标题 */}
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: 'var(--editor-heading, #fff)',
          }}
        >
          释放文件以在新标签页中打开
        </div>

        {/* 辅助说明 */}
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--editor-text-secondary, #a1a1aa)',
            maxWidth: 380,
          }}
        >
          支持 Markdown 笔记、画板、代码、图片以及所有其他格式文件。
          <br />
          打开后自动在左侧菜单栏展开对应目录。
        </div>
      </div>
    </div>
  );
}
