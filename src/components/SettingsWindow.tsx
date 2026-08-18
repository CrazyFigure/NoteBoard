// NoteBoard 设置窗口
// 独立窗口，label nb-settings，5 个分组
// 详见 docs/09-开发路线图.md 12.1-12.11

import { useState, useEffect } from 'react';
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
        {PANELS.map((p) => (
          <button
            key={p.key}
            onClick={() => setActivePanel(p.key)}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 16px',
              textAlign: 'left',
              border: 'none',
              background: activePanel === p.key ? 'var(--editor-selection-background)' : 'transparent',
              color: activePanel === p.key ? 'var(--editor-accent)' : 'var(--editor-text)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 主内容区 */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
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
