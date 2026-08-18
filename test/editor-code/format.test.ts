// NoteBoard 格式化测试
// JSON / XML 格式化
// 详见 docs/09-开发路线图.md gate:4

import { describe, it, expect } from 'vitest';
import { formatJson, formatXml } from '../../src/features/editor-code/format';

describe('formatJson', () => {
  it('格式化简单对象', () => {
    const input = '{"name":"test","value":123}';
    const result = formatJson(input);
    expect(result).toContain('  "name": "test"');
    expect(result).toContain('  "value": 123');
  });

  it('格式化嵌套对象', () => {
    const input = '{"a":{"b":{"c":1}}}';
    const result = formatJson(input);
    expect(result).toContain('"a": {');
    expect(result).toContain('"b": {');
    expect(result).toContain('"c": 1');
  });

  it('格式化数组', () => {
    const input = '[1,2,3]';
    const result = formatJson(input);
    expect(result).toContain('1,');
    expect(result).toContain('2,');
    expect(result).toContain('3');
  });

  it('无效 JSON 应抛出错误', () => {
    expect(() => formatJson('{invalid}')).toThrow();
  });

  it('输出以换行结尾', () => {
    const result = formatJson('{}');
    expect(result.endsWith('\n')).toBe(true);
  });
});

describe('formatXml', () => {
  it('格式化简单 XML', () => {
    const input = '<root><child>text</child></root>';
    const result = formatXml(input);
    expect(result).toContain('<root>');
    expect(result).toContain('  <child>');
    expect(result).toContain('    text');
    expect(result).toContain('  </child>');
    expect(result).toContain('</root>');
  });

  it('处理自闭合标签', () => {
    const input = '<root><empty/></root>';
    const result = formatXml(input);
    expect(result).toContain('<root>');
    expect(result).toContain('  <empty/>');
    expect(result).toContain('</root>');
  });

  it('处理处理指令', () => {
    const input = '<?xml version="1.0"?><root/>';
    const result = formatXml(input);
    expect(result).toContain('<?xml');
    expect(result).toContain('<root/>');
  });
});
