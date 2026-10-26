// NoteBoard 双向链接弹窗
// 图形化插入 / 编辑双链：搜索并选择笔记 → 可选标题 → 可选显示名（嵌入图片时为显示宽度）→ 链接或嵌入。
// 底部实时显示对应的 Markdown 写法，用多了自然记住语法；外观沿用全局输入弹窗（nb-prompt），随主题与移动端适配。

import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Link2, Trash2, Waypoints, X } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { getExplorerFileIcon } from '../explorer/fileIcons';
import { useWikiLinkDialogStore, type WikiLinkDialogResult } from './wikiLinkDialogStore';
import {
  createExternalEntry,
  getNoteIndexVersion,
  linkTargetFor,
  peekNoteIndex,
  resolveVaultRoot,
  searchNotes,
  subscribeNoteIndex,
  type NoteEntry,
} from './noteIndex';
import { docPathOf, loadNoteHeadings, openDocumentEntries, resolveWikiLinkNow } from './wikiLinkNavigation';
import {
  EMBED_IMAGE_EXTENSIONS,
  formatWikiLinkInner,
  parseWikiLinkInner,
  wikiLinkLabel,
  type NoteHeading,
} from './wikiLinkSyntax';

/** 候选列表最多显示的条数 */
const CANDIDATE_LIMIT = 8;
/** 停止输入后多久解析目标（显示找到 / 未找到、读取标题） */
const RESOLVE_DELAY_MS = 160;

/** 弹窗面板（由 WikiLinkDialogHost 按需加载并以请求 id 为 key 挂载） */
export function WikiLinkDialogPortal() {
  return createPortal(<WikiLinkDialog />, document.body);
}

/** 显示名 / 宽度输入里的方括号、竖线、换行会破坏语法 */
function sanitizePart(value: string): string {
  return value.replace(/[[\]|\r\n]/g, '').trim();
}

function WikiLinkDialog() {
  const request = useWikiLinkDialogStore((state) => state.request)!;
  const settle = useWikiLinkDialogStore((state) => state.settle);
  const initial = useMemo(() => parseWikiLinkInner(request.inner ?? ''), [request.inner]);
  const isEdit = request.mode === 'edit';

  const [target, setTarget] = useState(initial.target);
  const [heading, setHeading] = useState(initial.heading);
  const [alias, setAlias] = useState(initial.alias || request.alias || '');
  const [embed, setEmbed] = useState(request.embed === true);
  // 新建时直接展开笔记列表；编辑时目标已确定，聚焦输入后再展开
  const [listOpen, setListOpen] = useState(!isEdit);
  const [activeIndex, setActiveIndex] = useState(0);
  const [headings, setHeadings] = useState<NoteHeading[]>([]);

  const targetInputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const prevFocusRef = useRef<Element | null>(document.activeElement);

  // 索引重建、仓库外路径探测完成后刷新候选与解析状态
  const indexVersion = useSyncExternalStore(subscribeNoteIndex, getNoteIndexVersion);
  const fromPath = useMemo(() => docPathOf(request.docKey), [request.docKey]);
  // 输入框立即响应；候选搜索作为低优先级更新，大仓库逐字输入也不卡
  const deferredTarget = useDeferredValue(target);
  // 解析目标（写了路径时会探测磁盘）在停止输入片刻后再做，避免每个字符都发起探测
  const [settledTarget, setSettledTarget] = useState(target);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledTarget(target), RESOLVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [target]);

  const candidates = useMemo(() => {
    void indexVersion;
    const root = resolveVaultRoot(fromPath);
    const snapshot = root ? peekNoteIndex(root) : null;
    return searchNotes(snapshot, deferredTarget, fromPath, CANDIDATE_LIMIT, openDocumentEntries()).map((entry) => ({
      entry,
      target: linkTargetFor(snapshot, entry, fromPath),
    }));
  }, [deferredTarget, fromPath, indexVersion]);

  const resolution = useMemo(() => {
    void indexVersion;
    const trimmed = settledTarget.trim();
    return trimmed ? resolveWikiLinkNow(trimmed, request.docKey) : null;
  }, [settledTarget, request.docKey, indexVersion]);
  const resolvedEntry: NoteEntry | null = resolution?.status === 'resolved' ? resolution.entry : null;
  const isImage = embed && resolvedEntry !== null && EMBED_IMAGE_EXTENSIONS.has(resolvedEntry.ext);
  // 标题来源：目标笔记；目标留空时为当前文档（`[[#标题]]` 文内跳转）
  const headingSource = resolvedEntry ?? (!target.trim() && fromPath ? createExternalEntry(fromPath) : null);

  // 目标确定为 Markdown 笔记后读取其标题，供选择锚点
  const resolvedPath = headingSource?.isMarkdown ? headingSource.path : null;
  useEffect(() => {
    if (!headingSource || !resolvedPath) {
      setHeadings([]);
      return;
    }
    let cancelled = false;
    void loadNoteHeadings(headingSource).then((list) => {
      if (!cancelled) setHeadings(list);
    });
    return () => {
      cancelled = true;
    };
    // 只随目标路径变化重新读取（条目对象每次重新计算，不能作为依赖）
  }, [resolvedPath]);

  const trimmedTarget = target.trim().replace(/[[\]|#\r\n]/g, '');
  // 笔记输入框里直接写了 `笔记#标题|显示名` 时拆到对应的字段
  const changeTarget = (value: string) => {
    if (!/[#|]/.test(value)) {
      setTarget(value);
      return;
    }
    const parts = parseWikiLinkInner(value);
    setTarget(parts.target);
    if (parts.heading) setHeading(parts.heading);
    if (parts.alias) setAlias(parts.alias);
  };
  const inner = formatWikiLinkInner({ target: trimmedTarget, heading: sanitizePart(heading).replace(/#/g, ''), alias: sanitizePart(alias) });
  const syntax = `${embed ? '!' : ''}[[${inner}]]`;
  const canSubmit = Boolean(trimmedTarget || heading.trim());

  const close = (result: WikiLinkDialogResult | null) => {
    const prev = prevFocusRef.current;
    if (result === null && prev instanceof HTMLElement && prev.isConnected) prev.focus({ preventScroll: true });
    settle(result);
  };

  const submit = () => {
    if (!canSubmit) return;
    close({ action: 'confirm', inner, embed });
  };

  const pickCandidate = (index: number) => {
    const item = candidates[index];
    if (!item) return;
    setTarget(item.target);
    // 换了目标笔记，原来选的标题不再适用
    if (item.target !== target) setHeading('');
    setListOpen(false);
  };

  // 键盘与按钮回调都经 ref 取最新闭包，监听器只需绑定一次
  const stateRef = useRef({ listOpen, candidates, activeIndex, submit, pickCandidate, close });
  stateRef.current = { listOpen, candidates, activeIndex, submit, pickCandidate, close };

  // 打开后聚焦：新建聚焦笔记输入框，编辑聚焦确认按钮
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (isEdit) confirmRef.current?.focus();
      else targetInputRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [isEdit]);

  /**
   * 在 window 捕获阶段接管键盘：弹窗叠在编辑器之上，按键不能继续传到编辑器或全局快捷键。
   * 笔记列表展开时 ↑↓ 选择、Enter 选中；否则 Enter 确认，Esc 先收起列表再关闭弹窗。
   */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const state = stateRef.current;
      const inTargetInput = event.target === targetInputRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (state.listOpen) setListOpen(false);
        else state.close(null);
        return;
      }
      if (inTargetInput && state.listOpen && state.candidates.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setActiveIndex((index) => (index + delta + state.candidates.length) % state.candidates.length);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          state.pickCandidate(state.activeIndex);
          return;
        }
      }
      if (event.key === 'Enter' && (event.target as HTMLElement | null)?.tagName !== 'BUTTON' && (event.target as HTMLElement | null)?.tagName !== 'SELECT') {
        event.preventDefault();
        event.stopPropagation();
        state.submit();
        return;
      }
      if (event.key === 'Tab') event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  /** 目标的解析状态说明 */
  let status: { tone: 'ok' | 'warn' | 'muted'; text: string };
  if (!target.trim()) status = { tone: 'muted', text: '从列表选择，或输入文件名、相对路径、完整路径；留空可链接到本文的标题' };
  else if (resolution?.status === 'resolved') {
    status = { tone: 'ok', text: `${resolution.entry.external ? '仓库外 · ' : ''}${resolution.entry.relPath}` };
  } else if (resolution?.status === 'pending') status = { tone: 'muted', text: '正在查找…' };
  else status = { tone: 'warn', text: '未找到这篇笔记，仍可插入：同步到本机或新建后自动生效' };

  return (
    <div
      className="nb-prompt-overlay nb-wikidialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close(null);
      }}
    >
      <div
        className="nb-prompt nb-wikidialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nb-wikidialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nb-prompt-head">
          <div className="nb-prompt-icon">
            <Waypoints size={17} />
          </div>
          <div className="nb-prompt-heading">
            <div id="nb-wikidialog-title" className="nb-prompt-title">
              {isEdit ? '编辑双向链接' : '插入双向链接'}
            </div>
            <div className="nb-prompt-desc">链接到仓库内的其它笔记，或直接嵌入它的内容</div>
          </div>
          <Tooltip content="关闭" shortcut="Esc" side="bottom" sideOffset={4}>
            <button type="button" className="nb-prompt-close" aria-label="关闭" onClick={() => close(null)}>
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="nb-prompt-body">
          {/* 笔记：输入即搜索，下方列出候选 */}
          <label className="nb-wikidialog-label" htmlFor="nb-wikidialog-target">笔记</label>
          <div className="nb-wikidialog-combo">
            <div className="nb-prompt-field">
              <input
                id="nb-wikidialog-target"
                ref={targetInputRef}
                className="nb-prompt-input"
                type="text"
                value={target}
                placeholder="搜索笔记名称或路径"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                onFocus={() => setListOpen(true)}
                onChange={(event) => {
                  changeTarget(event.target.value);
                  setActiveIndex(0);
                  setListOpen(true);
                }}
              />
            </div>
            {listOpen && candidates.length > 0 && (
              <div className="nb-wikidialog-list" role="listbox">
                {candidates.map((item, index) => (
                  <button
                    key={item.entry.path}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={`nb-wikilink-menu-item${index === activeIndex ? ' is-active' : ''}`}
                    // 不让输入框失焦，选中后可继续用键盘操作
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => pickCandidate(index)}
                  >
                    <span className="nb-wikilink-menu-icon">
                      {item.entry.isMarkdown ? <FileText size={15} /> : getExplorerFileIcon(item.entry.name, { size: 15 })}
                    </span>
                    <span className="nb-wikilink-menu-text">
                      <span className="nb-wikilink-menu-name">
                        {item.entry.isMarkdown ? item.entry.stem : item.entry.name}
                        {item.entry.external && <span className="nb-wikilink-menu-badge">仓库外</span>}
                      </span>
                      {item.entry.relPath.includes('/') && (
                        <span className="nb-wikilink-menu-path">{item.entry.relPath.replace(/\/[^/]*$/, '')}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={`nb-wikidialog-status is-${status.tone}`}>{status.text}</div>

          {/* 标题：目标为 Markdown 笔记时可选 */}
          <label className="nb-wikidialog-label" htmlFor="nb-wikidialog-heading">定位到标题（选填）</label>
          <select
            id="nb-wikidialog-heading"
            className="nb-wikidialog-select"
            value={heading}
            disabled={headings.length === 0 && !heading}
            onChange={(event) => setHeading(event.target.value)}
          >
            <option value="">{headings.length === 0 && !heading ? '这篇笔记没有可选标题' : '整篇笔记'}</option>
            {/* 已写的标题在笔记中找不到时仍保留为选项，避免打开弹窗就被清掉 */}
            {heading && !headings.some((item) => item.text === heading) && <option value={heading}>{heading}</option>}
            {headings.map((item, index) => (
              <option key={`${item.text}:${index}`} value={item.text}>
                {`${'　'.repeat(Math.min(item.level - 1, 4))}${item.text}`}
              </option>
            ))}
          </select>

          {/* 显示名；嵌入时为尺寸：图片是宽度，笔记是卡片高度 */}
          <label className="nb-wikidialog-label" htmlFor="nb-wikidialog-alias">
            {isImage ? '显示宽度（选填）' : embed ? '卡片高度（选填）' : '显示名（选填）'}
          </label>
          <div className="nb-prompt-field">
            <input
              id="nb-wikidialog-alias"
              className="nb-prompt-input"
              type="text"
              inputMode={embed ? 'numeric' : undefined}
              value={alias}
              placeholder={
                isImage
                  ? '如 300 或 300x200（像素）'
                  : embed
                    ? '如 400（像素），留空自动；也可在正文中拖动卡片底边调整'
                    : wikiLinkLabel({ target: trimmedTarget, heading, alias: '' }) || '默认显示笔记名'
              }
              spellCheck={false}
              onFocus={() => setListOpen(false)}
              onChange={(event) => setAlias(event.target.value)}
            />
          </div>

          {/* 显示方式 */}
          <div className="nb-wikidialog-label">显示方式</div>
          <div className="nb-wikidialog-modes" role="radiogroup">
            <button
              type="button"
              role="radio"
              aria-checked={!embed}
              className={`nb-wikidialog-mode${!embed ? ' is-active' : ''}`}
              onClick={() => setEmbed(false)}
            >
              <Link2 size={15} />
              <span className="nb-wikidialog-mode-text">
                <span>链接</span>
                <small>正文中显示为可点击的链接</small>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={embed}
              className={`nb-wikidialog-mode${embed ? ' is-active' : ''}`}
              onClick={() => setEmbed(true)}
            >
              <FileText size={15} />
              <span className="nb-wikidialog-mode-text">
                <span>嵌入</span>
                <small>直接显示图片或笔记内容</small>
              </span>
            </button>
          </div>

          {/* 对应写法：直接在正文输入同样有效 */}
          <div className="nb-wikidialog-syntax">
            <span>Markdown 写法</span>
            <code>{syntax}</code>
          </div>

          {/* 编辑已有链接：打开目标或删除链接 */}
          {isEdit && (
            <div className="nb-wikidialog-actions">
              {resolvedEntry && (
                <button type="button" className="nb-wikidialog-action" onClick={() => close({ action: 'open', inner })}>
                  <ExternalLink size={14} />
                  打开笔记
                </button>
              )}
              <button type="button" className="nb-wikidialog-action is-danger" onClick={() => close({ action: 'remove' })}>
                <Trash2 size={14} />
                删除链接
              </button>
            </div>
          )}
        </div>

        <div className="nb-prompt-foot">
          <span className="nb-prompt-hint">
            <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 取消
          </span>
          <button type="button" className="nb-btn-secondary" onClick={() => close(null)}>
            取消
          </button>
          <button ref={confirmRef} type="button" className="nb-btn-primary" disabled={!canSubmit} onClick={submit}>
            {isEdit ? '保存' : '插入'}
          </button>
        </div>
      </div>
    </div>
  );
}
