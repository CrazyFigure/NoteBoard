// NoteBoard 外部变更横幅
// Clean + 外部 modify → 静默重载；Dirty + 外部 modify → ExternalChangeBanner 二选一
// 详见 docs/09-开发路线图.md 13.1-13.3

import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';

interface ExternalChangeBannerProps {
  docKey: string;
}

export function ExternalChangeBanner({ docKey }: ExternalChangeBannerProps) {
  const doc = useDocumentStore((s) => s.getDocument(docKey));
  const setExternalStatus = useDocumentStore((s) => s.setExternalStatus);
  const docStore = useDocumentStore();

  if (!doc || !doc.externalStatus || doc.externalStatus === 'clean') {
    return null;
  }

  const handleOverwrite = () => {
    // 用当前内容覆盖磁盘文件
    setExternalStatus(docKey, 'clean');
  };

  const handleReload = async () => {
    // 从磁盘重新加载
    setExternalStatus(docKey, 'clean');
  };

  const handleSaveAs = () => {
    // 另存为
    setExternalStatus(docKey, 'clean');
  };

  if (doc.externalStatus === 'modified') {
    return (
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--warning-50)',
          borderBottom: '1px solid var(--warning-200)',
          fontSize: 13,
          color: 'var(--editor-text)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span>⚠</span>
        <span>文件已被外部程序修改。当前有未保存的更改。</span>
        <button onClick={handleOverwrite} className="nb-btn-secondary" style={{ ...btnStyle, marginLeft: 'auto' }}>覆盖磁盘文件</button>
        <button onClick={handleReload} className="nb-btn-secondary" style={btnStyle}>重新加载</button>
      </div>
    );
  }

  if (doc.externalStatus === 'deleted') {
    return (
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--error-50, #fee)',
          borderBottom: '1px solid var(--error-200, #fbb)',
          fontSize: 13,
          color: 'var(--editor-text)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span>🗑</span>
        <span>文件已被外部删除。当前内容仍保留在标签页中。</span>
        <button onClick={handleSaveAs} className="nb-btn-secondary" style={{ ...btnStyle, marginLeft: 'auto' }}>另存为</button>
        <button onClick={() => useWindowStore.getState().closeTab(docKey)} className="nb-btn-secondary" style={btnStyle}>关闭标签</button>
      </div>
    );
  }

  if (doc.externalStatus === 'renamed') {
    return (
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--warning-50)',
          borderBottom: '1px solid var(--warning-200)',
          fontSize: 13,
          color: 'var(--editor-text)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span>📝</span>
        <span>文件已被外部重命名。标签页标题已自动更新。</span>
      </div>
    );
  }

  return null;
}

const btnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  padding: '4px 12px',
  border: '1px solid var(--editor-border)',
  borderRadius: 3,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
};
