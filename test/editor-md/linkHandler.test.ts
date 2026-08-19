// NoteBoard Markdown 链接路径解析单元测试

import { describe, it, expect } from 'vitest';
import { resolveRelativeDocPath } from '../../src/features/editor-md/linkHandler';

describe('Markdown 相对路径解析 (resolveRelativeDocPath)', () => {
  it('应正确解析同级相对路径', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs';
    const rel = 'agent-modules/ology-module-report.md';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\agent-modules\\ology-module-report.md');
  });

  it('应正确处理带 ./ 前缀的相对路径', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs';
    const rel = './img/photo.png';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\img\\photo.png');
  });

  it('应正确处理向上层级 ../ 相对路径', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs\\sub';
    const rel = '../assets/logo.png';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\assets\\logo.png');
  });

  it('若本身已是 Windows 绝对路径，应保持原样', () => {
    const base = 'C:\\Projects\\NoteBoard\\docs';
    const abs = 'D:\\other\\file.md';
    const result = resolveRelativeDocPath(base, abs);
    expect(result).toBe('D:\\other\\file.md');
  });

  it('应正确去除 file:/// 前缀并解码 URL 编码字符', () => {
    const base = 'C:\\Projects\\NoteBoard';
    const rel = 'file:///docs/my%20test.md';
    const result = resolveRelativeDocPath(base, rel);
    expect(result).toBe('C:\\Projects\\NoteBoard\\docs\\my test.md');
  });
});

