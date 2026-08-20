// NoteBoard PlantUML 编码器与 URL 生成测试
// 详见 docs/08-数据契约与持久化.md 与 docs/09-开发路线图.md

import { describe, test, expect } from 'vitest';
import { encodePlantUml, getPlantUmlSvgUrl } from '@/features/plantuml/plantumlEncoder';

describe('plantumlEncoder 编码器测试', () => {
  const sampleCode = `@startuml
Bob -> Alice : hello
Alice -> Bob : ok
@enduml`;

  test('encodePlantUml 正确压缩并生成 PlantUML Base64 字符串', async () => {
    const encoded = await encodePlantUml(sampleCode);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    // PlantUML 自定义 64 进制只包含 0-9, A-Z, a-z, -, _ 及 ~1 前缀
    expect(/^~?[0-9A-Za-z\-_]+$/.test(encoded)).toBe(true);
  });

  test('getPlantUmlSvgUrl 生成正确的官方/私有服务器 SVG URL', async () => {
    const url = await getPlantUmlSvgUrl(sampleCode);
    expect(url).toContain('plantuml.com/plantuml/svg/');
    const customUrl = await getPlantUmlSvgUrl(sampleCode, 'https://my-plantuml.org');
    expect(customUrl).toContain('https://my-plantuml.org/svg/');
  });

  test('空代码串能够平稳处理', async () => {
    const encoded = await encodePlantUml('');
    expect(encoded).toBe('');
    const url = await getPlantUmlSvgUrl('');
    expect(url).toBe('');
  });
});
