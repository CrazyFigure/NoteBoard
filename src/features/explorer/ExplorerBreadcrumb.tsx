// NoteBoard 资源管理器：面包屑导航栏
// 支持多级路径分段解析、点击跳转、超长横向滚动与滚轮滑动、随 Tab 聚焦自动居中
// 详见 docs/07-UI布局与交互规范.md §5

import { useRef, useEffect } from 'react';
import { ChevronRight, HardDrive, Folder } from 'lucide-react';
import { useExplorerStore } from './explorerStore';
import { useTreeData } from './useTreeData';

export interface PathSegment {
  name: string;
  fullPath: string;
  isDrive: boolean;
  isLast: boolean;
}

/**
 * 解析 Windows / POSIX 文件路径为面包屑分段列表
 */
export function parsePathSegments(rawPath: string): PathSegment[] {
  if (!rawPath) return [];

  // 统一替换为标准 Windows 反斜杠格式
  const normalized = rawPath.replace(/\//g, '\\');
  const driveMatch = normalized.match(/^([A-Za-z]:)(\\)?(.*)/);
  const segments: PathSegment[] = [];

  if (driveMatch) {
    const drive = driveMatch[1]; // 如 "C:"
    let currentPath = drive + '\\';
    const rest = driveMatch[3];
    const parts = rest.split('\\').filter(Boolean);

    segments.push({
      name: drive,
      fullPath: currentPath,
      isDrive: true,
      isLast: parts.length === 0,
    });

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath.endsWith('\\') ? currentPath + part : currentPath + '\\' + part;
      segments.push({
        name: part,
        fullPath: currentPath,
        isDrive: false,
        isLast: i === parts.length - 1,
      });
    }
  } else {
    // 处理无盘符或非标准路径
    const parts = normalized.split('\\').filter(Boolean);
    let currentPath = normalized.startsWith('\\') ? '\\' : '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}\\${part}` : part;
      segments.push({
        name: part,
        fullPath: currentPath,
        isDrive: false,
        isLast: i === parts.length - 1,
      });
    }
  }

  return segments;
}

interface ExplorerBreadcrumbProps {
  root: string;
  onRefresh?: () => void;
}

export function ExplorerBreadcrumb({ root, onRefresh }: ExplorerBreadcrumbProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { setRoot, setRevealed } = useExplorerStore();
  const { loadChildren } = useTreeData();

  const segments = parsePathSegments(root);

  // 当路径改变（如 Tab 聚焦、文件切换）时，自动平滑滚动至最右端，确保当前目录可见
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTo({
        left: containerRef.current.scrollWidth,
        behavior: 'smooth',
      });
    }
  }, [root]);

  // 支持鼠标滚轮在面包屑区域进行横向平滑滚动
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (containerRef.current) {
      containerRef.current.scrollLeft += e.deltaY;
    }
  };

  // 点击面包屑分段：导航切换资源管理器根目录
  const handleSegmentClick = async (seg: PathSegment) => {
    if (seg.isLast) {
      // 点击最后一项目录时触发目录刷新
      if (onRefresh) {
        onRefresh();
      } else {
        const nodes = await loadChildren(seg.fullPath);
        setRoot(seg.fullPath, nodes);
      }
      return;
    }

    try {
      const nodes = await loadChildren(seg.fullPath);
      setRoot(seg.fullPath, nodes);
      setRevealed('');
    } catch (err) {
      console.error('切换面包屑目录失败:', err);
    }
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      style={{
        height: 24,
        minHeight: 24,
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
        flexShrink: 0,
        borderBottom: '1px solid var(--editor-border)',
        background: 'var(--explorer-bg)',
        userSelect: 'none',
        boxSizing: 'border-box',
      }}
      title={root}
    >
      {segments.map((seg, idx) => {
        return (
          <div
            key={seg.fullPath}
            style={{
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            {/* 分隔符（首项除外） */}
            {idx > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: 'var(--explorer-text-muted)',
                  opacity: 0.6,
                  margin: '0 2px',
                  flexShrink: 0,
                }}
              >
                <ChevronRight size={11} />
              </span>
            )}

            {/* 面包屑可点击项 */}
            <button
              type="button"
              onClick={() => handleSegmentClick(seg)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                height: 18,
                padding: '0 4px',
                border: 'none',
                borderRadius: 3,
                background: 'transparent',
                color: seg.isLast ? 'var(--explorer-text)' : 'var(--explorer-text-muted)',
                fontWeight: seg.isLast ? 600 : 400,
                fontSize: 11,
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
                whiteSpace: 'nowrap',
                maxWidth: 160,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--explorer-hover)';
                e.currentTarget.style.color = 'var(--explorer-text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = seg.isLast
                  ? 'var(--explorer-text)'
                  : 'var(--explorer-text-muted)';
                e.currentTarget.style.transform = 'scale(1)';
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'scale(0.96)';
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
              }}
              title={seg.fullPath}
            >
              {seg.isDrive ? (
                <HardDrive size={11} style={{ flexShrink: 0, opacity: 0.75 }} />
              ) : (
                <Folder size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{seg.name}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
