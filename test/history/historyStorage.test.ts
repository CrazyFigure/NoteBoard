// NoteBoard S13/J1 历史存储压缩测试
// 覆盖 J 节必测清单：emoji/中文/CRLF/纯删除/完全替换/超长公共前缀/201 节点边界/
//                     另存为迁移/清理；以及与朴素全文实现的随机序列等价对照。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  initializeDocumentHistory,
  recordDocumentChange,
  undoDocumentHistory,
  redoDocumentHistory,
  getCurrentDocumentHistoryContent,
  synchronizeCurrentDocumentHistoryContent,
  moveDocumentHistory,
  clearDocumentHistory,
  registerDocumentHistoryAdapter,
  getDocumentHistoryAvailability,
  type DocumentHistoryEntry,
  type DocumentHistoryNavigation,
} from '@/features/history/documentHistory';

const KEY = 'C:\\t\\j1.md';

/** 记录编辑并返回当前内容（便捷链） */
function edit(state: { content: string }, next: string, startsNewGroup = false): void {
  recordDocumentChange(KEY, next, { mode: 'source', startsNewGroup, selection: { anchor: 0, head: 0 } });
  state.content = next;
}

/** 安装记录每次 applyEntry 内容的适配器 */
function installRecorder(): { applied: string[] } {
  const applied: string[] = [];
  registerDocumentHistoryAdapter(KEY, {
    applyEntry: (entry: DocumentHistoryEntry, _nav: DocumentHistoryNavigation) => {
      applied.push(entry.content);
    },
  });
  return { applied };
}

describe('S13/J1 历史存储压缩（检查点 + 可逆补丁）', () => {
  beforeEach(() => {
    clearDocumentHistory(KEY);
  });

  it('emoji / 中文 / CRLF：补丁重建逐字一致', () => {
    const state = { content: '' };
    initializeDocumentHistory(KEY, '😀中文\r\n第二行', 'source');
    state.content = '😀中文\r\n第二行';
    edit(state, '😀中文✨\r\n第二行');
    edit(state, '😀中文✨\r\n第🚀二行😀');
    edit(state, '😀中文✨\r\n第🚀二行😀🇨🇳');
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('😀中文✨\r\n第🚀二行😀🇨🇳');
    // 全链撤销重建逐字一致
    const { applied } = installRecorder();
    while (undoDocumentHistory(KEY)) {
      // 逐步撤销
    }
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('😀中文\r\n第二行');
    expect(applied[0]).toBe('😀中文\r\n第二行');
    // 全链重做
    while (redoDocumentHistory(KEY)) {
      // 逐步重做
    }
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('😀中文✨\r\n第🚀二行😀🇨🇳');
  });

  it('纯删除 / 完全替换：补丁与检查点路径均正确', () => {
    installRecorder();
    const state = { content: '' };
    const base = 'abcdefghij'.repeat(50);
    initializeDocumentHistory(KEY, base, 'source');
    state.content = base;
    // 纯删除（中段删除 300 字符；独立分组）
    edit(state, base.slice(0, 100) + base.slice(400), true);
    // 完全替换（无公共前后缀 → 检查点路径）
    edit(state, '完全不同的内容', true);
    edit(state, '再改一次', true);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('再改一次');
    expect(undoDocumentHistory(KEY)).toBe(true);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('完全不同的内容');
    expect(undoDocumentHistory(KEY)).toBe(true);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe(base.slice(0, 100) + base.slice(400));
    expect(undoDocumentHistory(KEY)).toBe(true);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe(base);
  });

  it('超长公共前缀：补丁高效且重建正确', () => {
    installRecorder();
    const prefix = '很长的前缀'.repeat(2000);
    const state = { content: '' };
    initializeDocumentHistory(KEY, prefix + '尾部', 'source');
    state.content = prefix + '尾部';
    edit(state, prefix + '尾标', true);
    edit(state, prefix + '结尾', true);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe(prefix + '结尾');
    undoDocumentHistory(KEY);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe(prefix + '尾标');
    undoDocumentHistory(KEY);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe(prefix + '尾部');
  });

  it('201 节点边界：淘汰最老节点后剩余补丁仍有基准（新首节点物化）', () => {
    installRecorder();
    const state = { content: '' };
    initializeDocumentHistory(KEY, 'base', 'source');
    state.content = 'base';
    // 生成 210 个分组节点（超过 201 上限触发淘汰）
    for (let i = 0; i < 210; i++) {
      edit(state, `content-${i}-内容`, true);
    }
    // 当前内容正确
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('content-209-内容');
    // 可以一路撤销到（被截断后的）首节点且内容正确
    let steps = 0;
    while (undoDocumentHistory(KEY)) steps += 1;
    expect(steps).toBeGreaterThanOrEqual(199);
    // 撤销到底后的内容是被保留的最老节点（base 已被淘汰）
    const firstContent = getCurrentDocumentHistoryContent(KEY);
    expect(firstContent).toMatch(/^content-\d+-内容$/);
    // 重做全链恢复
    while (redoDocumentHistory(KEY)) {
      // 逐步重做
    }
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('content-209-内容');
  });

  it('同组更新重算补丁；撤销回到分组起点', () => {
    installRecorder();
    const state = { content: '' };
    initializeDocumentHistory(KEY, '分组0', 'source');
    state.content = '分组0';
    edit(state, '分组1a', true);  // 新分组
    edit(state, '分组1b');        // 同组更新
    edit(state, '分组1c');        // 同组更新
    undoDocumentHistory(KEY);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('分组0');
    redoDocumentHistory(KEY);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('分组1c');
  });

  it('synchronize 修改当前节点：后继物化检查点，重做分支逐字保持', () => {
    installRecorder();
    const state = { content: '' };
    initializeDocumentHistory(KEY, 'a', 'source');
    state.content = 'a';
    edit(state, 'b', true);
    edit(state, 'c', true);
    undoDocumentHistory(KEY); // 回到 b
    // 规范化当前节点内容（模式边界同步）
    synchronizeCurrentDocumentHistoryContent(KEY, 'b规范化', 'visual');
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('b规范化');
    // 重做分支仍保持原内容 c
    redoDocumentHistory(KEY);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('c');
  });

  it('另存为迁移整条历史（moveDocumentHistory）', () => {
    installRecorder();
    const state = { content: '' };
    initializeDocumentHistory(KEY, '内容A', 'source');
    state.content = '内容A';
    edit(state, '内容B', true);
    const NEW_KEY = 'C:\\t\\new-name.md';
    clearDocumentHistory(NEW_KEY);
    moveDocumentHistory(KEY, NEW_KEY);
    expect(getCurrentDocumentHistoryContent(NEW_KEY)).toBe('内容B');
    expect(getDocumentHistoryAvailability(NEW_KEY).canUndo).toBe(true);
    // 旧 key 无历史
    expect(getCurrentDocumentHistoryContent(KEY)).toBeNull();
  });

  it('撤销后新输入删除旧重做分支', () => {
    installRecorder();
    const state = { content: '' };
    initializeDocumentHistory(KEY, '0', 'source');
    state.content = '0';
    edit(state, '1', true);
    edit(state, '2', true);
    edit(state, '3', true);
    undoDocumentHistory(KEY);
    undoDocumentHistory(KEY); // 回到 1
    edit(state, '新分支', true);
    expect(getDocumentHistoryAvailability(KEY).canRedo).toBe(false);
    expect(getCurrentDocumentHistoryContent(KEY)).toBe('新分支');
  });

  it('随机编辑序列与朴素全文实现逐字等价（100 步）', () => {
    installRecorder();
    // 朴素参照：直接维护全文数组模拟旧实现语义
    const naive: string[] = ['seed'];
    let naiveIndex = 0;
    let content = 'seed';
    // 原实现语义：撤销/重做/模式边界后下一次真实编辑强制开新组（forceNextGroup）
    let naiveForceNextGroup = false;
    const state = { content };
    initializeDocumentHistory(KEY, content, 'source');

    // 固定种子的伪随机（可重复）
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const alphabet = 'abc中😀\r\n';

    for (let step = 0; step < 100; step++) {
      const op = rand(10);
      if (op < 6) {
        // 编辑：随机位置插入/删除
        const pos = rand(content.length + 1);
        const len = rand(3);
        const insert = alphabet[rand(alphabet.length)].repeat(1 + rand(2));
        content = content.slice(0, pos) + insert + content.slice(pos + len);
        // 新分组概率 ~50%；撤销/重做后的首次编辑强制新组
        const startsNewGroup = rand(2) === 0 || naiveForceNextGroup;
        // 原实现语义：内容与当前节点相同则不产生新步骤（含 forceNextGroup 也跳过）
        if (content === naive[naiveIndex]) {
          naiveForceNextGroup = false;
          continue;
        }
        naiveForceNextGroup = false;
        edit(state, content, startsNewGroup);
        // 朴素模拟（与原实现同语义：index=0 时强制新组）
        if (startsNewGroup || naiveIndex === 0) {
          naiveIndex += 1;
          naive.length = naiveIndex;
          naive[naiveIndex] = content;
        } else {
          naive[naiveIndex] = content;
        }
      } else if (op < 8) {
        // undo
        if (naiveIndex > 0) {
          if (undoDocumentHistory(KEY)) {
            naiveIndex -= 1;
            content = naive[naiveIndex];
            naiveForceNextGroup = true;
          }
        }
      } else {
        // redo
        if (naiveIndex < naive.length - 1) {
          if (redoDocumentHistory(KEY)) {
            naiveIndex += 1;
            content = naive[naiveIndex];
            naiveForceNextGroup = true;
          }
        }
      }
      // 每步校验当前内容逐字一致
      const actual = getCurrentDocumentHistoryContent(KEY);
      expect(actual).toBe(content);
      expect(actual).toBe(naive[naiveIndex]);
    }
  });
});
