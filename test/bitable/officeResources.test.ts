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

it('没有外链或版式修改时复用输入，修改关系时仍保留媒体压缩和内容',async()=>{
  const zip=new JSZip();zip.file('word/document.xml','保留正文');zip.file('word/media/image.bin',new Uint8Array(1024*1024));
  let bytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
  expect(await cleanOpenXml(bytes,undefined,{maxBytes:256*1024*1024})).toBe(bytes);
  zip.file('word/_rels/document.xml.rels','<Relationships><Relationship Target="https://example.com" TargetMode="External"/></Relationships>');
  bytes=await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
  const output=await cleanOpenXml(bytes,undefined,{maxBytes:256*1024*1024});
  expect(output.length).toBeLessThan(10000);
  const cleaned=await JSZip.loadAsync(output);
  expect((await cleaned.file('word/media/image.bin')!.async('uint8array')).length).toBe(1024*1024);
  expect(await cleaned.file('word/_rels/document.xml.rels')!.async('string')).not.toContain('https://');
});

it('Office 资源预算可提高，正文 XML 与默认 64 MB 预算仍独立保护，取消时停止处理',async()=>{
  // 只修改中央目录的声明，不实际分配百兆数据；未改动的压缩包走原字节复用路径。
  async function declared(name:string,size:number){
    const zip=new JSZip();zip.file(name,'small',{createFolders:false});const bytes=await zip.generateAsync({type:'uint8array'});
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let offset=0;offset<bytes.length-28;offset++)if(view.getUint32(offset,true)===0x02014b50){view.setUint32(offset+24,size,true);break;}
    return bytes;
  }
  const media=await declared('ppt/media/video.bin',512*1024*1024);
  expect(await cleanOpenXml(media,undefined,{maxBytes:768*1024*1024})).toBe(media);
  await expect(cleanOpenXml(media,undefined,{maxBytes:256*1024*1024})).rejects.toThrow('256 MB');
  await expect(cleanOpenXml(media)).rejects.toThrow('64 MB');
  await expect(cleanOpenXml(await declared('ppt/slides/slide1.xml',64*1024*1024+1),undefined,{maxBytes:768*1024*1024})).rejects.toThrow('正文 XML');
  const controller=new AbortController();controller.abort();
  await expect(cleanOpenXml(media,undefined,{maxBytes:768*1024*1024,signal:controller.signal})).rejects.toThrow();
});

it('仅剔除没有内部关系引用的媒体，保留相对路径、根路径及编码名称的图片',async()=>{
  const zip=new JSZip();
  zip.file('ppt/slides/_rels/slide1.xml.rels','<Relationships><Relationship Target="../media/one.png"/><Relationship Target="/ppt/media/two.png"/><Relationship Target="../media/image%20three.png"/></Relationships>');
  for(const name of ['one.png','two.png','image three.png','unused.bin'])zip.file(`ppt/media/${name}`,new Uint8Array([0,255,128]));
  const bytes=await cleanOpenXml(await zip.generateAsync({type:'uint8array'}),undefined,{pruneMedia:true});
  const cleaned=await JSZip.loadAsync(bytes);
  for(const name of ['one.png','two.png','image three.png'])expect(await cleaned.file(`ppt/media/${name}`)!.async('uint8array')).toEqual(new Uint8Array([0,255,128]));
  expect(cleaned.file('ppt/media/unused.bin')).toBeNull();
});
