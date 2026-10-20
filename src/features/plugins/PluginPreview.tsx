// Office / PDF 只读宿主：安装状态、异步任务代际和卸载清理由宿主管理。
import { useEffect, useRef, useState } from 'react';
import { useDocumentStore } from '../../stores/documentStore';
import { initializePlugins, usePluginStore } from '../../stores/pluginStore';
import { readPreviewFile } from '../../core/ipc/commands';
import { loadPlugin } from './pluginService';
import { previewPluginFor } from './pluginTypes';
import { PluginsPanel } from './PluginsPanel';
import { openPluginSettings } from './openPluginSettings';
import { showToast } from '../../stores/toastStore';
import { getDocumentRevision, registerEditorCapabilities } from '../../core/editor/editorRegistry';
import './plugins.css';

export function PluginPreview({ docKey }: { docKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const doc = useDocumentStore((state) => state.documents.get(docKey));
  const installed = usePluginStore((state) => state.installed);
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

  return <div className="nb-plugin-host">
    {!current?.enabled && id && <div className="nb-plugin-placeholder"><PluginsPanel only={id} /><button type="button" className="nb-plugin-button" onClick={() => openPluginSettings()}>前往设置 · 插件</button><p className="nb-plugin-empty">安装后请勾选启用，即可阅读文件。</p></div>}
    {loading && <p style={{ padding:20 }}>正在打开文档…</p>}
    {error && <div className="nb-plugin-error" role="alert">{error}</div>}
    <div ref={ref} hidden={!current?.enabled} style={{ height:'100%', minHeight:0 }} />
  </div>;
}
