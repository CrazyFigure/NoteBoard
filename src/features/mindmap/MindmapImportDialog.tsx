// 导入与图片导出共用主题化选择/确认弹窗，取消只结束当前步骤，不修改正文。
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MindmapConfirmDialog } from './MindmapConfirmDialog';

interface Choice { value: string; label: string }

/** 串行展示弹窗，避免多文件同时导入时两个捕获阶段快捷键一起提交。 */
let dialogQueue: Promise<unknown> = Promise.resolve();

function presentDialog<T>(render: (settle: (value: T) => void) => React.ReactNode): Promise<T> {
  const result = dialogQueue.then(() => new Promise<T>((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let settled = false;
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      // React 事件结束后再卸载，先释放弹窗监听，随后恢复仍在页面中的原焦点。
      queueMicrotask(() => {
        root.unmount();
        container.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(value);
      });
    };
    root.render(render(settle));
  }));
  dialogQueue = result.catch(() => undefined);
  return result;
}

function ChoiceDialog({ title, options, confirmLabel, onSettle }: {
  title: string; options: Choice[]; confirmLabel: string; onSettle: (value: string | null) => void;
}) {
  const [selected, setSelected] = useState(options[0]?.value ?? '');
  // 键盘聚焦和鼠标点击采用同一选择，Enter 确认时不能误导入先前选中的画布。
  return <MindmapConfirmDialog title={title} confirmLabel={confirmLabel} onConfirm={() => onSettle(selected || null)} onCancel={() => onSettle(null)}
    message={<div className="nb-mindmap-import-options" role="listbox" aria-label={title}>
      {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={selected === option.value}
        className="nb-mindmap-import-option" onFocus={() => setSelected(option.value)} onClick={() => setSelected(option.value)}>{option.label}</button>)}
    </div>} />;
}

/** 画布或导出范围必须经用户确认；Esc、取消及关闭都返回 null。 */
export function requestMindmapChoice(title: string, options: Choice[], confirmLabel: string): Promise<string | null> {
  return presentDialog((onSettle) => <ChoiceDialog title={title} options={options} confirmLabel={confirmLabel} onSettle={onSettle} />);
}

/** 同一批兼容差异与规模风险集中列出，继续转换前不改变当前导图。 */
export function confirmMindmapImport(warnings: string[]): Promise<boolean> {
  if (warnings.length === 0) return Promise.resolve(true);
  return presentDialog((settle) => <MindmapConfirmDialog title="导入前请确认" confirmLabel="继续导入" onConfirm={() => settle(true)} onCancel={() => settle(false)}
    message={<><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>继续后转换为 NoteBoard 导图，原始文件保留。</p></>} />);
}
