// 重命名后同步更新双链：沿用原写法、只改指向被改名文件的链接、未打开的文件直接改写磁盘
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = 'C:\\vault';

/** 内存文件系统：路径 → 内容 */
const files = new Map<string, string>();
const written = new Map<string, string>();

vi.mock('../../src/core/ipc/commands', () => ({
  readDir: async (dir: string) => {
    const prefix = `${dir}\\`;
    const names = new Set<string>();
    const result: unknown[] = [];
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [first, ...more] = rest.split('\\');
      if (names.has(first)) continue;
      names.add(first);
      result.push({
        path: `${prefix}${first}`,
        name: first,
        isDir: more.length > 0,
        kind: more.length > 0 ? null : 'markdown',
        size: more.length > 0 ? null : files.get(path)!.length,
        mtime: 1,
        isHidden: false,
        isSymlink: false,
      });
    }
    return result;
  },
  readDocument: async (path: string) => ({ content: files.get(path) ?? '', encoding: 'utf8', eol: 'lf' }),
  writeDocument: async (path: string, content: string) => {
    written.set(path, content);
    files.set(path, content);
    return { ok: true };
  },
}));

const confirm = vi.fn(async () => true);
vi.mock('../../src/stores/promptDialogStore', () => ({ showConfirm: () => confirm() }));

import { applyWikiLinkRename, planWikiLinkRename } from '../../src/features/wikilink/renameLinks';
import { resetNoteIndexForTest } from '../../src/features/wikilink/noteIndex';
import { resetBacklinkCacheForTest } from '../../src/features/wikilink/backlinks';

afterEach(() => {
  files.clear();
  written.clear();
  confirm.mockClear();
  resetNoteIndexForTest();
  resetBacklinkCacheForTest();
});

/** 模拟磁盘上的重命名 */
function renameOnDisk(from: string, to: string): void {
  for (const [path, content] of [...files]) {
    if (path === from || path.startsWith(`${from}\\`)) {
      files.delete(path);
      files.set(to + path.slice(from.length), content);
    }
  }
}

describe('重命名后更新双链', () => {
  it('文件改名：名称写法改为新名称，路径写法改为新路径，其余链接不动', async () => {
    files.set(`${ROOT}\\计划.md`, '# 计划');
    files.set(`${ROOT}\\其它.md`, '无关');
    files.set(`${ROOT}\\日记\\今天.md`, '见 [[计划]]、[[计划#目标|目标]]、[[计划.md]]、![[计划]] 与 [[其它]]\n| [[计划\\|表]] |');

    const plan = await planWikiLinkRename(`${ROOT}\\计划.md`, false);
    expect(plan?.total).toBe(5);
    renameOnDisk(`${ROOT}\\计划.md`, `${ROOT}\\项目计划.md`);
    const updated = await applyWikiLinkRename(plan!, `${ROOT}\\项目计划.md`);

    expect(confirm).toHaveBeenCalledOnce();
    expect(updated).toBe(5);
    expect(written.get(`${ROOT}\\日记\\今天.md`)).toBe(
      '见 [[项目计划]]、[[项目计划#目标|目标]]、[[项目计划.md]]、![[项目计划]] 与 [[其它]]\n| [[项目计划\\|表]] |',
    );
  });

  it('目录改名：只有写了路径的链接需要改写', async () => {
    files.set(`${ROOT}\\旧目录\\笔记.md`, '内容');
    files.set(`${ROOT}\\首页.md`, '[[笔记]] 与 [[旧目录/笔记]]');

    const plan = await planWikiLinkRename(`${ROOT}\\旧目录`, true);
    renameOnDisk(`${ROOT}\\旧目录`, `${ROOT}\\新目录`);
    await applyWikiLinkRename(plan!, `${ROOT}\\新目录`);

    expect(written.get(`${ROOT}\\首页.md`)).toBe('[[笔记]] 与 [[新目录/笔记]]');
  });

  it('没有指向它的链接时不询问', async () => {
    files.set(`${ROOT}\\孤立.md`, '内容');
    files.set(`${ROOT}\\首页.md`, '[[别的]]');
    expect(await planWikiLinkRename(`${ROOT}\\孤立.md`, false)).toBeNull();
  });

  it('用户取消时不改写任何文件', async () => {
    files.set(`${ROOT}\\a.md`, '');
    files.set(`${ROOT}\\b.md`, '[[a]]');
    const plan = await planWikiLinkRename(`${ROOT}\\a.md`, false);
    confirm.mockResolvedValueOnce(false);
    expect(await applyWikiLinkRename(plan!, `${ROOT}\\c.md`)).toBe(0);
    expect(written.size).toBe(0);
  });
});
