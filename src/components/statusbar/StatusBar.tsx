// NoteBoard StatusBar
// 底部状态栏：光标位置、字数/行数、编码、行尾符、类型、保存状态
// 详见 docs/07-UI布局与交互规范.md §8

import { useWindowStore } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { saveDocument } from '../../features/editor-code/orchestration/saveDocument';
import { emit } from '../../core/emitter';
import { Eye, Code } from 'lucide-react';
import { Tooltip } from '../Tooltip';

export function StatusBar() {
  const activeKey = useWindowStore((s) => s.activeKey);
  const activeTab = useWindowStore((s) => (activeKey ? s.getTab(activeKey) : undefined));
  const doc = useDocumentStore((s) => (activeKey ? s.documents.get(activeKey) : undefined));

  if (!doc) {
    return (
      <div
        style={{
          height: 24,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 12,
          paddingRight: 12,
          background: 'var(--statusbar-bg)',
          borderTop: '1px solid var(--editor-border)',
          color: 'var(--statusbar-text)',
          fontFamily: 'var(--ui-font-family, inherit)',
          fontSize: 'calc(var(--ui-font-size, 13px) - 1px)',
          flexShrink: 0,
        }}
      >
        <span style={{ color: 'var(--statusbar-text)' }}>NoteBoard</span>
      </div>
    );
  }

  const sectionStyle: React.CSSProperties = {
    padding: '0 10px',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: '100%',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const dividerStyle: React.CSSProperties = {
    width: 1,
    height: 14,
    background: 'var(--editor-border)',
  };

  // 保存状态判定
  let saveStatus = '已保存';
  let saveStatusColor = 'var(--statusbar-text)';
  let saveStatusTitle = doc.savePolicy === 'auto' ? '自动保存已启用 · 文件已保存' : '文件已保存';

  if (doc.isDirty) {
    if (doc.savePolicy === 'auto') {
      saveStatus = '正在保存';
      saveStatusColor = 'var(--accent-strong)';
      saveStatusTitle = '正在自动保存';
    } else {
      saveStatus = '未保存';
      saveStatusColor = 'var(--accent-strong)';
      saveStatusTitle = '有未保存的修改，点击或按 Ctrl+S 保存';
    }
  }

  // 类型显示
  const typeLabel =
    doc.kind === 'markdown'
      ? 'Markdown'
      : doc.kind === 'board'
        ? '画板'
        : doc.language === 'sql'
          ? 'SQL'
          : doc.language === 'json'
            ? 'JSON'
            : doc.language === 'yaml'
              ? 'YAML'
              : doc.language === 'xml'
                ? 'XML'
                : doc.language === 'markdown'
                  ? 'Markdown'
                  : '纯文本';

  return (
    <div
      style={{
        height: 24,
        display: 'flex',
        alignItems: 'center',
        background: 'var(--statusbar-bg)',
        borderTop: '1px solid var(--editor-border)',
        color: 'var(--statusbar-text)',
        fontFamily: 'var(--ui-font-family, inherit)',
        fontSize: 'calc(var(--ui-font-size, 13px) - 1px)',
        flexShrink: 0,
        overflow: 'hidden',
      }}
      role="status"
    >
      {/* 光标位置 */}
      <div style={sectionStyle}>
        <span>行 1, 列 1</span>
      </div>
      <div style={dividerStyle} />

      {/* 字数/行数 */}
      <div style={sectionStyle}>
        <span>
          {doc.content?.length.toLocaleString() ?? 0} 字 · {(doc.content?.split('\n').length ?? 0).toLocaleString()} 行
        </span>
      </div>
      <div style={dividerStyle} />

      {/* 编码 */}
      <div style={sectionStyle}>
        <span>{doc.encoding === 'utf8' ? 'UTF-8' : doc.encoding === 'utf8-bom' ? 'UTF-8 BOM' : 'GBK'}</span>
      </div>
      <div style={dividerStyle} />

      {/* 行尾符 */}
      <div style={sectionStyle}>
        <span>{doc.eol === 'crlf' ? 'CRLF' : 'LF'}</span>
      </div>
      <div style={dividerStyle} />

      {/* 类型 / Markdown 模式切换 */}
      {doc.kind === 'markdown' ? (
        <Tooltip
          content={`当前：Markdown (${activeTab?.viewMode === 'source' ? '源码模式' : '可视化模式'}) · 点击切换`}
          shortcut="Ctrl+/"
          side="top"
          sideOffset={6}
        >
          <div
            style={{
              ...sectionStyle,
              borderRadius: 3,
              transition: 'all var(--transition-fast)',
            }}
            onClick={() => {
              if (activeKey) {
                emit('toggle-md-view-mode', { key: activeKey });
              }
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.color = 'var(--editor-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--statusbar-text)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-active)';
              e.currentTarget.style.transform = 'scale(0.96)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = 'var(--toolbar-hover)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            {activeTab?.viewMode === 'source' ? (
              <>
                <Code size={13} style={{ flexShrink: 0 }} />
                <span>Markdown (源码)</span>
              </>
            ) : (
              <>
                <Eye size={13} style={{ flexShrink: 0 }} />
                <span>Markdown (可视化)</span>
              </>
            )}
          </div>
        </Tooltip>
      ) : (
        <div style={sectionStyle}>
          <span>{typeLabel}</span>
        </div>
      )}
      <div style={dividerStyle} />

      {/* 保存状态 */}
      <Tooltip content={saveStatusTitle} side="top" sideOffset={6}>
        <div
          style={{ ...sectionStyle, color: saveStatusColor }}
          onClick={() => {
            if (doc.isDirty && activeKey) {
              saveDocument(activeKey);
            }
          }}
        >
          <span>{saveStatus}</span>
        </div>
      </Tooltip>

      {/* 右侧空白 */}
      <div style={{ flex: 1 }} />

      {/* 只读标记 */}
      {doc.readonly && (
        <>
          <div style={dividerStyle} />
          <div style={sectionStyle}>
            <span style={{ color: 'var(--warning-600)' }}>只读</span>
          </div>
        </>
      )}
    </div>
  );
}
