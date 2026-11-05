// OpenXML 预览先校验解压边界并移除外部关系，避免 ZIP 膨胀或文档自动请求网络资源。
import JSZip from 'jszip';

/** Office 可显式提高资源预算；正文 XML 仍限制在 64 MiB，不能随媒体上限无限放大 DOM。 */
export async function cleanOpenXml(bytes, prepare, {maxBytes=64*1024*1024,signal,pruneMedia=false}={}){
  signal?.throwIfAborted();
  const zip=await JSZip.loadAsync(bytes);const entries=Object.values(zip.files);
  signal?.throwIfAborted();
  if(entries.length>5000)throw new Error('文档内部资源过多，请使用专业 Office 软件打开');
  let total=0,xmlTotal=0;
  const referencedMedia=new Set();
  for(const entry of entries){
    const size=entry._data?.uncompressedSize??0;total+=size;
    if(total>maxBytes)throw new Error(`文档解压后超过 ${maxBytes/1024/1024} MB，请使用专业 Office 软件打开`);
    if(/\.(xml|rels)$/i.test(entry.name))xmlTotal+=size;
    if(xmlTotal>64*1024*1024)throw new Error('文档正文 XML 超过 64 MB，请使用专业 Office 软件打开');
    // 保留原有压缩方式，重打包时直接复用未改动的压缩数据，避免展开全部媒体或重新压缩图片。
    if(entry._data?.compression)entry.options.compression=entry._data.compression.magic==='\x08\x00'?'DEFLATE':'STORE';
  }
  for(const entry of entries){
    signal?.throwIfAborted();
    if(entry.dir||!entry.name.endsWith('.rels'))continue;
    const text=await entry.async('string'),doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.querySelector('parsererror'))throw new Error('文档关系数据损坏');
    let changed=false;
    for(const relation of Array.from(doc.getElementsByTagNameNS('*','Relationship'))){
      if(relation.getAttribute('TargetMode')?.toLowerCase()==='external'){relation.remove();changed=true;continue;}
      // 关系文件属于其父级部件目录；按 OPC 路径解析 ../、根路径与百分号编码的媒体名称。
      if(pruneMedia){
        const target=relation.getAttribute('Target');if(!target)continue;
        const base=entry.name.replace(/(^|\/)_rels\/[^/]*\.rels$/i,'$1');
        const resolved=new URL(target,`https://noteboard.invalid/${base}`);
        if(resolved.origin==='https://noteboard.invalid'){
          let name=resolved.pathname.slice(1);try{name=decodeURIComponent(name);}catch{/* 非规范百分号仍按原始名称匹配，避免误删资源。 */}
          referencedMedia.add(name);
        }
      }
    }
    if(changed)zip.file(entry.name,new XMLSerializer().serializeToString(doc));
  }
  // 库会展开 ZIP 中所有条目；未被任何内部关系引用的媒体不参与查看，提前剔除减少内存与解压耗时。
  if(pruneMedia)for(const entry of entries)if(!entry.dir&&/^(word|xl|ppt)\/media\//i.test(entry.name)&&!referencedMedia.has(entry.name))zip.remove(entry.name);
  // 预览格式适配只处理通过解压预算和外链清理的内存副本，原始文件保持只读。
  if(prepare)await prepare(zip);
  signal?.throwIfAborted();
  // 没有外链或版式修正时直接复用原始字节，避免为百兆文档再生成一份完整 ZIP。
  if(Object.keys(zip.files).length===entries.length&&entries.every((entry)=>zip.files[entry.name]===entry))return bytes;
  // 保留完整本地文件头，兼容 Excel/PPT 解析器不支持流式 ZIP 数据描述符的情况。
  const result=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
  signal?.throwIfAborted();
  return result;
}
