// NoteBoard 外部变更横幅
// Clean + 外部 modify → 静默重载；Dirty + 外部 modify → ExternalChangeBanner 二选一
// 详见 docs/09-开发路线图.md 13.1-13.3

import { useDocumentStore } from '../../stores/documentStore';
// 🔴 R3-10：重新加载/覆盖走真实处理链（读盘应用/受保护保存）——不再只清状态
import { reloadFromDisk, overwriteFromEditor } from '../external/externalChangeActions';

interface ExternalChangeBannerProps {
  docKey: string;
}

export function ExternalChangeBanner({ docKey }: ExternalChangeBannerProps) {
  const doc = useDocumentStore((s) => s.getDocument(docKey));

  if (!doc || !doc.externalStatus || doc.externalStatus === 'clean') {
    return null;
  }

  // 🔴 R3-10：覆盖 = 受保护保存当前权威内容（失败保持冲突状态，可重试）
  const handleOverwrite = () => {
    void overwriteFromEditor(docKey);
  };

  // 🔴 R3-10：重新加载 = 确认并应用磁盘内容（正文/基线/历史/内核对齐；失败保持冲突）
  const handleReload = () => {
    void reloadFromDisk(docKey);
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
    // 删除场景由应用级 MissingFileDialog 统一处理，确保代码、画板等所有格式行为一致。
    return null;
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
