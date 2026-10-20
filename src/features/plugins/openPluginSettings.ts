// 所有端复用设置弹窗，避免移动端打开额外原生窗口。
import { useLayoutStore } from '../../stores/layoutStore';
import type { PluginId } from './pluginTypes';

/** 指定插件页、字体区域或具体插件卡片；每次跳转都覆盖目标并打开设置。 */
export function openPluginSettings(section: 'plugins' | 'fonts' | `plugin:${PluginId}` = 'plugins') {
  useLayoutStore.setState({ settingsTarget: section, settingsModalVisible: true });
}
