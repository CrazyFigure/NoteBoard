// 预览文件不能自动请求外部资源，异常压缩声明必须在实际解压前被拒绝。
import {it,expect} from 'vitest';
import JSZip from 'jszip';
import {cleanOpenXml} from '../../plugins/shared/openXml.mjs';

it('只移除外部关系，保留内部图片与原始正文',async()=>{
  const zip=new JSZip();zip.file('word/document.xml','原始正文');
  zip.file('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="internal" Target="media/image.png"/><Relationship Id="external" Target="https://example.com/track.png" TargetMode="External"/></Relationships>');
  const clean=await JSZip.loadAsync(await cleanOpenXml(await zip.generateAsync({type:'uint8array'})));
  expect(await clean.file('word/document.xml')!.async('string')).toBe('原始正文');
  const relations=await clean.file('word/_rels/document.xml.rels')!.async('string');
  expect(relations).toContain('internal');expect(relations).not.toContain('external');
});

it('拒绝伪造超大解压体积的 ZIP，无需分配声明的大内存',async()=>{
  const zip=new JSZip();zip.file('word/document.xml','small',{createFolders:false});const bytes=await zip.generateAsync({type:'uint8array'});
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let offset=0;offset<bytes.length-28;offset++)if(view.getUint32(offset,true)===0x02014b50){view.setUint32(offset+24,64*1024*1024+1,true);break;}
  await expect(cleanOpenXml(bytes)).rejects.toThrow('解压后超过');
});
