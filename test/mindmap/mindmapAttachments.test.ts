import { describe, expect, test } from 'vitest';
import {
  appendWithLimit,
  fileLinkName,
  MAX_NODE_FILES,
  MAX_NODE_IMAGES,
  normalizeNodeFiles,
  normalizeNodeImages,
  toFileLinkPath,
} from '../../src/features/mindmap/mindmapAttachments';
import {
  markdownToMindNode,
  mindNodeToMarkdown,
  mindNodeToXmindJson,
  parseMindmapDocument,
  serializeMindmapDocument,
} from '../../src/features/mindmap/mindmapConverter';
import { computeMindmapLayout } from '../../src/features/mindmap/mindmapLayout';
import { GALLERY_MIN_WIDTH } from '../../src/features/mindmap/mindmapTextMeasure';
import type { MindNode } from '../../src/features/mindmap/mindmapTypes';
import { USES_WINDOWS_PATHS } from '../../src/core/platform';

const img = (i: number) => `data:image/png;base64,IMG${i}`;

describe('节点附件规范化', () => {
  test('旧版单图 image 并入 images 且排在最前，最多 10 张', () => {
    const images = normalizeNodeImages({ image: img(0), images: Array.from({ length: 12 }, (_, i) => img(i + 1)) } as never);
    expect(images).toHaveLength(MAX_NODE_IMAGES);
    expect(images?.[0]).toBe(img(0));
    expect(normalizeNodeImages({})).toBeUndefined();
  });

  test('文件链接去重、过滤非法项并限制 10 个', () => {
    const files = normalizeNodeFiles(['a.md', 'a.md', '', 3, ...Array.from({ length: 12 }, (_, i) => `f${i}.md`)]);
    expect(files).toHaveLength(MAX_NODE_FILES);
    expect(files?.[0]).toBe('a.md');
    expect(files?.filter((f) => f === 'a.md')).toHaveLength(1);
  });

  test('追加遵守上限并返回忽略数量', () => {
    expect(appendWithLimit(['a'], ['b', 'c', 'd'], 3)).toEqual({ next: ['a', 'b', 'c'], dropped: 1 });
    expect(appendWithLimit(['a'], ['a', 'b'], 3, true)).toEqual({ next: ['a', 'b'], dropped: 0 });
  });

  test('文件显示名取最后一段并解码', () => {
    expect(fileLinkName('./docs/%E8%AE%A1%E5%88%92.md')).toBe('计划.md');
    expect(fileLinkName('C:\\notes\\readme.md')).toBe('readme.md');
  });

  test('工作区内的文件写相对路径，工作区外保留绝对路径', () => {
    if (USES_WINDOWS_PATHS) {
      expect(toFileLinkPath('C:\\ws\\maps\\sub\\a.md', 'C:\\ws\\maps', 'C:\\ws')).toBe('./sub/a.md');
      expect(toFileLinkPath('C:\\ws\\docs\\b.md', 'C:\\ws\\maps', 'C:\\ws')).toBe('../docs/b.md');
      expect(toFileLinkPath('D:\\other\\c.md', 'C:\\ws\\maps', 'C:\\ws')).toBe('D:\\other\\c.md');
    } else {
      expect(toFileLinkPath('/ws/maps/sub/a.md', '/ws/maps', '/ws')).toBe('./sub/a.md');
      expect(toFileLinkPath('/ws/docs/b.md', '/ws/maps', '/ws')).toBe('../docs/b.md');
      expect(toFileLinkPath('/other/c.md', '/ws/maps', '/ws')).toBe('/other/c.md');
    }
    // 未保存的导图没有基准目录
    expect(toFileLinkPath('/x/y.md', undefined, '/x')).toBe('/x/y.md');
  });
});

describe('多图与文件链接的序列化', () => {
  const tree: MindNode = {
    id: 'root',
    text: '根',
    images: [img(1), img(2)],
    files: ['./docs/计划 书.md', '../readme.md'],
    children: [{ id: 'c', text: '子', files: ['./a.md'], children: [] }],
  };

  test('JSON 往返保留多图与文件链接，旧版 image 字段自动迁移', () => {
    const parsed = parseMindmapDocument(serializeMindmapDocument(tree));
    expect(parsed.images).toEqual([img(1), img(2)]);
    expect(parsed.files).toEqual(['./docs/计划 书.md', '../readme.md']);
    const legacy = parseMindmapDocument(JSON.stringify({ version: 1, root: { id: 'r', text: '旧', image: img(9), children: [] } }));
    expect(legacy.images).toEqual([img(9)]);
    expect((legacy as unknown as { image?: string }).image).toBeUndefined();
  });

  test('Markdown 往返保留多图与文件链接（含空格路径）', () => {
    const md = mindNodeToMarkdown(tree);
    expect(md).toContain('> [计划 书.md](<./docs/计划 书.md>)');
    const back = markdownToMindNode(md);
    expect(back.images).toEqual([img(1), img(2)]);
    expect(back.files).toEqual(['./docs/计划 书.md', '../readme.md']);
    expect(back.children[0].files).toEqual(['./a.md']);
    // 网络链接仍按备注处理
    expect(markdownToMindNode('# 根\n> [官网](https://example.com)').note).toBe('[官网](https://example.com)');
  });

  test('XMind 只导出第一张图片', () => {
    expect(mindNodeToXmindJson(tree)[0].rootTopic.image?.src).toBe(img(1));
  });
});

describe('多图网格与文件列表排版', () => {
  const byId = (nodes: ReturnType<typeof computeMindmapLayout>['nodes'], id: string) => nodes.find((n) => n.node.id === id)!;

  test('两张图两列、三张以上三列，超过 6 张只展示 6 格', () => {
    const tree: MindNode = {
      id: 'root',
      text: '根',
      children: [
        { id: 'two', text: '两张', images: [img(1), img(2)], children: [] },
        { id: 'ten', text: '十张', images: Array.from({ length: 10 }, (_, i) => img(i)), children: [] },
      ],
    };
    const nodes = computeMindmapLayout(tree, 'right', 6).nodes;
    const two = byId(nodes, 'two');
    expect(two.gallery?.columns).toBe(2);
    expect(two.imageBox).toBeUndefined();
    expect(two.width).toBeGreaterThanOrEqual(GALLERY_MIN_WIDTH);
    const ten = byId(nodes, 'ten');
    expect(ten.gallery).toMatchObject({ columns: 3, visibleCount: 6 });
    // 两行方格
    expect(ten.gallery!.height).toBe(ten.gallery!.cellWidth * 2 + ten.gallery!.gap);
    expect(ten.height).toBeGreaterThan(ten.gallery!.height);
  });

  test('文件链接每个占一行，节点高度随数量增长', () => {
    const make = (count: number): MindNode => ({
      id: 'root',
      text: '根',
      children: [{ id: 'n', text: '节点', files: Array.from({ length: count }, (_, i) => `./f${i}.md`), children: [] }],
    });
    const h0 = byId(computeMindmapLayout(make(0), 'right', 6).nodes, 'n').height;
    const h1 = byId(computeMindmapLayout(make(1), 'right', 6).nodes, 'n').height;
    const h3 = byId(computeMindmapLayout(make(3), 'right', 6).nodes, 'n').height;
    expect(h1).toBeGreaterThan(h0);
    expect(h3 - h1).toBe(2 * (22 + 2));
  });
});
