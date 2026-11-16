// 整理现有图片：迁移计划与执行（内存文件系统，路径按 Windows 语义）
import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../../src/core/platform', async (original) => ({
  ...await original<typeof import('../../src/core/platform')>(),
  get USES_WINDOWS_PATHS() { return platform.windows; },
}));

import {
  executeImageMigration,
  outermostRoots,
  planImageMigration,
  type MigrationOptions,
  type MigrationReadFs,
  type MigrationWriteFs,
} from '../../src/features/editor-md/imageMigration';
import { rewriteImageRefs } from '../../src/features/editor-md/imageRefs';

const SYNC = 'C:\\Notes';
const key = (path: string) => path.toLowerCase();
const bytes = (text: string) => new TextEncoder().encode(text);

/** 内存文件系统：Markdown 文本与图片字节分开存放 */
function createMemoryFs(texts: Record<string, string>, images: Record<string, string>, dirty: string[] = []) {
  const docs = new Map(Object.entries(texts).map(([path, text]) => [key(path), { path, text }]));
  const files = new Map(Object.entries(images).map(([path, data]) => [key(path), { path, data: bytes(data) }]));
  const dirs = new Set<string>();
  const trashed: string[] = [];
  const failRename = new Set<string>();

  const read: MigrationReadFs = {
    // 只列出扫描根目录内的文档
    listMarkdownFiles: async (root) => [...docs.values()].map((doc) => doc.path).filter((path) => key(path).startsWith(`${key(root)}\\`)),
    readText: async (path) => docs.get(key(path))!.text,
    exists: async (path) => files.has(key(path)),
    readBytes: async (path) => {
      const file = files.get(key(path));
      if (!file) throw new Error('not found');
      return file.data;
    },
    isDirtyOpenDocument: (path) => dirty.some((item) => key(item) === key(path)),
  };

  const write: MigrationWriteFs = {
    ensureDir: async (path) => { dirs.add(key(path)); },
    rename: async (from, to) => {
      if (failRename.has(key(from))) throw new Error('跨设备');
      const file = files.get(key(from))!;
      files.delete(key(from));
      files.set(key(to), { path: to, data: file.data });
    },
    copy: async (from, to) => {
      files.set(key(to), { path: to, data: files.get(key(from))!.data });
    },
    trash: async (path) => {
      trashed.push(path);
      files.delete(key(path));
    },
    rewriteDocument: async (path, replacements) => {
      const doc = docs.get(key(path))!;
      const { text, count } = rewriteImageRefs(doc.text, replacements);
      doc.text = text;
      return count;
    },
    isEmptyDir: async (path) => ![...files.keys()].some((file) => file.startsWith(`${key(path)}\\`)),
  };

  return {
    read,
    write,
    trashed,
    failRename,
    text: (path: string) => docs.get(key(path))!.text,
    has: (path: string) => files.has(key(path)),
  };
}

// 两种模式共用目录名 img：同级为 <文档目录>\img，统一为 C:\Notes\img
const toGlobal: MigrationOptions = { direction: 'toGlobal', scanRoots: [SYNC], imageDirName: 'img', globalDir: 'C:\\Notes\\img' };
const toSibling: MigrationOptions = { ...toGlobal, direction: 'toSibling' };

describe('outermostRoots', () => {
  it('去掉空值、重复与被包含的目录', () => {
    expect(outermostRoots(['C:\\Notes', '', null, 'c:\\notes\\a', 'C:\\Work', 'C:\\work\\'])).toEqual(['C:\\Notes', 'C:\\Work']);
  });
});

describe('更换统一目录位置', () => {
  it('旧统一目录（同步文件夹外）中的图片迁入新统一目录，搬空的旧目录被回收', async () => {
    const fs = createMemoryFs(
      {
        'C:\\Notes\\a\\1.md': '![p](../../Pics/img/p.png)',
        'C:\\Notes\\2.md': '![p](../Pics/img/p.png) ![q](./img/q.png)',
      },
      { 'C:\\Pics\\img\\p.png': 'P', 'C:\\Notes\\img\\q.png': 'Q' },
    );
    const plan = await planImageMigration({ ...toGlobal, legacyGlobalDirs: ['C:\\Pics\\img'] }, fs.read);
    expect(plan.stats).toMatchObject({ docs: 2, images: 1, refs: 2 });
    expect(plan.ops).toMatchObject([{ kind: 'move', from: 'C:\\Pics\\img\\p.png', to: 'C:\\Notes\\img\\p.png' }]);
    const report = await executeImageMigration(plan, fs.write);
    expect(report.errors).toEqual([]);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![p](../img/p.png)');
    expect(fs.text('C:\\Notes\\2.md')).toBe('![p](./img/p.png) ![q](./img/q.png)');
    expect(fs.has('C:\\Pics\\img\\p.png')).toBe(false);
    expect(report.removedDirs).toBe(1);
  });

  it('同一次整理同时处理同级图片与旧统一目录图片，同名不同内容自动改名', async () => {
    const fs = createMemoryFs(
      { 'C:\\Notes\\a\\1.md': '![x](./img/x.png) ![y](../../Pics/img/x.png)' },
      { 'C:\\Notes\\a\\img\\x.png': 'A', 'C:\\Pics\\img\\x.png': 'B' },
    );
    const plan = await planImageMigration({ ...toGlobal, legacyGlobalDirs: ['C:\\Pics\\img'] }, fs.read);
    expect(plan.stats).toMatchObject({ images: 2, renamed: 1 });
    await executeImageMigration(plan, fs.write);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![x](../img/x.png) ![y](../img/x_1.png)');
  });

  it('与新统一目录相同的旧目录被忽略', async () => {
    const fs = createMemoryFs({ 'C:\\Notes\\a\\1.md': '![q](../img/q.png)' }, { 'C:\\Notes\\img\\q.png': 'Q' });
    const plan = await planImageMigration({ ...toGlobal, legacyGlobalDirs: ['c:\\notes\\img'] }, fs.read);
    expect(plan.ops).toEqual([]);
  });

  it('统一 → 同级时旧统一目录中的图片同样整理回同级目录', async () => {
    const fs = createMemoryFs(
      { 'C:\\Notes\\a\\1.md': '![p](../../Pics/img/p.png) ![q](../img/q.png)' },
      { 'C:\\Pics\\img\\p.png': 'P', 'C:\\Notes\\img\\q.png': 'Q' },
    );
    const plan = await planImageMigration({ ...toSibling, legacyGlobalDirs: ['C:\\Pics\\img'] }, fs.read);
    await executeImageMigration(plan, fs.write);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![p](./img/p.png) ![q](./img/q.png)');
    expect(fs.has('C:\\Notes\\a\\img\\p.png')).toBe(true);
    expect(fs.has('C:\\Notes\\a\\img\\q.png')).toBe(true);
  });
});

describe('扫描范围', () => {
  it('未设置同步文件夹时扫描当前打开的文件夹，统一目录可在任意位置', async () => {
    const fs = createMemoryFs(
      { 'C:\\Work\\a\\1.md': '![x](./img/x.png)', 'C:\\Elsewhere\\2.md': '![y](./img/y.png)' },
      { 'C:\\Work\\a\\img\\x.png': 'X', 'C:\\Elsewhere\\img\\y.png': 'Y' },
    );
    const plan = await planImageMigration({ ...toGlobal, scanRoots: ['C:\\Work'], globalDir: 'C:\\Pics\\img' }, fs.read);
    expect(plan.stats).toMatchObject({ scannedDocs: 1, images: 1 });
    await executeImageMigration(plan, fs.write);
    expect(fs.text('C:\\Work\\a\\1.md')).toBe('![x](../../Pics/img/x.png)');
    // 扫描范围外的文档不受影响
    expect(fs.text('C:\\Elsewhere\\2.md')).toBe('![y](./img/y.png)');
  });

  it('多个扫描根目录互相包含时文档只处理一次', async () => {
    const fs = createMemoryFs({ 'C:\\Notes\\a\\1.md': '![x](./img/x.png)' }, { 'C:\\Notes\\a\\img\\x.png': 'X' });
    const plan = await planImageMigration({ ...toGlobal, scanRoots: ['C:\\Notes\\a', 'C:\\Notes'] }, fs.read);
    expect(plan.stats).toMatchObject({ scannedDocs: 1, refs: 1 });
  });

  it('没有统一目录或扫描范围时返回空计划', async () => {
    const fs = createMemoryFs({ 'C:\\Notes\\a\\1.md': '![x](./img/x.png)' }, { 'C:\\Notes\\a\\img\\x.png': 'X' });
    expect((await planImageMigration({ ...toGlobal, globalDir: '' }, fs.read)).ops).toEqual([]);
    expect((await planImageMigration({ ...toGlobal, scanRoots: [] }, fs.read)).stats.scannedDocs).toBe(0);
  });
});

describe('同级 → 统一', () => {
  it('移动同级图片并改写为相对统一目录的路径，搬空的目录被回收；根目录文档已在统一目录内保持不动', async () => {
    const fs = createMemoryFs(
      {
        'C:\\Notes\\a\\note.md': '![x](./img/x.png)\n![remote](https://x.com/r.png)',
        'C:\\Notes\\root.md': '<img src="img/y.png" width="50%">',
      },
      { 'C:\\Notes\\a\\img\\x.png': 'X', 'C:\\Notes\\img\\y.png': 'Y' },
    );
    const plan = await planImageMigration(toGlobal, fs.read);
    expect(plan.stats).toMatchObject({ scannedDocs: 2, docs: 1, images: 1, refs: 1, deduped: 0, renamed: 0 });
    expect(plan.ops).toMatchObject([{ kind: 'move', to: 'C:\\Notes\\img\\x.png' }]);

    const report = await executeImageMigration(plan, fs.write);
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ files: 1, docs: 1, refs: 1 });
    expect(fs.text('C:\\Notes\\a\\note.md')).toBe('![x](../img/x.png)\n![remote](https://x.com/r.png)');
    expect(fs.text('C:\\Notes\\root.md')).toBe('<img src="img/y.png" width="50%">');
    expect(fs.has('C:\\Notes\\img\\x.png')).toBe(true);
    expect(fs.has('C:\\Notes\\img\\y.png')).toBe(true);
    expect(fs.has('C:\\Notes\\a\\img\\x.png')).toBe(false);
    // 子目录的旧 img 已搬空
    expect(report.removedDirs).toBe(1);
  });

  it('其他目录的文档以不同写法引用同一张图时一并改写', async () => {
    const fs = createMemoryFs(
      {
        'C:\\Notes\\a\\note.md': '![x](./img/x.png)',
        'C:\\Notes\\b\\other.md': '![x](../a/img/x.png)',
      },
      { 'C:\\Notes\\a\\img\\x.png': 'X' },
    );
    const plan = await planImageMigration(toGlobal, fs.read);
    expect(plan.stats).toMatchObject({ images: 1, refs: 2 });
    await executeImageMigration(plan, fs.write);
    expect(fs.text('C:\\Notes\\a\\note.md')).toBe('![x](../img/x.png)');
    expect(fs.text('C:\\Notes\\b\\other.md')).toBe('![x](../img/x.png)');
  });

  it('同名冲突：内容相同去重、内容不同追加后缀', async () => {
    const fs = createMemoryFs(
      {
        'C:\\Notes\\a\\1.md': '![s](./img/shot.png)',
        'C:\\Notes\\b\\2.md': '![s](./img/shot.png)',
        'C:\\Notes\\c\\3.md': '![s](./img/shot.png)',
      },
      {
        'C:\\Notes\\a\\img\\shot.png': 'A',
        'C:\\Notes\\b\\img\\shot.png': 'B',
        // 与 a 内容相同
        'C:\\Notes\\c\\img\\shot.png': 'A',
      },
    );
    const plan = await planImageMigration(toGlobal, fs.read);
    expect(plan.stats).toMatchObject({ images: 3, deduped: 1, renamed: 1 });
    const report = await executeImageMigration(plan, fs.write);
    expect(report.errors).toEqual([]);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![s](../img/shot.png)');
    expect(fs.text('C:\\Notes\\b\\2.md')).toBe('![s](../img/shot_1.png)');
    expect(fs.text('C:\\Notes\\c\\3.md')).toBe('![s](../img/shot.png)');
    // 去重的源文件被回收
    expect(fs.has('C:\\Notes\\c\\img\\shot.png')).toBe(false);
  });

  it('统一目录已有相同内容的文件时直接复用', async () => {
    const fs = createMemoryFs(
      { 'C:\\Notes\\a\\1.md': '![s](./img/s.png)' },
      { 'C:\\Notes\\a\\img\\s.png': 'S', 'C:\\Notes\\img\\s.png': 'S' },
    );
    const plan = await planImageMigration(toGlobal, fs.read);
    expect(plan.ops).toMatchObject([{ kind: 'reuse' }]);
    await executeImageMigration(plan, fs.write);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![s](../img/s.png)');
    expect(fs.has('C:\\Notes\\a\\img\\s.png')).toBe(false);
  });

  it('文件缺失、非同级目录的图片与有未保存修改的文档被跳过', async () => {
    const fs = createMemoryFs(
      {
        'C:\\Notes\\a\\1.md': '![m](./img/missing.png) ![o](../pics/o.png)',
        'C:\\Notes\\b\\2.md': '![d](./img/d.png)',
      },
      { 'C:\\Notes\\pics\\o.png': 'O', 'C:\\Notes\\b\\img\\d.png': 'D' },
      ['C:\\Notes\\b\\2.md'],
    );
    const plan = await planImageMigration(toGlobal, fs.read);
    expect(plan.ops).toEqual([]);
    expect(plan.skipped.map((item) => item.src).sort()).toEqual(['./img/d.png', './img/missing.png']);
  });

  it('移动失败时改为复制，文档改写成功后回收源文件', async () => {
    const fs = createMemoryFs({ 'C:\\Notes\\a\\1.md': '![s](./img/s.png)' }, { 'C:\\Notes\\a\\img\\s.png': 'S' });
    fs.failRename.add(key('C:\\Notes\\a\\img\\s.png'));
    const plan = await planImageMigration(toGlobal, fs.read);
    const report = await executeImageMigration(plan, fs.write);
    expect(report.errors).toEqual([]);
    expect(fs.has('C:\\Notes\\img\\s.png')).toBe(true);
    expect(fs.trashed).toContain('C:\\Notes\\a\\img\\s.png');
  });

  it('文档改写失败时不回收源文件，原引用仍可显示', async () => {
    const fs = createMemoryFs(
      { 'C:\\Notes\\a\\1.md': '![s](./img/s.png)', 'C:\\Notes\\a\\2.md': '![s](./img/s.png)' },
      { 'C:\\Notes\\a\\img\\s.png': 'S', 'C:\\Notes\\img\\s.png': 'S' },
    );
    const plan = await planImageMigration(toGlobal, fs.read);
    const failing: MigrationWriteFs = {
      ...fs.write,
      rewriteDocument: async (path, replacements) => {
        if (path.endsWith('2.md')) throw new Error('写入失败');
        return fs.write.rewriteDocument(path, replacements);
      },
    };
    const report = await executeImageMigration(plan, failing);
    expect(report.errors).toHaveLength(1);
    expect(fs.has('C:\\Notes\\a\\img\\s.png')).toBe(true);
    expect(fs.text('C:\\Notes\\a\\2.md')).toBe('![s](./img/s.png)');
  });
});

describe('统一 → 同级', () => {
  it('只被一个目录引用时直接移动', async () => {
    const fs = createMemoryFs(
      { 'C:\\Notes\\a\\1.md': '![s](../img/s.png)', 'C:\\Notes\\a\\2.md': '![s](../img/s.png)' },
      { 'C:\\Notes\\img\\s.png': 'S' },
    );
    const plan = await planImageMigration(toSibling, fs.read);
    expect(plan.ops).toMatchObject([{ kind: 'move', to: 'C:\\Notes\\a\\img\\s.png' }]);
    await executeImageMigration(plan, fs.write);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![s](./img/s.png)');
    expect(fs.text('C:\\Notes\\a\\2.md')).toBe('![s](./img/s.png)');
    expect(fs.has('C:\\Notes\\img\\s.png')).toBe(false);
  });

  it('多个目录共享时分别复制，全部改写后回收原图', async () => {
    const fs = createMemoryFs(
      { 'C:\\Notes\\a\\1.md': '![s](../img/s.png)', 'C:\\Notes\\b\\c\\2.md': '![s](../../img/s.png)' },
      { 'C:\\Notes\\img\\s.png': 'S' },
    );
    const plan = await planImageMigration(toSibling, fs.read);
    expect(plan.ops.map((op) => op.kind)).toEqual(['copy', 'copy']);
    const report = await executeImageMigration(plan, fs.write);
    expect(report.errors).toEqual([]);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![s](./img/s.png)');
    expect(fs.text('C:\\Notes\\b\\c\\2.md')).toBe('![s](./img/s.png)');
    expect(fs.has('C:\\Notes\\a\\img\\s.png')).toBe(true);
    expect(fs.has('C:\\Notes\\b\\c\\img\\s.png')).toBe(true);
    expect(fs.trashed).toEqual(['C:\\Notes\\img\\s.png']);
  });

  it('同步目录根下的文档同级目录就是统一目录：引用不动、原图保留，其他目录复制一份', async () => {
    const fs = createMemoryFs(
      { 'C:\\Notes\\root.md': '![s](./img/s.png)', 'C:\\Notes\\a\\1.md': '![s](../img/s.png)' },
      { 'C:\\Notes\\img\\s.png': 'S' },
    );
    const plan = await planImageMigration(toSibling, fs.read);
    expect(plan.ops).toMatchObject([{ kind: 'copy', to: 'C:\\Notes\\a\\img\\s.png' }]);
    expect(plan.trash).toEqual([]);
    const report = await executeImageMigration(plan, fs.write);
    expect(report.errors).toEqual([]);
    expect(fs.text('C:\\Notes\\root.md')).toBe('![s](./img/s.png)');
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![s](./img/s.png)');
    expect(fs.has('C:\\Notes\\img\\s.png')).toBe(true);
    expect(fs.trashed).toEqual([]);
  });

  it('只有根目录文档引用统一目录图片时无需整理', async () => {
    const fs = createMemoryFs({ 'C:\\Notes\\root.md': '![s](./img/s.png)' }, { 'C:\\Notes\\img\\s.png': 'S' });
    const plan = await planImageMigration(toSibling, fs.read);
    expect(plan.ops).toEqual([]);
    expect(plan.stats.images).toBe(0);
  });

  it('来回迁移后文档恢复原样', async () => {
    const original = '![x](./img/x.png)';
    const fs = createMemoryFs({ 'C:\\Notes\\a\\1.md': original }, { 'C:\\Notes\\a\\img\\x.png': 'X' });
    await executeImageMigration(await planImageMigration(toGlobal, fs.read), fs.write);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe('![x](../img/x.png)');
    await executeImageMigration(await planImageMigration(toSibling, fs.read), fs.write);
    expect(fs.text('C:\\Notes\\a\\1.md')).toBe(original);
    expect(fs.has('C:\\Notes\\a\\img\\x.png')).toBe(true);
  });
});
