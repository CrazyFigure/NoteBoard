// NoteBoard Markdown 格式规范化确认框
// 进入可视化模式前发现"解析→序列化"会改变原文时弹出：说明会改什么、可查看差异，
// 由用户决定规范化并进入可视化、保持源码模式，或取消打开（不记住策略）。

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { FileCode2, Wand2, ChevronDown, ChevronRight } from 'lucide-react';
import {
  computeNormalizationDiff,
  NORMALIZATION_CATEGORY_LABELS,
  NORMALIZATION_CATEGORY_REASONS,
  type NormalizationDialogChoice,
  type NormalizationDiff,
} from './markdownNormalization';

/** 空白字符的可见符号：空格 ·、制表符 → */
function whitespaceMark(text: string): ReactNode {
  return <span className="nb-md-normalize-ws">{text.replace(/ /g, '·').replace(/\t/g, '→')}</span>;
}

/**
 * 差异文本中把"看不见"的空白显式标出：行尾空白、制表符，以及缩进差异中的行首空白。
 * 行内普通空格保持原样，避免中英混排的正文被满屏圆点干扰阅读。
 */
function renderVisibleWhitespace(text: string, showIndent: boolean): ReactNode {
  if (text === '') return <span className="nb-md-normalize-empty">（无）</span>;
  return text.split('\n').map((line, index) => {
    const trailing = /[ \t]+$/.exec(line)?.[0] ?? '';
    const body = line.slice(0, line.length - trailing.length);
    const leading = showIndent ? /^[ \t]+/.exec(body)?.[0] ?? '' : '';
    return (
      <Fragment key={index}>
        {index > 0 && '\n'}
        {leading && whitespaceMark(leading)}
        {body.slice(leading.length).split('\t').map((part, partIndex) => (
          <Fragment key={partIndex}>
            {partIndex > 0 && whitespaceMark('\t')}
            {part}
          </Fragment>
        ))}
        {trailing && whitespaceMark(trailing)}
      </Fragment>
    );
  });
}

export interface MarkdownNormalizeDialogProps {
  /** 文档显示名 */
  displayName: string;
  /** 原文 */
  original: string;
  /** 规范化后的文本 */
  normalized: string;
  /** 回写未通过稳定性校验时明确提示，必须逐次手动确认。 */
  mayChangeContent?: boolean;
  /** 大文档后台准备的差异，避免确认框在主线程重复计算。 */
  preparedDiff?: NormalizationDiff;
  /** 用户选择回调：remember 表示本次会话内对该文档记住选择 */
  onChoose: (choice: NormalizationDialogChoice, remember: boolean) => void;
}

export function MarkdownNormalizeDialog({ displayName, original, normalized, mayChangeContent = false, preparedDiff, onChoose }: MarkdownNormalizeDialogProps) {
  const [diffResult, setDiffResult] = useState<NormalizationDiff | null>(preparedDiff ?? null);
  const [showDetails, setShowDetails] = useState(mayChangeContent);
  const [remember, setRemember] = useState(false);

  // 异步计算差异摘要（差异算法按需加载）
  useEffect(() => {
    let cancelled = false;
    setDiffResult(preparedDiff ?? null);
    if (preparedDiff) return;
    computeNormalizationDiff(original, normalized)
      .then((result) => {
        if (!cancelled) setDiffResult(result);
      })
      .catch(() => {
        if (!cancelled) setDiffResult({ hunks: [], categories: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [original, normalized, preparedDiff]);

  // Esc 与取消按钮一致，中止本次打开且不记住策略，避免意外接受打开或规范化。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onChoose('cancel', false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onChoose]);

  const totalChanges = diffResult?.categories.reduce((sum, item) => sum + item.count, 0) ?? 0;

  return (
    <div className="nb-modal-overlay nb-md-normalize-overlay" role="dialog" aria-modal="true" aria-labelledby="nb-md-normalize-title">
      <div className="nb-modal-dialog nb-md-normalize-dialog">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Wand2 size={20} color="var(--accent-strong)" />
          <h2 id="nb-md-normalize-title" style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--editor-heading)' }}>
            {mayChangeContent ? '进入可视化可能改变内容或格式' : '进入可视化模式需要规范化格式'}
          </h2>
        </div>

        <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.6, color: 'var(--editor-text-secondary)' }}>
          「{displayName}」{mayChangeContent ? '经过当前可视化编辑器回写后存在差异。' : '中的部分 Markdown 写法在可视化编辑器中会以统一格式保存。'}
          请查看差异后选择；保持源码模式可保留原文，取消则关闭此文档。
        </p>

        {mayChangeContent && (
          <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.6, color: 'var(--alert-warning-border)' }}>
            检测到文字、格式范围或文档结构可能改变。请核对差异；这类变化每次都需要手动确认。
          </p>
        )}

        <div className="nb-md-normalize-summary">
          {diffResult === null ? (
            <span style={{ color: 'var(--editor-text-muted)' }}>正在分析差异…</span>
          ) : diffResult.categories.length === 0 ? (
            <span style={{ color: 'var(--editor-text-muted)' }}>无法生成差异摘要</span>
          ) : (
            <>
              <div style={{ marginBottom: 6, color: 'var(--editor-text)' }}>共 {totalChanges} 处调整：</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {diffResult.categories.map((item) => (
                  <li key={item.category}>
                    {NORMALIZATION_CATEGORY_LABELS[item.category]} × {item.count}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {diffResult && diffResult.hunks.length > 0 && (
          <button
            type="button"
            className="nb-md-normalize-toggle"
            onClick={() => setShowDetails((value) => !value)}
          >
            {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {showDetails ? '收起差异' : '查看差异'}
          </button>
        )}

        {showDetails && diffResult && (
          <div className="nb-md-normalize-diff">
            {diffResult.hunks.map((hunk, index) => (
              <div key={index} className="nb-md-normalize-hunk">
                {/* 逐处标明规范化分类与理由 */}
                <div className="nb-md-normalize-hunk-line">
                  第 {hunk.line} 行 · <span className="nb-md-normalize-hunk-category">{NORMALIZATION_CATEGORY_LABELS[hunk.category]}</span>
                  <span className="nb-md-normalize-hunk-reason">（{NORMALIZATION_CATEGORY_REASONS[hunk.category]}）</span>
                </div>
                {/* 粗粒度差异可能覆盖整篇文档，限制预览规模，避免生成数十万字符的 React 行节点。 */}
                <pre className="nb-md-normalize-before">{renderVisibleWhitespace(hunk.before.slice(0, 8_000), ['list-indent', 'whitespace'].includes(hunk.category))}</pre>
                <pre className="nb-md-normalize-after">{renderVisibleWhitespace(hunk.after.slice(0, 8_000), ['list-indent', 'whitespace'].includes(hunk.category))}</pre>
                {(hunk.before.length > 8_000 || hunk.after.length > 8_000) && <p className="nb-md-normalize-hunk-reason">此处差异较长，预览各展示前 8,000 字符。无法确认时可保持源码模式。</p>}
              </div>
            ))}
            {totalChanges > diffResult.hunks.length && (
              <div style={{ fontSize: 12, color: 'var(--editor-text-muted)', padding: '4px 0' }}>
                其余 {totalChanges - diffResult.hunks.length} 处未展示
              </div>
            )}
          </div>
        )}

        {/* 内容风险不能被会话记忆跳过；普通格式调整仍沿用原有记忆行为。 */}
        {!mayChangeContent && (
          <label className="nb-md-normalize-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            本次使用期间对此文档记住选择
          </label>
        )}

        <div className="nb-md-normalize-actions">
          {/* 取消不记住任何策略；关闭流程由宿主统一执行并保护未保存修改。 */}
          <button
            type="button"
            className="nb-btn-secondary nb-md-normalize-cancel"
            onClick={() => onChoose('cancel', false)}
            style={{ padding: '6px 14px', fontSize: 13 }}
          >
            取消
          </button>
          {/* 安全选项：保持源码模式，原文不做任何改动 */}
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={() => onChoose('source', !mayChangeContent && remember)}
            style={{ padding: '6px 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <FileCode2 size={14} />
            保持源码模式
          </button>
          {/* 主操作：规范化并进入可视化（文档将标记为已修改，由用户决定是否保存） */}
          <button
            type="button"
            className="nb-btn-primary"
            onClick={() => onChoose('normalize', !mayChangeContent && remember)}
            style={{ padding: '6px 16px', fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Wand2 size={14} />
            {mayChangeContent ? '确认差异并进入可视化' : '规范化并进入可视化'}
          </button>
        </div>
      </div>
    </div>
  );
}
