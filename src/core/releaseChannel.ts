// 发布渠道：GitHub 主仓库与腾讯云 CNB 镜像
// 后端按设置中的渠道检查更新并下载安装包、字体包与插件，前端只负责展示与切换

import type { UpdateChannel } from './ipc/types';
import { useSettingsStore } from '../stores/settingsStore';

export interface ReleaseChannelInfo {
  id: UpdateChannel;
  /** 界面显示名 */
  label: string;
  /** 仓库主页 */
  repoUrl: string;
  /** 仓库路径，用于按钮文字 */
  repoPath: string;
}

export const RELEASE_CHANNELS: Record<UpdateChannel, ReleaseChannelInfo> = {
  github: {
    id: 'github',
    label: 'GitHub',
    repoUrl: 'https://github.com/CrazyFigure/NoteBoard',
    repoPath: 'CrazyFigure/NoteBoard',
  },
  cnb: {
    id: 'cnb',
    label: '腾讯云 CNB',
    repoUrl: 'https://cnb.cool/crazy-figure/NoteBoard',
    repoPath: 'crazy-figure/NoteBoard',
  },
};

/** 设置缺失或为未知值时回到默认 GitHub */
export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return value === 'cnb' ? 'cnb' : 'github';
}

/** 读取当前渠道（非 React 场景） */
export function currentUpdateChannel(): UpdateChannel {
  return normalizeUpdateChannel(useSettingsStore.getState().settings.system?.updateChannel);
}

/** 订阅当前渠道（React 组件） */
export function useUpdateChannel(): UpdateChannel {
  return useSettingsStore((state) => normalizeUpdateChannel(state.settings.system?.updateChannel));
}

/** 另一个可选渠道，用于检测失败时建议切换 */
export function alternateUpdateChannel(channel: UpdateChannel): UpdateChannel {
  return channel === 'cnb' ? 'github' : 'cnb';
}
