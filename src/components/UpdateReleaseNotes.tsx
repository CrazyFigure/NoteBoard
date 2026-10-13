// NoteBoard 更新弹窗的分版本更新日志
// 把当前版本之后的每个未安装版本渲染为可折叠卡片：单个版本默认展开，多个版本默认全部折叠；
// Release 正文按"新增 / 修复 / 优化"等小节解析，折叠时在标题行展示各类条目数量摘要。

import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { Tooltip } from './Tooltip';
import type { UpdateReleaseNote } from '../core/ipc/types';

interface UpdateReleaseNotesProps {
  notes: UpdateReleaseNote[];
  /** 未安装版本超出单页列表，更早的日志需前往 Release 页面查看 */
  truncated?: boolean;
  onOpenUrl: (url: string) => void;
}

/** 小节类型：决定小节标题与摘要圆点的配色 */
type SectionKind = 'added' | 'fixed' | 'improved' | 'other';

interface NoteLine {
  /** 是否为列表项（否则为普通段落） */
  bullet: boolean;
  /** 列表缩进层级（0 为顶层） */
  depth: number;
  text: string;
}

interface NoteSection {
  title: string | null;
  kind: SectionKind;
  lines: NoteLine[];
}

const KIND_LABELS: Record<SectionKind, string> = {
  added: '新增',
  fixed: '修复',
  improved: '优化',
  other: '其他',
};

/** 按小节标题关键词判断类型 */
function detectKind(title: string): SectionKind {
  const normalized = title.toLowerCase();
  if (/新增|新功能|feat|add|new/.test(normalized)) return 'added';
  if (/修复|修正|fix|bug/.test(normalized)) return 'fixed';
  if (/优化|改进|调整|变更|重构|性能|improve|perf|change|refactor/.test(normalized)) return 'improved';
  return 'other';
}

/** 识别小节标题：Markdown 标题、整行加粗，或以冒号结尾的短行（如"新增："） */
function matchHeading(line: string): string | null {
  const markdownHeading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
  if (markdownHeading) return markdownHeading[1].replace(/[：:]$/, '');
  const boldHeading = /^\*\*(.+?)\*\*\s*[：:]?$/.exec(line);
  if (boldHeading) return boldHeading[1].replace(/[：:]$/, '');
  const colonHeading = /^([^\s-*+].{0,15}?)\s*[：:]$/.exec(line);
  if (colonHeading) return colonHeading[1];
  return null;
}

/** 将 Release 正文解析为小节；没有小节标题的内容归入无标题小节 */
function parseReleaseBody(body: string): NoteSection[] {
  const sections: NoteSection[] = [];
  let current: NoteSection | null = null;

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (!rawLine.trim()) continue;
    const heading = matchHeading(rawLine.trim());
    if (heading) {
      current = { title: heading, kind: detectKind(heading), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: null, kind: 'other', lines: [] };
      sections.push(current);
    }
    // 列表项：- / * / + 或有序编号；缩进每 2 个空格视为一级
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(rawLine);
    if (item) {
      current.lines.push({ bullet: true, depth: Math.min(2, Math.floor(item[1].length / 2)), text: item[2] });
    } else {
      current.lines.push({ bullet: false, depth: 0, text: rawLine.trim() });
    }
  }
  return sections.filter((section) => section.lines.length > 0 || section.title);
}

/** 渲染行内 Markdown：**加粗**、`代码`，链接只保留文字 */
function renderInline(text: string): ReactNode {
  const plain = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const parts = plain.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

/** 发布日期格式化为 YYYY-MM-DD */
function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 统计各类型的列表条目数，用于折叠时的摘要 */
function summarize(sections: NoteSection[]): Array<{ kind: SectionKind; count: number }> {
  const counts = new Map<SectionKind, number>();
  for (const section of sections) {
    if (!section.title) continue;
    const count = section.lines.filter((line) => line.bullet && line.depth === 0).length || section.lines.length;
    counts.set(section.kind, (counts.get(section.kind) ?? 0) + count);
  }
  return (['added', 'fixed', 'improved', 'other'] as SectionKind[])
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind)! }));
}

interface VersionCardProps {
  note: UpdateReleaseNote;
  isLatest: boolean;
  open: boolean;
  onToggle: () => void;
  onOpenUrl: (url: string) => void;
}

/** 单个版本的可折叠卡片 */
function VersionCard({ note, isLatest, open, onToggle, onOpenUrl }: VersionCardProps) {
  const bodyId = useId();
  const sections = useMemo(() => parseReleaseBody(note.body ?? ''), [note.body]);
  const summary = useMemo(() => summarize(sections), [sections]);
  const date = formatDate(note.publishedAt);

  return (
    <div className={`nb-update-version${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="nb-update-version-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <ChevronRight size={15} className="nb-update-version-chevron" />
        <span className="nb-update-version-tag">v{note.version}</span>
        {isLatest && <span className="nb-update-badge">最新</span>}
        {/* 折叠时展示各类条目数量摘要，展开后隐藏避免与正文重复 */}
        <span className="nb-update-version-summary" aria-hidden={open}>
          {summary.map(({ kind, count }) => (
            <span key={kind} className={`nb-update-summary-item is-${kind}`}>
              <i />
              {KIND_LABELS[kind]} {count}
            </span>
          ))}
        </span>
        {date && <span className="nb-update-version-date">{date}</span>}
      </button>

      <div className="nb-update-version-body" id={bodyId} role="region">
        <div className="nb-update-version-inner">
          {sections.length === 0 ? (
            <p className="nb-update-empty">该版本暂无详细日志说明。</p>
          ) : (
            sections.map((section, sectionIndex) => (
              <div key={sectionIndex} className="nb-update-section">
                {section.title && (
                  <div className={`nb-update-section-title is-${section.kind}`}>{section.title}</div>
                )}
                <ul className="nb-update-lines">
                  {section.lines.map((line, lineIndex) => (
                    <li
                      key={lineIndex}
                      className={line.bullet ? 'is-bullet' : 'is-text'}
                      style={line.depth ? { marginLeft: line.depth * 14 } : undefined}
                    >
                      {renderInline(line.text)}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          {note.url && (
            <Tooltip content="在 GitHub 查看该版本的 Release 页面" side="top" sideOffset={4}>
              <button type="button" className="nb-update-version-link" onClick={() => onOpenUrl(note.url)}>
                <ExternalLink size={12} />
                <span>查看 v{note.version} 发布页</span>
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

export function UpdateReleaseNotes({ notes, truncated = false, onOpenUrl }: UpdateReleaseNotesProps) {
  // 单个版本默认展开；多个版本默认全部折叠，由用户按需展开
  const [openVersions, setOpenVersions] = useState<Set<string>>(() =>
    notes.length === 1 ? new Set([notes[0].version]) : new Set(),
  );
  const allOpen = notes.length > 0 && notes.every((note) => openVersions.has(note.version));

  // 切换单个版本的展开状态
  const toggleVersion = (version: string) => {
    setOpenVersions((previous) => {
      const next = new Set(previous);
      if (next.has(version)) {
        next.delete(version);
      } else {
        next.add(version);
      }
      return next;
    });
  };

  // 一键展开 / 收起全部版本
  const toggleAll = () => {
    setOpenVersions(allOpen ? new Set() : new Set(notes.map((note) => note.version)));
  };

  return (
    <div className="nb-update-notes">
      <div className="nb-update-notes-head">
        <span className="nb-update-notes-title">
          更新日志
          {notes.length > 1 && <span className="nb-update-notes-count">{notes.length} 个版本</span>}
        </span>
        {notes.length > 1 && (
          <button type="button" className="nb-update-text-btn" onClick={toggleAll}>
            {allOpen ? '全部收起' : '全部展开'}
          </button>
        )}
      </div>

      <div className="nb-update-version-list">
        {notes.map((note, index) => (
          <VersionCard
            key={note.version}
            note={note}
            isLatest={index === 0}
            open={openVersions.has(note.version)}
            onToggle={() => toggleVersion(note.version)}
            onOpenUrl={onOpenUrl}
          />
        ))}
        {truncated && (
          <p className="nb-update-truncated">更早版本的更新日志较多，可前往 Release 页面查看完整记录。</p>
        )}
      </div>
    </div>
  );
}
