// windowStore 单元测试
// 测试 tab 开启、单个关闭、关闭左侧、关闭右侧、关闭其他、关闭全部等状态流转

import { describe, it, expect, beforeEach } from 'vitest';
import { useWindowStore, type Tab } from '../../src/stores/windowStore';

function createMockTab(key: string, displayName = `${key}.md`): Tab {
  return {
    key,
    displayName,
    path: `C:\\notes\\${displayName}`,
    kind: 'markdown',
    language: 'markdown',
    isDirty: false,
    isPreview: false,
    viewMode: 'visual',
    externalStatus: null,
    isDetached: false,
  };
}

describe('windowStore tab 关闭操作', () => {
  beforeEach(() => {
    // 重置 store 初始状态
    useWindowStore.setState({
      tabs: [],
      activeKey: null,
      pendingCloseKeys: [],
    });
  });

  it('closeTabsLeft 正确关闭目标左侧的所有标签页', () => {
    const tab1 = createMockTab('tab1');
    const tab2 = createMockTab('tab2');
    const tab3 = createMockTab('tab3');
    const tab4 = createMockTab('tab4');

    useWindowStore.setState({
      tabs: [tab1, tab2, tab3, tab4],
      activeKey: 'tab1',
    });

    // 关闭 tab3 左侧（即 tab1, tab2）
    useWindowStore.getState().closeTabsLeft('tab3');

    const state = useWindowStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual(['tab3', 'tab4']);
    // 激活项原本为已被关闭的 tab1，应自动重定向为 tab3
    expect(state.activeKey).toBe('tab3');
  });

  it('closeTabsLeft 在最左侧 tab 调用时不作任何变更', () => {
    const tab1 = createMockTab('tab1');
    const tab2 = createMockTab('tab2');

    useWindowStore.setState({
      tabs: [tab1, tab2],
      activeKey: 'tab2',
    });

    useWindowStore.getState().closeTabsLeft('tab1');

    const state = useWindowStore.getState();
    expect(state.tabs.length).toBe(2);
    expect(state.activeKey).toBe('tab2');
  });

  it('closeTabsRight 正确关闭目标右侧的所有标签页', () => {
    const tab1 = createMockTab('tab1');
    const tab2 = createMockTab('tab2');
    const tab3 = createMockTab('tab3');
    const tab4 = createMockTab('tab4');

    useWindowStore.setState({
      tabs: [tab1, tab2, tab3, tab4],
      activeKey: 'tab4',
    });

    // 关闭 tab2 右侧（即 tab3, tab4）
    useWindowStore.getState().closeTabsRight('tab2');

    const state = useWindowStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual(['tab1', 'tab2']);
    // 激活项原本为已被关闭的 tab4，应自动重定向为 tab2
    expect(state.activeKey).toBe('tab2');
  });

  it('closeOtherTabs 正确关闭除目标以外的全部标签页', () => {
    const tab1 = createMockTab('tab1');
    const tab2 = createMockTab('tab2');
    const tab3 = createMockTab('tab3');

    useWindowStore.setState({
      tabs: [tab1, tab2, tab3],
      activeKey: 'tab1',
    });

    // 关闭除 tab2 外的其他标签页
    useWindowStore.getState().closeOtherTabs('tab2');

    const state = useWindowStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual(['tab2']);
    expect(state.activeKey).toBe('tab2');
  });

  it('closeAllTabs 正确清空全部标签页', () => {
    const tab1 = createMockTab('tab1');
    const tab2 = createMockTab('tab2');

    useWindowStore.setState({
      tabs: [tab1, tab2],
      activeKey: 'tab1',
    });

    // 关闭全部
    useWindowStore.getState().closeAllTabs();

    const state = useWindowStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeKey).toBeNull();
  });
});
