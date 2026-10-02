// NoteBoard Markdown 格式规范化确认框
// 进入可视化模式前发现"解析→序列化"会改变原文时弹出：说明会改什么、可查看差异，
// 由用户决定规范化并进入可视化，或保持源码模式（原文一字不改）。

import { useEffect, useState } from 'react';
import { FileCode2, Wand2, ChevronDown, ChevronRight } from 'lucide-react';
import {
  computeNormalizationDiff,
  NORMALIZATION_CATEGORY_LABELS,
  type NormalizationChoice,
  type NormalizationDiff,
} from './markdownNormalization';

export interface MarkdownNormalizeDialogProps {
  /** 文档显示名 */
  displayName: string;
  /** 原文 */
  original: string;
  /** 规范化后的文本 */
  normalized: string;
  /** 用户选择回调：remember 表示本次会话内对该文档记住选择 */
  onChoose: (choice: NormalizationChoice, remember: boolean) => void;
}

export function MarkdownNormalizeDialog({ displayName, original, normalized, onChoose }: MarkdownNormalizeDialogProps) {
  const [diffResult, setDiffResult] = useState<NormalizationDiff | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [remember, setRemember] = useState(false);

  // 异步计算差异摘要（差异算法按需加载）
  useEffect(() => {
    let cancelled = false;
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
  }, [original, normalized]);

  // Esc 等同于"保持源码模式"（最安全的默认选择）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onChoose('source', remember);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onChoose, remember]);

  const totalChanges = diffResult?.categories.reduce((sum, item) => sum + item.count, 0) ?? 0;

  return (
    <div className="nb-modal-overlay nb-md-normalize-overlay" role="dialog" aria-modal="true" aria-labelledby="nb-md-normalize-title">
      <div className="nb-modal-dialog nb-md-normalize-dialog">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Wand2 size={20} color="var(--accent-strong)" />
          <h2 id="nb-md-normalize-title" style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--editor-heading)' }}>
            进入可视化模式需要规范化格式
          </h2>
        </div>

        <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.6, color: 'var(--editor-text-secondary)' }}>
          「{displayName}」中的部分 Markdown 写法在可视化编辑器中会以统一格式保存。
          文档内容与渲染效果不变，但源码写法会被调整。
        </p>

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
                <div className="nb-md-normalize-hunk-line">第 {hunk.line} 行</div>
                <pre className="nb-md-normalize-before">{hunk.before || ' '}</pre>
                <pre className="nb-md-normalize-after">{hunk.after || ' '}</pre>
              </div>
            ))}
            {totalChanges > diffResult.hunks.length && (
              <div style={{ fontSize: 12, color: 'var(--editor-text-muted)', padding: '4px 0' }}>
                其余 {totalChanges - diffResult.hunks.length} 处未展示
              </div>
            )}
          </div>
        )}

        <label className="nb-md-normalize-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          本次使用期间对此文档记住选择
        </label>

        <div className="nb-md-normalize-actions">
          {/* 安全选项：保持源码模式，原文不做任何改动 */}
          <button
            type="button"
            className="nb-btn-secondary"
            onClick={() => onChoose('source', remember)}
            style={{ padding: '6px 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <FileCode2 size={14} />
            保持源码模式
          </button>
          {/* 主操作：规范化并进入可视化（文档将标记为已修改，由用户决定是否保存） */}
          <button
            type="button"
            className="nb-btn-primary"
            onClick={() => onChoose('normalize', remember)}
            style={{ padding: '6px 16px', fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Wand2 size={14} />
            规范化并进入可视化
          </button>
        </div>
      </div>
    </div>
  );
}
