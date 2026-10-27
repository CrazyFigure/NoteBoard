// XMind 兼容回归：覆盖真实 ZIP、现代字段、经典命名空间、多画布、资源和旧版 JSON 恢复。
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportToXmindZip, importFromXmindZip, serializeMindmapDocument } from '@/features/mindmap/mindmapConverter';
import { inspectXmindArchive, readXmindSheets, prepareXmindSheet, resolveXmindImages } from '@/features/mindmap/xmindImport';
import { getMindmapTreeStats, stringifyMindmapJson } from '@/features/mindmap/mindmapTree';

/** 与磁盘文件相同的压缩包输入，不用转换器自身导出掩盖对方格式的不兼容。 */
async function zipContent(path: string, content: string, resources: Record<string, string> = {}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(path, content);
  for (const [name, data] of Object.entries(resources)) zip.file(name, data, { base64: true });
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('XMind 兼容导入', () => {
  it('常用内置标记映射 Emoji，未知标记通过提示说明', async () => {
    const buffer = await zipContent('content.json', JSON.stringify([{ rootTopic: {
      id: 'r', title: '图标', markers: [{ markerId: 'priority-2' }], children: { attached: [
        { id: 'done', title: '完成', markers: [{ markerId: 'task-done' }] },
        { id: 'unknown', title: '未知', markers: [{ markerId: 'custom-unknown' }] },
      ] },
    } }]));
    const archive = await inspectXmindArchive(buffer);
    const prepared = prepareXmindSheet(archive, (await readXmindSheets(archive))[0]);
    expect(prepared.root.icon).toBe('2️⃣');
    expect(prepared.root.children[0].icon).toBe('✅');
    expect(prepared.root.children[1].icon).toBeUndefined();
    expect(prepared.warnings).toContain('部分内置图标无法识别，未转换');
  });

  it('导出为真正的 ZIP 及资源文件，再导入仍保留备注、图片和折叠状态', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const blob = await exportToXmindZip({ id: 'r', text: '含图导图', note: '备注', images: [image], isExpanded: false, children: [
      { id: 'c', text: '共享图片', images: [image], children: [] },
    ] });
    const buffer = await blob.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const sheets = JSON.parse(await zip.file('content.json')!.async('text'));
    const src = sheets[0].rootTopic.image.src;
    expect(src).toMatch(/^xap:resources\//);
    expect(sheets[0].rootTopic.children.attached[0].image.src).toBe(src);
    expect(zip.file(src.slice(4))).not.toBeNull();
    const root = await importFromXmindZip(buffer);
    expect(root.note).toBe('备注');
    expect(root.images?.[0]).toBe(image);
    expect(root.isExpanded).toBe(false);
  });

  it('现代 notes、折叠和包内图片均可恢复，特殊主题保留为普通分支并提示', async () => {
    const buffer = await zipContent('content.json', JSON.stringify([{ title: '方案', rootTopic: {
      id: 'root', title: '中心', notes: { plain: { content: '正式备注' } }, branch: 'folded',
      image: { src: 'xap:resources/picture.png' }, children: {
        attached: [{ id: 'a', title: '常规' }], detached: [{ id: 'b', title: '漂浮', children: { attached: [{ id: 'c', title: '漂浮的子节点' }] } }],
        summary: [{ id: 'd', title: '概要文字' }],
      },
    } }]), { 'resources/picture.png': 'iVBORw0KGgo=' });
    const archive = await inspectXmindArchive(buffer);
    const [sheet] = await readXmindSheets(archive);
    const prepared = prepareXmindSheet(archive, sheet);
    expect(prepared.root.note).toBe('正式备注');
    expect(prepared.root.isExpanded).toBe(false);
    expect(prepared.root.children.map((node) => node.text)).toEqual(['常规', '漂浮', '概要文字']);
    expect(prepared.root.children[1].children[0].text).toBe('漂浮的子节点');
    expect(prepared.warnings.some((warning) => warning.includes('普通分支'))).toBe(true);
    const resolved = await resolveXmindImages(archive, prepared.root);
    expect(resolved.images?.[0]).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('经典 XML 完整解析多层节点、备注、命名空间图片与漂浮主题', async () => {
    const xml = `<?xml version="1.0"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xhtml="http://www.w3.org/1999/xhtml"><sheet id="s"><title>经典画布</title><topic id="r"><title><![CDATA[研发 <计划>]]></title><notes><plain>备注 &amp; 说明</plain></notes><image xhtml:src="xap:resources/image.png"/><children><topics type="attached"><topic id="a" branch="folded"><title>一级</title><children><topics type="attached"><topic id="b"><title>二级</title></topic></topics></children></topic></topics><topics type="detached"><topic id="f"><title>漂浮</title></topic></topics></children></topic></sheet></xmap-content>`;
    const root = await importFromXmindZip(await zipContent('content.xml', xml, { 'resources/image.png': 'iVBORw0KGgo=' }));
    expect(root.text).toBe('研发 <计划>');
    expect(root.note).toBe('备注 & 说明');
    expect(root.images?.[0]).toContain('data:image/png;base64,');
    expect(root.children[0].text).toBe('一级');
    expect(root.children[0].isExpanded).toBe(false);
    expect(root.children[0].children[0].text).toBe('二级');
    expect(root.children[1].text).toBe('漂浮');
  });

  it('多画布必须明确选择，不能默默只取第一张', async () => {
    const buffer = await zipContent('content.json', JSON.stringify([
      { title: '第一张', rootTopic: { id: 'a', title: 'A' } },
      { title: '第二张', rootTopic: { id: 'b', title: 'B' } },
    ]));
    await expect(importFromXmindZip(buffer)).rejects.toThrow('多个画布');
    expect((await importFromXmindZip(buffer, '1')).text).toBe('B');
  });

  it('现代 JSON 损坏时不会降级读取兼容 XML 而假装成功', async () => {
    const zip = new JSZip();
    zip.file('content.json', '{invalid');
    zip.file('content.xml', '<xmap-content><sheet><topic><title>仅为兼容提示</title></topic></sheet></xmap-content>');
    await expect(importFromXmindZip(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow();
  });

  it('旧版错误后缀只恢复有效原生 JSON，原有宽度、格式和备注不丢失', async () => {
    const content = serializeMindmapDocument({ id: 'r', text: '旧版', width: 280, note: '保留', marks: [{ start: 0, end: 2, bold: true }], children: [] });
    const root = await importFromXmindZip(new TextEncoder().encode(content).buffer);
    expect(root.width).toBe(280);
    expect(root.note).toBe('保留');
    expect(root.marks?.[0].bold).toBe(true);
    await expect(importFromXmindZip(new TextEncoder().encode('{"other":true}').buffer)).rejects.toThrow('不是有效');
  });

  it('一万层主题只警告风险，不截断，也不会在转换或序列化阶段栈溢出', async () => {
    const topic = { id: 'r', title: '根', children: { attached: [] as object[] } };
    let current = topic;
    for (let index = 1; index < 10_000; index += 1) {
      const child = { id: `n${index}`, title: '子', children: { attached: [] as object[] } };
      current.children.attached.push(child);
      current = child;
    }
    const archive = await inspectXmindArchive(await zipContent('content.json', stringifyMindmapJson([{ title: '深层', rootTopic: topic }], false)));
    const prepared = prepareXmindSheet(archive, (await readXmindSheets(archive))[0]);
    expect(getMindmapTreeStats(prepared.root)).toEqual({ nodeCount: 10_000, maxDepth: 10_000 });
    expect(prepared.warnings.some((warning) => warning.includes('超过 500 层'))).toBe(true);
    expect(serializeMindmapDocument(prepared.root)).toContain('n9999');
  });
});
