// 可编辑文档共用的磁盘修改确认：重载外部版本，或把当前编辑内容另存到新文件。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, FolderOutput, Loader2, RefreshCw } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore, type Tab } from '../../stores/windowStore';
import { saveAs } from '../editor-code/orchestration/saveDocument';
import { reloadFromDisk } from './externalChangeActions';
import { useExternalFileChanges } from './useExternalFileChanges';
import { useBackDismiss } from '../../mobile/components';
import { setShortcutsSuspended } from '../../core/shortcuts';
import './externalChange.css';

/** 在两种外壳各挂载一次，检测与提示不依赖任何具体编辑器或资源管理器。 */
export function ExternalChangeDialog() {
  useExternalFileChanges();
  const tab = useWindowStore((state) => state.tabs.find((item) => item.key === state.activeKey));
  const status = useDocumentStore((state) => tab ? state.documents.get(tab.key)?.externalStatus : null);
  if (!tab || tab.isDetached || status !== 'modified') return null;
  // 标签切换时重建操作状态，异步旧操作不会把错误或忙碌状态带给新文档。
  return createPortal(<ChangeConfirmation key={tab.key} tab={tab} />, document.body);
}

function ChangeConfirmation({ tab }: { tab: Tab }) {
  const dirty = useDocumentStore((state) => state.documents.get(tab.key)?.isDirty);
  const [action, setAction] = useState<'reload' | 'saveAs' | null>(null);
  const [error, setError] = useState('');
  const saveAsRef = useRef<HTMLButtonElement>(null);
  // React 更新提交前也锁住操作，防止快速双击重复读盘或打开多个路径选择器。
  const operating = useRef(false);
  // Android 返回键也必须留在当前冲突选择；另存命名框打开时交回其自身返回键处理。
  useBackDismiss(action !== 'saveAs', () => {});
  useEffect(() => {
    // 应用快捷键在 window 捕获阶段执行，须显式暂停，不能仅靠弹窗内部阻止冒泡。
    setShortcutsSuspended(true);
    return () => setShortcutsSuspended(false);
  }, []);

  /** 失败或取消另存时保留冲突保护和提示，成功才由文档状态关闭弹窗。 */
  const decide = async (next: 'reload' | 'saveAs') => {
    if (operating.current) return;
    operating.current = true;
    setAction(next);
    setError('');
    try {
      // saveAs 自带授权后的权威快照屏障，不能用打开弹窗时的旧正文保存。
      const ok = next === 'reload'
        ? await reloadFromDisk(tab.key)
        : await saveAs(tab.key, '');
      if (!ok && next === 'reload') setError('未能重新加载文件，请检查原文件后重试。当前编辑内容仍保留。');
    } catch (failure) {
      console.error('处理磁盘文件修改失败:', failure);
      setError('操作未完成，当前编辑内容仍保留，请重试。');
    } finally {
      operating.current = false;
      setAction(null);
    }
  };

  return (
    // 选择另存路径时暂时让出模态层与焦点，兼容移动端命名框和网页文件选择器。
    <Dialog.Root open={action !== 'saveAs'}>
      <Dialog.Overlay className="nb-prompt-overlay nb-external-overlay">
        <Dialog.Content
          className="nb-prompt nb-external-dialog"
          aria-busy={action !== null}
          onOpenAutoFocus={(event) => { event.preventDefault(); saveAsRef.current?.focus(); }}
          // 两种操作都需要明确选择；Esc、点击遮罩均不丢弃编辑内容，也不解除保存保护。
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onKeyDownCapture={(event) => {
            // 拦住编辑器/外壳快捷键，Tab 焦点由 Radix 约束在当前弹窗。
            if (event.ctrlKey || event.metaKey || event.altKey) event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="nb-prompt-head">
            <div className="nb-prompt-icon"><RefreshCw size={18} /></div>
            <div className="nb-prompt-heading">
              <Dialog.Title className="nb-prompt-title">文件在磁盘上已更改</Dialog.Title>
              <Dialog.Description className="nb-prompt-desc">检测到其他程序更新了此文件，请选择要保留的内容。</Dialog.Description>
            </div>
          </div>
          <div className="nb-prompt-body">
            <div className="nb-external-file">
              <FileText size={18} aria-hidden="true" />
              <div>
                <div className="nb-external-name">{tab.displayName}</div>
                <div className="nb-external-path">{tab.path}</div>
              </div>
            </div>
            <p className="nb-external-description">
              {dirty ? '当前有未保存的修改。重新加载将替换当前编辑内容；另存为可将当前内容保存到新文件。'
                : '重新加载以查看磁盘上的最新内容，或将当前内容另存为新文件。'}
            </p>
            <p className="nb-external-protection">处理前已暂停此文件的自动保存。</p>
            {error && <p className="nb-prompt-error" role="alert">{error}</p>}
          </div>
          <div className="nb-prompt-foot nb-external-actions">
            <button type="button" className="nb-btn-secondary" ref={saveAsRef} disabled={action !== null} onClick={() => void decide('saveAs')}>
              <FolderOutput size={15} />另存为
            </button>
            <button type="button" className="nb-btn-primary" disabled={action !== null} onClick={() => void decide('reload')}>
              {action === 'reload' ? <Loader2 size={15} className="nb-prompt-spin" /> : <RefreshCw size={15} />}
              {action === 'reload' ? '正在重新加载' : '重新加载'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Overlay>
    </Dialog.Root>
  );
}
