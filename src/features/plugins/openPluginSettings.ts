// 所有端复用设置弹窗，避免移动端打开额外原生窗口。
import { useLayoutStore } from '../../stores/layoutStore';

/** 指定插件或字体区域；每次跳转都覆盖目标并打开设置。 */
export function openPluginSettings(section: 'plugins' | 'fonts' = 'plugins') {
  useLayoutStore.setState({ settingsTarget: section, settingsModalVisible: true });
}
