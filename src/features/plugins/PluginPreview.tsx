// Office / PDF 只读宿主：安装状态、异步任务代际和卸载清理由宿主管理。
import { useEffect, useRef, useState } from 'react';
import { Download, Power } from 'lucide-react';
import { useDocumentStore } from '../../stores/documentStore';
import { initializePlugins, usePluginStore } from '../../stores/pluginStore';
import { readPreviewFile } from '../../core/ipc/commands';
import { loadPlugin } from './pluginService';
import { OFFICIAL_PLUGINS, previewPluginFor } from './pluginTypes';
import { openPluginSettings } from './openPluginSettings';
import { ProgressRing } from './ProgressRing';
import { UnsupportedView, type UnsupportedPluginAction } from '../../components/UnsupportedView';
import { showToast } from '../../stores/toastStore';
import { getDocumentRevision, registerEditorCapabilities } from '../../core/editor/editorRegistry';
import './plugins.css';

export function PluginPreview({ docKey }: { docKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const doc = useDocumentStore((state) => state.documents.get(docKey));
  const installed = usePluginStore((state) => state.installed);
  const busy = usePluginStore((state) => state.busy);
  const id = previewPluginFor(docKey);
  const current = installed.find((p) => p.manifest.id === id);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { void initializePlugins(); }, []);

  useEffect(() => {
    if (!id || !current?.enabled || !ref.current) return;
    const controller = new AbortController();
    // 版本切换为独立容器，旧异步渲染的清理不会覆盖新文档。
    const target = document.createElement('div');target.style.height='100%';ref.current.replaceChildren(target);
    let dispose: (() => void) | void;
    setError(''); setLoading(true);
    void (async () => {
      try {
        const [module, bytes] = await Promise.all([loadPlugin(id, current.manifest.version), readPreviewFile(docKey)]);
        if (controller.signal.aborted) return;
        dispose = await module.mount({ container:target, name:doc?.displayName ?? docKey, bytes, signal:controller.signal, notify:(text) => showToast(text) });
        if (controller.signal.aborted) { dispose?.(); target.replaceChildren(); }
      } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); dispose?.(); target.remove(); };
  }, [docKey, doc?.mtime, id, current?.enabled, current?.manifest.version]);

  useEffect(() => {
    // 明确声明只读快照，Ctrl+S、关闭和回收流程不会伪造空正文写回文件。
    const instanceId = `preview-${docKey}-${Date.now()}`;
    return registerEditorCapabilities({
      docKey, instanceId, getRevision:() => getDocumentRevision(docKey),
      flush:async () => ({ docKey, instanceId, revision:getDocumentRevision(docKey), content:null, readonly:true }),
      focus:() => ref.current?.focus(), getSelectedText:() => window.getSelection()?.toString() ?? '',
      canSuspend:() => true, hasUnconfirmedInput:() => false,
    });
  }, [docKey]);

  const pluginName = OFFICIAL_PLUGINS.find((item) => item.id === id)?.name ?? '查看';
  // 未安装或损坏时跳转到设置中的对应插件卡片；已安装仅未启用时就地启用。
  const action: UnsupportedPluginAction | undefined = !id ? undefined : current && !current.invalid && !current.enabled
    ? { label: '启用插件', icon: busy ? <ProgressRing percent={null} /> : <Power size={15} />, disabled: !!busy, onClick: () => void usePluginStore.getState().act('toggle', id, true) }
    : !current?.enabled ? { label: '前往下载插件', icon: <Download size={15} />, onClick: () => openPluginSettings(`plugin:${id}`) } : undefined;
  const fallback = !current?.enabled || error;

  return <div className="nb-plugin-host">
    {fallback && <UnsupportedView filePath={docKey} fileName={doc?.displayName}
      pluginAction={error ? undefined : action}
      description={error ? `文档无法打开：${error.replace(/^Error:\s*/, '')}`
        : current?.invalid ? `「${pluginName}」插件文件已损坏，重新下载后即可阅读。`
        : current ? `「${pluginName}」插件未启用，启用后即可直接阅读。`
        : `安装「${pluginName}」插件后即可直接阅读此文件。`} />}
    {loading && !error && <div className="nb-plugin-loading" role="status"><ProgressRing percent={null} size={22} />正在打开文档…</div>}
    <div ref={ref} hidden={!current?.enabled || !!error} style={{ height:'100%', minHeight:0 }} />
  </div>;
}
