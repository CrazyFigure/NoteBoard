// 在 DWG/DXF 解析线程内整理和校验结果，主线程只接收实际需要显示的图纸内容。
import { prepareScene } from './scene.mjs';

const send = self.postMessage.bind(self);
self.postMessage = (message, ...rest) => {
  if (message.type === 'result') {
    try {
      send({ type: 'progress', requestId: message.requestId, progress: { phase: 'prepare' } });
      const scene = prepareScene(message.result.document);
      message.result.document = scene.document;
      message.result.scene = { ...scene, document: undefined };
    } catch (error) {
      send({ type: 'error', requestId: message.requestId, error: { message: error.message } });
      return;
    }
  }
  send(message, ...rest);
};
