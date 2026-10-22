// OpenXML 预览先校验解压边界并移除外部关系，避免 ZIP 膨胀或文档自动请求网络资源。
import JSZip from 'jszip';

export async function cleanOpenXml(bytes, prepare){
  const zip=await JSZip.loadAsync(bytes);const entries=Object.values(zip.files);
  if(entries.length>5000)throw new Error('文档内部资源过多，请使用专业 Office 软件打开');
  let total=0;
  for(const entry of entries){total+=entry._data?.uncompressedSize??0;if(total>64*1024*1024)throw new Error('文档解压后超过 64 MB，请使用专业 Office 软件打开');}
  for(const entry of entries){
    if(entry.dir||!entry.name.endsWith('.rels'))continue;
    const text=await entry.async('string'),doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.querySelector('parsererror'))throw new Error('文档关系数据损坏');
    let changed=false;
    for(const relation of Array.from(doc.getElementsByTagNameNS('*','Relationship'))){if(relation.getAttribute('TargetMode')?.toLowerCase()==='external'){relation.remove();changed=true;}}
    if(changed)zip.file(entry.name,new XMLSerializer().serializeToString(doc));
  }
  // 预览格式适配只处理通过解压预算和外链清理的内存副本，原始文件保持只读。
  if(prepare)await prepare(zip);
  return zip.generateAsync({type:'uint8array',compression:'STORE'});
}
