// NoteBoard 外部变更横幅
// 磁盘修改与删除交由应用级弹窗处理；此处仅保留重命名提示。
// 详见 docs/09-开发路线图.md 13.1-13.3

import { useDocumentStore } from '../../stores/documentStore';
// 🔴 R3-10：重新加载/覆盖走真实处理链（读盘应用/受保护保存）——不再只清状态

interface ExternalChangeBannerProps {
  docKey: string;
}

export function ExternalChangeBanner({ docKey }: ExternalChangeBannerProps) {
  const doc = useDocumentStore((s) => s.getDocument(docKey));

  if (!doc || !doc.externalStatus || doc.externalStatus === 'clean') {
    return null;
  }

  if (doc.externalStatus === 'modified') {
    // 所有格式统一使用 ExternalChangeDialog，避免 Markdown 再叠加一条横幅。
    return null;
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
