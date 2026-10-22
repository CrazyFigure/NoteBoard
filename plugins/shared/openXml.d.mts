/** 校验解压资源边界并移除外部关系，保持内部资源与正文。 */
export function cleanOpenXml(bytes: Uint8Array, prepare?: (zip: import('jszip')) => void | Promise<void>): Promise<Uint8Array>;
