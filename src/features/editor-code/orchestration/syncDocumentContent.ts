// NoteBoard 文档内容同步
// 在保存与暂存前，从各编辑器实例抓取权威内容并刷新 DocumentStore 镜像。

import { useDocumentStore, type Document } from '../../../stores/documentStore';
import { useWindowStore } from '../../../stores/windowStore';
import { getEditorView } from '../CodeEditor';
import { getActiveSourceView, getActiveTipTapEditor } from '../../editor-md/TipTapEditor';
import { serializeMarkdown } from '../../editor-md/serialize';
import { getActiveBoardScene } from '../../board/BoardEditor';
import { serializeScene } from '../../board/sceneIo';

/** Draw.io 新建文档首次暂存/保存时使用的有效空白图模板。 */
export const DEFAULT_DRAWIO_XML = `<mxfile host="NoteBoard" modified="${new Date().toISOString()}" agent="NoteBoard" version="0.1.3" etag="noteboard">
  <diagram id="diagram_1" name="第 1 页">
    <mxGraphModel dx="1000" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" background="none" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="开始绘图" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="340" y="240" width="120" height="60" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

/** 内容未变化时不触发 Zustand 更新，避免暂存同步反过来形成无休止的防抖写入循环。 */
function updateContentIfChanged(docKey: string, content: string): void {
  const store = useDocumentStore.getState();
  if (store.getDocument(docKey)?.content !== content) {
    store.setContent(docKey, content);
  }
}

/**
 * 同步指定文档的最新内容。
 * Markdown 与画板按文档 key 查询实例；CodeMirror 只有当前活动实例，因此必须校验 activeKey，
 * 防止批量关闭时把活动代码文档的内容错误写入其他标签。
 */
export function syncDocumentContent(docKey: string): Document | undefined {
  const store = useDocumentStore.getState();
  const doc = store.getDocument(docKey);
  if (!doc) return undefined;

  if (doc.kind === 'markdown') {
    const currentMode = useWindowStore.getState().getTab(docKey)?.viewMode ?? 'visual';
    if (currentMode === 'source') {
      const sourceView = getActiveSourceView(docKey);
      if (sourceView) updateContentIfChanged(docKey, sourceView.state.doc.toString());
    } else {
      const tipTap = getActiveTipTapEditor(docKey);
      if (tipTap) {
        try {
          updateContentIfChanged(docKey, serializeMarkdown(tipTap));
        } catch {
          // 序列化异常时保留编辑器最近一次写入 store 的镜像，避免用空内容覆盖。
        }
      }
    }
  }

  if (doc.kind === 'code' && useWindowStore.getState().activeKey === docKey) {
    const view = getEditorView();
    if (view) updateContentIfChanged(docKey, view.state.doc.toString());
  }

  if (doc.kind === 'board') {
    const scene = getActiveBoardScene(docKey);
    if (scene) {
      try {
        updateContentIfChanged(docKey, serializeScene(scene));
      } catch {
        // 画板序列化失败时保留最近镜像，后续暂存/保存仍会返回明确的写入结果。
      }
    }
  }

  const current = useDocumentStore.getState().getDocument(docKey);
  if (current?.kind === 'drawio' && !current.content?.trim()) {
    updateContentIfChanged(docKey, DEFAULT_DRAWIO_XML);
  }

  return useDocumentStore.getState().getDocument(docKey);
}
