// NoteBoard 反向链接面板
// 列出仓库内链接到当前文档的笔记及引用上下文，点击笔记名或片段打开来源笔记。
// 与大纲共用侧栏（桌面）/ 底部面板（移动端），随当前文档、索引重建与已打开文档的编辑自动刷新。

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { useWindowStore } from '../../stores/windowStore';
import { useDocumentStore } from '../../stores/documentStore';
import { collectBacklinks, type BacklinkGroup, type BacklinkItem } from './backlinks';
import { getNoteIndexVersion, invalidateNoteIndex, subscribeNoteIndex } from './noteIndex';
import { openNotePath, revealWikiOccurrence, whenDocumentReady } from './wikiLinkNavigation';
import { parseWikiLinkInner, wikiLinkLabel } from './wikiLinkSyntax';

/** 已打开文档编辑后的刷新防抖 */
const CONTENT_REFRESH_DELAY_MS = 1500;

/** 把片段中的 `[[...]]` 渲染为链接样式，其余保持原文 */
function renderSnippet(snippet: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(!?)\[\[([^[\]\r\n]+?)\]\]/g;
  let last = 0;
  for (let match = pattern.exec(snippet); match; match = pattern.exec(snippet)) {
    if (match.index > last) nodes.push(snippet.slice(last, match.index));
    const parts = parseWikiLinkInner(match[2]);
    nodes.push(
      <span key={match.index} className="nb-backlinks-snippet-link">
        {/* 嵌入的 `|` 后面是尺寸，不作为显示名 */}
        {wikiLinkLabel(match[1] ? { ...parts, alias: '' } : parts)}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < snippet.length) nodes.push(snippet.slice(last));
  return nodes;
}

/** 打开来源笔记；指定引用时定位到该处双链 */
async function openSource(path: string, item?: BacklinkItem): Promise<void> {
  if (!(await openNotePath(path)) || !item) return;
  whenDocumentReady(path, (docKey) => revealWikiOccurrence(docKey, item.occurrence, item.line));
}

export function BacklinksPanel() {
  const activePath = useWindowStore((state) => (state.activeKey ? state.getTab(state.activeKey)?.path ?? null : null));
  const indexVersion = useSyncExternalStore(subscribeNoteIndex, getNoteIndexVersion);
  const [groups, setGroups] = useState<BacklinkGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [contentTick, setContentTick] = useState(0);

  // 已打开文档的内容镜像变化（编辑、保存）后防抖刷新：其中新增或删除的链接需要反映出来
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useDocumentStore.subscribe((next, previous) => {
      if (next.documents === previous.documents) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setContentTick((tick) => tick + 1), CONTENT_REFRESH_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 切换文档时先清空，避免短暂显示上一篇文档的反向链接
  useEffect(() => {
    setGroups(null);
  }, [activePath]);

  useEffect(() => {
    if (!activePath) {
      setGroups(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    collectBacklinks(activePath, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setGroups(result);
      })
      .catch((error) => {
        console.error('[backlinks] 收集反向链接失败:', error);
        if (!controller.signal.aborted) setGroups([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [activePath, indexVersion, contentTick]);

  const total = useMemo(() => (groups ?? []).reduce((sum, group) => sum + group.items.length, 0), [groups]);

  if (!activePath) {
    return <div className="nb-backlinks-empty">文档保存后可查看反向链接</div>;
  }

  return (
    <div className="nb-backlinks">
      <div className="nb-backlinks-toolbar">
        <span>{groups === null ? '正在扫描笔记…' : `${groups.length} 篇笔记 · ${total} 处引用`}</span>
        <Tooltip content="重新扫描">
          <button
            type="button"
            className={`nb-backlinks-refresh${loading ? ' is-loading' : ''}`}
            aria-label="重新扫描"
            data-sheet-keep=""
            onClick={() => {
              // 重建索引（有变化才会通知）的同时立即重新收集一次
              invalidateNoteIndex();
              setContentTick((tick) => tick + 1);
            }}
          >
            <RefreshCw size={12} />
          </button>
        </Tooltip>
      </div>
      {groups !== null && groups.length === 0 && (
        <div className="nb-backlinks-empty">
          暂无笔记链接到这里<br />
          在其它笔记中输入 [[ 即可链接
        </div>
      )}
      <div className="nb-backlinks-list">
        {(groups ?? []).map((group) => (
          <div key={group.path} className="nb-backlinks-group">
            <Tooltip content={group.relPath} side="left">
              <button type="button" className="nb-backlinks-source" onClick={() => void openSource(group.path)}>
                <FileText size={13} />
                <span className="nb-backlinks-source-name">{group.name}</span>
                <span className="nb-backlinks-count">{group.items.length}</span>
              </button>
            </Tooltip>
            {group.items.map((item, index) => (
              <button
                key={`${item.line}:${index}`}
                type="button"
                className="nb-backlinks-snippet"
                onClick={() => void openSource(group.path, item)}
              >
                {renderSnippet(item.snippet)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
