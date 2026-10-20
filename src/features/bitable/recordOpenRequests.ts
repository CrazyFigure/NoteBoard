// 记录打开请求可早于编辑器懒加载完成，挂载后再消费，避免跨文件跳转丢失。
import { pathKey } from '../explorer/pathUtils';
const pending = new Map<string,string>();

export function requestBitableRecord(docKey:string,rowId:string):void {
  pending.set(pathKey(docKey),rowId);
  window.dispatchEvent(new Event('nb-bitable-open-record'));
}

export function takeBitableRecordRequest(docKey:string):string|null {
  const key=pathKey(docKey),id=pending.get(key)??null;pending.delete(key);return id;
}
