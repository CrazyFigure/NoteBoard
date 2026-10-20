// DXF 也在独立线程解析，避免大段文本扫描占住 NoteBoard 输入线程。
import { DxfLoader } from '@flyfish-dev/cad-viewer';
import { normalizeDxfEncoding } from './dxfEncoding.mjs';
self.onmessage = async ({data}) => {
  try {
    const result = await new DxfLoader().load({buffer:normalizeDxfEncoding(new Uint8Array(data.bytes)),fileName:data.fileName},{keepRaw:false,maxInsertDepth:12});
    self.postMessage({type:'result',result});
  } catch (error) { self.postMessage({type:'error',error:{message:String(error)}}); }
};
