// NoteBoard 文档内容同步
// 在保存与暂存前，通过 core 能力注册表从当前编辑器实例抓取权威内容并刷新 DocumentStore 镜像。
// 🔴 S03 起本模块不再 import 任何编辑器组件（切断保存/暂存链对编辑器的反向依赖）；
//    各编辑器在挂载时向 core/editor/editorRegistry 注册 flush 能力。

import { useDocumentStore, type Document } from '../../../stores/documentStore';
import { getEditorCapabilities } from '../../../core/editor/editorRegistry';
// 🔴 R03：flush 结果经统一提交屏障（旧实例/旧 revision 快照不得覆盖新内容）
// 🔴 N04：提交携带会话代际（同路径关闭重开后，旧会话迟到快照丢弃）
import { submitCapturedContent, getSessionGeneration } from '../../../features/session/documentSession';

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
 * 同步指定文档的最新内容（统一异步 flush 屏障）。
 * 已挂载实例：await 其 flush 能力捕获权威快照并刷新镜像；
 * 未挂载/flush 失败：保留 store 中最近镜像（旧语义）。
 * 调用方（save、saveAs、暂存、关闭、会话快照、迁移）必须 await 本函数。
 */
export async function syncDocumentContent(docKey: string): Promise<Document | undefined> {
  const store = useDocumentStore.getState();
  const doc = store.getDocument(docKey);
  if (!doc) return undefined;

  const capabilities = getEditorCapabilities(docKey);
  if (capabilities) {
    // 🔴 N04：捕获调用时的会话代际——flush 是异步屏障，等待期间同路径
    //    会话可能已换代（关闭→重开）；旧会话的迟到快照不得覆盖新会话内容
    const generation = getSessionGeneration(docKey);
    const captured = await capabilities.flush('save');
    if (
      captured &&
      captured.content !== null &&
      getSessionGeneration(docKey) === generation
    ) {
      // 🔴 R03：快照经统一提交屏障写入镜像（旧实例/旧 revision 丢弃）；只读/非文本不写
      submitCapturedContent(docKey, captured, generation);
    }
  }

  const current = useDocumentStore.getState().getDocument(docKey);
  if (current?.kind === 'drawio' && !current.content?.trim()) {
    updateContentIfChanged(docKey, DEFAULT_DRAWIO_XML);
  }

  return useDocumentStore.getState().getDocument(docKey);
}
