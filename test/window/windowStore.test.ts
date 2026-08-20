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

  it('requestCloseTab 在干净文档时直接关闭，在脏文档时设置 pendingCloseKeys 触发拦截', () => {
    const cleanTab = createMockTab('clean', 'clean.md');
    const dirtyTab = { ...createMockTab('dirty', 'dirty.md'), isDirty: true };

    useWindowStore.setState({
      tabs: [cleanTab, dirtyTab],
      activeKey: 'clean',
      pendingCloseKeys: [],
    });

    // 1. 关闭干净 tab：直接关闭
    useWindowStore.getState().requestCloseTab('clean');
    expect(useWindowStore.getState().tabs.map((t) => t.key)).toEqual(['dirty']);
    expect(useWindowStore.getState().pendingCloseKeys).toEqual([]);

    // 2. 关闭脏 tab：触发 pendingCloseKeys
    useWindowStore.getState().requestCloseTab('dirty');
    expect(useWindowStore.getState().tabs.map((t) => t.key)).toEqual(['dirty']);
    expect(useWindowStore.getState().pendingCloseKeys).toEqual(['dirty']);
  });

  it('requestCloseOther 在存在未保存文档时触发拦截', () => {
    const tab1 = createMockTab('tab1');
    const tab2 = { ...createMockTab('tab2'), isDirty: true };
    const tab3 = createMockTab('tab3');

    useWindowStore.setState({
      tabs: [tab1, tab2, tab3],
      activeKey: 'tab1',
      pendingCloseKeys: [],
    });

    // 关闭除 tab1 外的其他 tab（包含脏 tab2）
    useWindowStore.getState().requestCloseOther('tab1');
    expect(useWindowStore.getState().pendingCloseKeys).toEqual(['tab2', 'tab3']);
    // 标签页尚未真正关闭
    expect(useWindowStore.getState().tabs.length).toBe(3);
  });

  it('setTabViewMode 仅改变指定标签页的模式，其他标签页模式保持独立', () => {
    const tab1 = createMockTab('tab1');
    const tab2 = createMockTab('tab2');

    useWindowStore.setState({
      tabs: [tab1, tab2],
      activeKey: 'tab1',
    });

    // 将 tab1 设置为源码模式
    useWindowStore.getState().setTabViewMode('tab1', 'source');

    const state = useWindowStore.getState();
    expect(state.getTab('tab1')?.viewMode).toBe('source');
    // tab2 的 viewMode 保持为 visual 不受影响
    expect(state.getTab('tab2')?.viewMode).toBe('visual');

    // 将 tab2 设置为源码模式，tab1 切回可视化
    useWindowStore.getState().setTabViewMode('tab2', 'source');
    useWindowStore.getState().setTabViewMode('tab1', 'visual');

    const updatedState = useWindowStore.getState();
    expect(updatedState.getTab('tab1')?.viewMode).toBe('visual');
    expect(updatedState.getTab('tab2')?.viewMode).toBe('source');
  });
});
