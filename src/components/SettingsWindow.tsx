// NoteBoard 设置窗口
// 独立窗口，label nb-settings，5 个分组
// 详见 docs/09-开发路线图.md 12.1-12.11

import { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { AppearancePanel } from './settings/AppearancePanel';
import { TypographyPanel } from './settings/TypographyPanel';
import { EditorPanel } from './settings/EditorPanel';
import { FilePanel } from './settings/FilePanel';
import { AboutPanel } from './settings/AboutPanel';
import * as ipc from '../core/ipc/commands';

type PanelKey = 'appearance' | 'typography' | 'editor' | 'file' | 'about';

const PANELS: { key: PanelKey; label: string }[] = [
  { key: 'appearance', label: '外观' },
  { key: 'typography', label: '排版' },
  { key: 'editor', label: '编辑器' },
  { key: 'file', label: '文件' },
  { key: 'about', label: '关于' },
];

export function SettingsWindow() {
  const [activePanel, setActivePanel] = useState<PanelKey>('appearance');
  // 设置主内容区引用
  const contentRef = useRef<HTMLDivElement>(null);

  // 切换设置 Tab 栏目时，重置主内容区域的竖向滚动条至顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activePanel]);

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        background: 'var(--editor-surface)',
        color: 'var(--editor-text)',
        fontFamily: 'var(--ui-font-family)',
        fontSize: 'var(--ui-font-size)',
      }}
    >
      {/* 侧边栏 */}
      <div
        style={{
          width: 160,
          flexShrink: 0,
          borderRight: '1px solid var(--editor-border)',
          padding: '8px 0',
          background: 'var(--editor-surface)',
        }}
      >
        {PANELS.map((p) => {
          const isActive = activePanel === p.key;
          return (
            <button
              key={p.key}
              onClick={() => setActivePanel(p.key)}
              style={{
                display: 'block',
                width: '100%',
                padding: '8px 16px',
                textAlign: 'left',
                border: 'none',
                background: isActive ? 'var(--editor-selection)' : 'transparent',
                color: isActive ? 'var(--accent-strong)' : 'var(--editor-text)',
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer',
                fontSize: 13,
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'var(--toolbar-hover)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent';
                }
                e.currentTarget.style.transform = 'scale(1)';
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'scale(0.97)';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* 主内容区 */}
      <div ref={contentRef} style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        {activePanel === 'appearance' && <AppearancePanel />}
        {activePanel === 'typography' && <TypographyPanel />}
        {activePanel === 'editor' && <EditorPanel />}
        {activePanel === 'file' && <FilePanel />}
        {activePanel === 'about' && <AboutPanel />}
      </div>
    </div>
  );
}

/** 打开设置窗口 */
export async function openSettingsWindow(): Promise<void> {
  await ipc.createWindow({
    kind: 'settings',
    title: '设置',
  } as unknown as Parameters<typeof ipc.createWindow>[0]);
}
