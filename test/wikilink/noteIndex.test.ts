// 笔记索引：目标解析、补全排序与最短链接（路径按 Windows 语义）
import { afterEach, describe, expect, it, vi } from 'vitest';

const readDir = vi.fn();
vi.mock('../../src/core/ipc/commands', () => ({
  readDir: (...args: unknown[]) => readDir(...args),
}));

import {
  absoluteTargetPath,
  buildSnapshot,
  createExternalEntry,
  linkTargetFor,
  loadNoteIndex,
  relativePathBetween,
  resolveAmongEntries,
  resetNoteIndexForTest,
  resolveWikiTarget,
  searchNotes,
  shortestLinkTarget,
  type NoteEntry,
} from '../../src/features/wikilink/noteIndex';

const ROOT = 'C:\\vault';

function entry(relPath: string, mtime = 0): NoteEntry {
  const name = relPath.split('/').pop()!;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const segments = relPath.split('/');
  segments.pop();
  return {
    path: `${ROOT}\\${relPath.replace(/\//g, '\\')}`,
    name,
    stem: dot > 0 ? name.slice(0, dot) : name,
    ext,
    relPath,
    dir: segments.length ? `${ROOT}\\${segments.join('\\')}` : ROOT,
    isMarkdown: ext === 'md',
    kind: ext === 'md' ? 'markdown' : 'image',
    mtime,
    size: 10,
  };
}

const snapshot = buildSnapshot(ROOT, [
  entry('首页.md', 5),
  entry('日记/2026-10-26.md', 9),
  entry('项目/计划.md', 3),
  entry('归档/计划.md', 1),
  entry('项目/深层/计划.md', 2),
  entry('资源/架构图.png', 4),
]);

afterEach(() => {
  resetNoteIndexForTest();
  readDir.mockReset();
});

describe('resolveWikiTarget', () => {
  it('按文件名解析，大小写不敏感', () => {
    expect(resolveWikiTarget(snapshot, '首页', null)?.relPath).toBe('首页.md');
    expect(resolveWikiTarget(snapshot, '架构图.PNG', null)?.relPath).toBe('资源/架构图.png');
  });

  it('重名时同目录优先，其次路径较短', () => {
    expect(resolveWikiTarget(snapshot, '计划', `${ROOT}\\归档\\x.md`)?.relPath).toBe('归档/计划.md');
    expect(resolveWikiTarget(snapshot, '计划', `${ROOT}\\首页.md`)?.relPath).toBe('归档/计划.md');
  });

  it('带目录：相对仓库根、相对当前文档、路径后缀', () => {
    expect(resolveWikiTarget(snapshot, '项目/计划', null)?.relPath).toBe('项目/计划.md');
    expect(resolveWikiTarget(snapshot, '../项目/计划.md', `${ROOT}\\日记\\2026-10-26.md`)?.relPath).toBe('项目/计划.md');
    expect(resolveWikiTarget(snapshot, '深层/计划', null)?.relPath).toBe('项目/深层/计划.md');
  });

  it('未找到返回 null（另一端尚未同步时保持未解析）', () => {
    expect(resolveWikiTarget(snapshot, '还没同步的笔记', null)).toBeNull();
    expect(resolveWikiTarget(snapshot, '  ', null)).toBeNull();
  });
});

describe('仓库外的文件', () => {
  it('完整路径直接按路径解析', () => {
    expect(resolveWikiTarget(snapshot, 'C:/vault/项目/计划', null)?.relPath).toBe('项目/计划.md');
    expect(resolveWikiTarget(snapshot, 'D:/其它/计划', null)).toBeNull();
  });

  it('相对路径与完整路径换算为候选绝对路径', () => {
    expect(absoluteTargetPath('../外部/笔记', `${ROOT}\\日记\\a.md`)).toBe('C:\\vault\\外部\\笔记');
    expect(absoluteTargetPath('D:/笔记/a', null)).toBe('D:\\笔记\\a');
    expect(absoluteTargetPath('只写名称', `${ROOT}\\a.md`)).toBeNull();
  });

  it('在已打开的文档中按名称或路径解析', () => {
    const opened = [createExternalEntry('D:\\外部\\backend.md'), createExternalEntry('C:\\Users\\me\\frontend.md')];
    expect(resolveAmongEntries(opened, 'backend', `${ROOT}\\a.md`)?.path).toBe('D:\\外部\\backend.md');
    expect(resolveAmongEntries(opened, '../Users/me/frontend', 'C:\\vault\\a.md')?.path).toBe('C:\\Users\\me\\frontend.md');
    expect(resolveAmongEntries(opened, '不存在', null)).toBeNull();
  });

  it('仓库外的补全项写相对当前文档的路径，跨盘符写完整路径', () => {
    expect(relativePathBetween('C:\\vault\\日记', 'C:\\Users\\me\\frontend.md')).toBe('../../Users/me/frontend.md');
    expect(relativePathBetween('C:\\vault', 'D:\\a.md')).toBeNull();
    const sameDrive = createExternalEntry('C:\\Users\\me\\frontend.md');
    expect(linkTargetFor(snapshot, sameDrive, `${ROOT}\\首页.md`)).toBe('../Users/me/frontend');
    expect(linkTargetFor(snapshot, createExternalEntry('D:\\外部\\backend.md'), `${ROOT}\\首页.md`)).toBe('D:/外部/backend');
    expect(linkTargetFor(snapshot, createExternalEntry('C:\\vault2\\同级.md'), 'C:\\vault2\\a.md')).toBe('./同级');
  });

  it('补全候选包含已打开的仓库外文档', () => {
    const opened = [createExternalEntry('D:\\外部\\backend.md')];
    const result = searchNotes(snapshot, 'back', null, 10, opened);
    expect(result[0]).toMatchObject({ name: 'backend.md', external: true });
    expect(searchNotes(null, 'back', null, 10, opened)).toHaveLength(1);
  });
});

describe('searchNotes / shortestLinkTarget', () => {
  it('空查询列出最近修改的笔记，不含图片与自身', () => {
    const result = searchNotes(snapshot, '', `${ROOT}\\首页.md`).map((item) => item.relPath);
    expect(result[0]).toBe('日记/2026-10-26.md');
    expect(result).not.toContain('首页.md');
    expect(result).not.toContain('资源/架构图.png');
  });

  it('前缀匹配优先于包含与子序列', () => {
    const result = searchNotes(snapshot, '计', null).map((item) => item.relPath);
    expect(result.slice(0, 3).every((rel) => rel.endsWith('计划.md'))).toBe(true);
    expect(searchNotes(snapshot, '架构', null)[0].relPath).toBe('资源/架构图.png');
  });

  it('主名唯一写主名，重名写相对路径', () => {
    expect(shortestLinkTarget(snapshot, snapshot.byRelPath.get('首页.md')!)).toBe('首页');
    expect(shortestLinkTarget(snapshot, snapshot.byRelPath.get('项目/计划.md')!)).toBe('项目/计划');
    expect(shortestLinkTarget(snapshot, snapshot.byRelPath.get('资源/架构图.png')!)).toBe('架构图.png');
  });
});

describe('loadNoteIndex', () => {
  it('逐级扫描，跳过隐藏项与不支持的文件', async () => {
    const node = (path: string, isDir: boolean, kind: string | null = 'markdown') => ({
      path,
      name: path.split('\\').pop()!,
      isDir,
      kind: isDir ? null : kind,
      size: 1,
      mtime: 1,
      isHidden: path.split('\\').pop()!.startsWith('.'),
      isSymlink: false,
    });
    readDir.mockImplementation(async (dir: string) => {
      if (dir === ROOT) {
        return [node(`${ROOT}\\子目录`, true), node(`${ROOT}\\.trash`, true), node(`${ROOT}\\a.md`, false), node(`${ROOT}\\b.zip`, false, 'unsupported')];
      }
      if (dir === `${ROOT}\\子目录`) return [node(`${ROOT}\\子目录\\c.md`, false)];
      throw new Error(`unexpected ${dir}`);
    });
    const result = await loadNoteIndex(ROOT);
    expect(result.entries.map((item) => item.relPath).sort()).toEqual(['a.md', '子目录/c.md']);
    expect(readDir).toHaveBeenCalledTimes(2);
  });
});
