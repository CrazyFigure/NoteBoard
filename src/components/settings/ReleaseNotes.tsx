// 关于页「更新日志」：最近 10 个版本，新版在上，每个版本默认收起、可单独展开
// 数据由 scripts/sync-changelog.mjs 从 v* 附注标签生成

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import releaseNotes from '../../core/releaseNotes.json';

interface ReleaseNoteSection {
  title: string;
  items: string[];
}

interface ReleaseNote {
  version: string;
  date: string;
  sections: ReleaseNoteSection[];
}

const RELEASE_NOTES = releaseNotes as ReleaseNote[];

export function ReleaseNotes() {
  // 记录已展开的版本，各版本互不影响
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  if (RELEASE_NOTES.length === 0) return null;

  const toggle = (version: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  return (
    <section className="nb-release-notes">
      <h3 className="nb-release-notes-heading">更新日志</h3>
      {RELEASE_NOTES.map((note) => {
        const open = expanded.has(note.version);
        return (
          <div key={note.version} className="nb-release-note">
            <button
              type="button"
              className="nb-release-note-toggle"
              aria-expanded={open}
              onClick={() => toggle(note.version)}
            >
              <ChevronRight size={14} className="nb-release-note-chevron" />
              <span className="nb-release-note-version">v{note.version}</span>
              <span className="nb-release-note-date">{note.date}</span>
            </button>
            {open && (
              <div className="nb-release-note-body">
                {note.sections.map((section, index) => (
                  <div key={`${section.title}-${index}`} className="nb-release-note-section">
                    {section.title && <div className="nb-release-note-section-title">{section.title}</div>}
                    <ul>
                      {section.items.map((item, itemIndex) => (
                        <li key={itemIndex}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
