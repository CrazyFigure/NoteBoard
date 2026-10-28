// 大文档在独立线程中解析、序列化和校验；主线程可随时终止任务，避免异常写法冻结整个窗口。
import type { NormalizationDiff } from './markdownNormalization';
import type { JSONContent } from '@tiptap/core';
import type { Settings } from '../../core/ipc/types';
import { prepareVisualDocumentData } from './visualPreparationData';

/** 阶段来自实际工作边界，不能把尚未开始的渲染显示为已完成。 */
export type PreparationStage = 'parsing' | 'checking' | 'comparing';
export interface PreparedVisualDocument {
  document: JSONContent;
  serialized: string;
  stable: boolean;
  diff: NormalizationDiff | null;
}

/** 每次只处理一个文档；取消和超时由主线程 terminate，不能降级到主线程重跑。 */
self.onmessage = async ({ data }: MessageEvent<{ content: string; settings: Settings }>) => {
  try {
    const result = await prepareVisualDocumentData(data.content, data.settings, async (stage) => { self.postMessage({ stage }); });
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '无法准备可视化文档' });
  }
};
