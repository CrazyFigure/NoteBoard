// NoteBoard Infographic 源码解析与容错单元测试

import { describe, test, expect } from 'vitest';
import { parseInfographicCode } from '@/features/infographic/infographicParser';
import { INFOGRAPHIC_TEMPLATES } from '@/features/infographic/infographicTemplates';

describe('Infographic 解析器测试 (Parser & Tolerant)', () => {
  test('空代码与空白字符串安全处理', () => {
    const res1 = parseInfographicCode('');
    expect(res1.data).toBeNull();
    expect(res1.error).toBeNull();

    const res2 = parseInfographicCode('   \n  \t ');
    expect(res2.data).toBeNull();
    expect(res2.error).toBeNull();
  });

  test('标准 JSON 格式解析', () => {
    const jsonStr = JSON.stringify({
      type: 'metric-cards',
      title: '季度业务核心指标',
      data: [
        { label: '注册用户', value: '50,000', change: '+20%', trend: 'up' },
        { label: '付费转化率', value: '4.5%', change: '+0.5%', trend: 'up' },
      ],
    });

    const res = parseInfographicCode(jsonStr);
    expect(res.error).toBeNull();
    expect(res.data).not.toBeNull();
    expect(res.data?.type).toBe('metric-cards');
    expect(res.data?.title).toBe('季度业务核心指标');
    expect(res.data?.data?.length).toBe(2);
    expect(res.data?.data?.[0].label).toBe('注册用户');
  });

  test('YAML 简化语法解析（指标看板）', () => {
    const yamlStr = `type: metric-cards
title: 核心运营指标
data:
  - label: 日活跃用户
    value: "128,450"
    change: "+12.5%"
    trend: up
    color: blue
  - label: 核心转化率
    value: "38.6%"
    change: "+3.2%"
    trend: up
    color: emerald`;

    const res = parseInfographicCode(yamlStr);
    expect(res.error).toBeNull();
    expect(res.data).not.toBeNull();
    expect(res.data?.type).toBe('metric-cards');
    expect(res.data?.data?.length).toBe(2);
    expect(res.data?.data?.[0].value).toBe('128,450');
    expect(res.data?.data?.[1].color).toBe('emerald');
  });

  test('所有内置预设模板均可无损解析', () => {
    for (const tmpl of INFOGRAPHIC_TEMPLATES) {
      const res = parseInfographicCode(tmpl.code);
      expect(res.error).toBeNull();
      expect(res.data).not.toBeNull();
      expect(res.data?.type).toBeDefined();
    }
  });

  test('对比矩阵 (Comparison) 解析', () => {
    const compYaml = `type: comparison
title: 架构方案对比
groups:
  - name: NoteBoard
    highlight: true
    features:
      - name: 本地存储
        value: 100%
        included: true
      - name: 启动速度
        value: < 200ms
        included: true
  - name: 其他方案
    features:
      - name: 本地存储
        included: false`;

    const res = parseInfographicCode(compYaml);
    expect(res.error).toBeNull();
    expect(res.data?.type).toBe('comparison');
    expect(res.data?.groups?.length).toBe(2);
    expect(res.data?.groups?.[0].name).toBe('NoteBoard');
    expect(res.data?.groups?.[0].features.length).toBe(2);
  });

  test('四象限矩阵 (Quadrant) 解析', () => {
    const quadYaml = `type: quadrant
title: 功能优先级分析
quadrantXLabel: 难度
quadrantYLabel: 价值
points:
  - name: 信息图
    x: 30
    y: 80
    color: emerald`;

    const res = parseInfographicCode(quadYaml);
    expect(res.error).toBeNull();
    expect(res.data?.type).toBe('quadrant');
    expect(res.data?.points?.length).toBe(1);
    expect(res.data?.points?.[0].name).toBe('信息图');
  });
});
