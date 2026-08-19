// NoteBoard 面包屑路径解析与组件逻辑测试

import { describe, it, expect } from 'vitest';
import { parsePathSegments } from '../../src/features/explorer/ExplorerBreadcrumb';

describe('parsePathSegments', () => {
  it('处理空路径', () => {
    expect(parsePathSegments('')).toEqual([]);
  });

  it('正确解析 Windows 根盘符', () => {
    const segments = parsePathSegments('C:\\');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      name: 'C:',
      fullPath: 'C:\\',
      isDrive: true,
      isLast: true,
    });
  });

  it('正确解析 Windows 多级目录路径', () => {
    const segments = parsePathSegments('C:\\Software\\WorkSpace\\NoteBoard');
    expect(segments).toHaveLength(4);
    expect(segments[0]).toEqual({
      name: 'C:',
      fullPath: 'C:\\',
      isDrive: true,
      isLast: false,
    });
    expect(segments[1]).toEqual({
      name: 'Software',
      fullPath: 'C:\\Software',
      isDrive: false,
      isLast: false,
    });
    expect(segments[2]).toEqual({
      name: 'WorkSpace',
      fullPath: 'C:\\Software\\WorkSpace',
      isDrive: false,
      isLast: false,
    });
    expect(segments[3]).toEqual({
      name: 'NoteBoard',
      fullPath: 'C:\\Software\\WorkSpace\\NoteBoard',
      isDrive: false,
      isLast: true,
    });
  });

  it('正确处理正斜杠输入的 Windows 路径', () => {
    const segments = parsePathSegments('D:/Projects/App/src');
    expect(segments).toHaveLength(4);
    expect(segments[0].fullPath).toBe('D:\\');
    expect(segments[1].fullPath).toBe('D:\\Projects');
    expect(segments[2].fullPath).toBe('D:\\Projects\\App');
    expect(segments[3].fullPath).toBe('D:\\Projects\\App\\src');
    expect(segments[3].isLast).toBe(true);
  });

  it('正确处理非盘符路径', () => {
    const segments = parsePathSegments('/home/user/docs');
    expect(segments).toHaveLength(3);
    expect(segments[0].name).toBe('home');
    expect(segments[2].name).toBe('docs');
    expect(segments[2].isLast).toBe(true);
  });
});
