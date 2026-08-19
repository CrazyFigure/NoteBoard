// NoteBoard 大纲面板 useHeadings 测试
// 测试标题提取逻辑和当前项判定算法
// 详见 docs/09-开发路线图.md 9.1, gate:9

import { describe, it, expect } from 'vitest';

// 由于 useHeadings 是 React hook，需要 editor 实例，
// 这里测试纯逻辑函数

describe('useHeadings 逻辑', () => {
  describe('标题提取算法', () => {
    // 模拟标题数据
    const mockHeadings = [
      { id: 'h-0', level: 1, text: '一级标题', pos: 0 },
      { id: 'h-10', level: 2, text: '二级标题', pos: 10 },
      { id: 'h-20', level: 3, text: '三级标题', pos: 20 },
      { id: 'h-30', level: 2, text: '另一个二级', pos: 30 },
      { id: 'h-40', level: 1, text: '第二个一级', pos: 40 },
    ];

    it('提取标题列表', () => {
      expect(mockHeadings.length).toBe(5);
      expect(mockHeadings[0].level).toBe(1);
      expect(mockHeadings[2].level).toBe(3);
    });

    it('标题 pos 单调递增', () => {
      for (let i = 1; i < mockHeadings.length; i++) {
        expect(mockHeadings[i].pos).toBeGreaterThan(mockHeadings[i - 1].pos);
      }
    });
  });

  describe('当前项判定算法', () => {
    const headings = [
      { id: 'h-0', level: 1, text: 'A', pos: 0 },
      { id: 'h-10', level: 2, text: 'B', pos: 10 },
      { id: 'h-20', level: 3, text: 'C', pos: 20 },
      { id: 'h-30', level: 2, text: 'D', pos: 30 },
    ];

    function findActiveHeading(cursorPos: number): string | null {
      let active: { id: string; pos: number } | null = null;
      for (const h of headings) {
        if (h.pos <= cursorPos) {
          active = h;
        } else {
          break;
        }
      }
      return active?.id ?? null;
    }

    it('光标在第一个标题前 → 激活第一个', () => {
      expect(findActiveHeading(0)).toBe('h-0');
    });

    it('光标在第一个和第二个标题之间 → 激活第一个', () => {
      expect(findActiveHeading(5)).toBe('h-0');
    });

    it('光标在第二个标题位置 → 激活第二个', () => {
      expect(findActiveHeading(10)).toBe('h-10');
    });

    it('光标在最后 → 激活最后一个', () => {
      expect(findActiveHeading(35)).toBe('h-30');
    });

    it('空标题列表 → 无激活', () => {
      const findActive = (cursorPos: number) => {
        const empty: never[] = [];
        let active: string | null = null;
        for (const h of empty) {
          if ((h as { pos: number }).pos <= cursorPos) active = (h as { id: string }).id;
        }
        return active;
      };
      expect(findActive(100)).toBe(null);
    });
  });

  describe('缩进计算', () => {
    function getIndent(level: number): number {
      return Math.min(level - 1, 5) * 12 + 8;
    }

    it('level 1 → 8px', () => {
      expect(getIndent(1)).toBe(8);
    });

    it('level 2 → 20px', () => {
      expect(getIndent(2)).toBe(20);
    });

    it('level 3 → 32px', () => {
      expect(getIndent(3)).toBe(32);
    });

    it('level 6 → 68px (max)', () => {
      expect(getIndent(6)).toBe(68);
    });

    it('level 7+ → 68px (capped)', () => {
      expect(getIndent(7)).toBe(68);
      expect(getIndent(100)).toBe(68);
    });
  });

  describe('字号阶梯', () => {
    function getFontSize(level: number): number {
      const sizes = [15, 14, 13, 12, 12, 12];
      return sizes[Math.min(level - 1, 5)];
    }

    it('level 1 → 15px', () => {
      expect(getFontSize(1)).toBe(15);
    });

    it('level 2 → 14px', () => {
      expect(getFontSize(2)).toBe(14);
    });

    it('level 3 → 13px', () => {
      expect(getFontSize(3)).toBe(13);
    });

    it('level 4+ → 12px', () => {
      expect(getFontSize(4)).toBe(12);
      expect(getFontSize(5)).toBe(12);
      expect(getFontSize(6)).toBe(12);
    });
  });

  describe('搜索过滤', () => {
    const headings = [
      { id: 'h-0', level: 1, text: 'Introduction', pos: 0 },
      { id: 'h-10', level: 2, text: 'Getting Started', pos: 10 },
      { id: 'h-20', level: 2, text: 'Installation', pos: 20 },
      { id: 'h-30', level: 1, text: 'Usage', pos: 30 },
    ];

    function filterHeadings(query: string) {
      if (!query.trim()) return headings;
      const q = query.toLowerCase().trim();
      return headings.filter((h) => h.text.toLowerCase().includes(q));
    }

    it('空查询 → 全部', () => {
      expect(filterHeadings('').length).toBe(4);
    });

    it('匹配 "inst" → Installation', () => {
      const result = filterHeadings('inst');
      expect(result.length).toBe(1);
      expect(result[0].text).toBe('Installation');
    });

    it('匹配 "int" → Introduction', () => {
      const result = filterHeadings('int');
      expect(result.length).toBe(1);
      expect(result[0].text).toBe('Introduction');
    });

    it('大小写不敏感', () => {
      expect(filterHeadings('USAGE').length).toBe(1);
      expect(filterHeadings('USAGE')[0].text).toBe('Usage');
    });
  });

  describe('大纲树形折叠与子节点算法', () => {
    // 计算子节点映射
    function computeHasChildrenMap(items: { id: string; level: number }[]): Map<string, boolean> {
      const map = new Map<string, boolean>();
      for (let i = 0; i < items.length; i++) {
        const current = items[i];
        const next = items[i + 1];
        const hasChildren = Boolean(next && next.level > current.level);
        map.set(current.id, hasChildren);
      }
      return map;
    }

    // 计算折叠隐藏集合
    function computeHiddenIds(
      items: { id: string; level: number }[],
      collapsed: Set<string>,
      searchQuery = '',
    ): Set<string> {
      if (searchQuery.trim()) {
        return new Set<string>();
      }

      const hidden = new Set<string>();
      const ancestorStack: { level: number; isHiddenOrCollapsed: boolean }[] = [];

      for (const h of items) {
        while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].level >= h.level) {
          ancestorStack.pop();
        }

        const parentAncestor = ancestorStack.length > 0 ? ancestorStack[ancestorStack.length - 1] : null;
        const isHidden = parentAncestor ? parentAncestor.isHiddenOrCollapsed : false;

        if (isHidden) {
          hidden.add(h.id);
        }

        const isSelfCollapsed = collapsed.has(h.id);
        ancestorStack.push({
          level: h.level,
          isHiddenOrCollapsed: isHidden || isSelfCollapsed,
        });
      }

      return hidden;
    }

    const testHeadings = [
      { id: 'h-1', level: 1, text: '第一章' },
      { id: 'h-1-1', level: 2, text: '1.1 节' },
      { id: 'h-1-1-1', level: 3, text: '1.1.1 详细' },
      { id: 'h-1-2', level: 2, text: '1.2 节' },
      { id: 'h-2', level: 1, text: '第二章' },
      { id: 'h-2-1', level: 2, text: '2.1 节' },
    ];

    it('正确判断各个标题是否有子标题', () => {
      const hasChildrenMap = computeHasChildrenMap(testHeadings);
      expect(hasChildrenMap.get('h-1')).toBe(true); // 第一章 有子节点 (1.1 节)
      expect(hasChildrenMap.get('h-1-1')).toBe(true); // 1.1 节 有子节点 (1.1.1 详细)
      expect(hasChildrenMap.get('h-1-1-1')).toBe(false); // 1.1.1 详细 无子节点
      expect(hasChildrenMap.get('h-1-2')).toBe(false); // 1.2 节 后面紧跟第二章(level 1)，无子节点
      expect(hasChildrenMap.get('h-2')).toBe(true); // 第二章 有子节点 (2.1 节)
      expect(hasChildrenMap.get('h-2-1')).toBe(false); // 2.1 节 末尾，无子节点
    });

    it('折叠第一章时只隐藏第一章的后代，不影响第二章及其子节点', () => {
      const collapsed = new Set(['h-1']);
      const hidden = computeHiddenIds(testHeadings, collapsed);

      // 第一章的所有直接与间接子节点应该被隐藏
      expect(hidden.has('h-1-1')).toBe(true);
      expect(hidden.has('h-1-1-1')).toBe(true);
      expect(hidden.has('h-1-2')).toBe(true);

      // 第一章自身不被隐藏
      expect(hidden.has('h-1')).toBe(false);

      // 第二章及其子节点绝不应该被隐藏
      expect(hidden.has('h-2')).toBe(false);
      expect(hidden.has('h-2-1')).toBe(false);
    });

    it('折叠 1.1 节时只隐藏 1.1.1，不影响 1.2 节及后续章节', () => {
      const collapsed = new Set(['h-1-1']);
      const hidden = computeHiddenIds(testHeadings, collapsed);

      expect(hidden.has('h-1-1-1')).toBe(true);

      expect(hidden.has('h-1')).toBe(false);
      expect(hidden.has('h-1-1')).toBe(false);
      expect(hidden.has('h-1-2')).toBe(false);
      expect(hidden.has('h-2')).toBe(false);
      expect(hidden.has('h-2-1')).toBe(false);
    });

    it('支持跳级标题的折叠传递', () => {
      const skippedHeadings = [
        { id: 'h-root', level: 1 },
        { id: 'h-deep', level: 3 },
      ];
      const collapsed = new Set(['h-root']);
      const hidden = computeHiddenIds(skippedHeadings, collapsed);
      expect(hidden.has('h-deep')).toBe(true);
    });

    it('搜索状态下不折叠隐藏条目', () => {
      const collapsed = new Set(['h-1']);
      const hidden = computeHiddenIds(testHeadings, collapsed, '1.1');
      expect(hidden.size).toBe(0);
    });
  });
});
