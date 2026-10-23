// NoteBoard 文档历史记录：各格式查看器的统一约定
// 查看器以只读方式渲染「目标版本」，并在显示更改时标出相对「对比版本」的新增 / 删除 / 修改；
// 改动处列表交给外层顶栏做「上一处 / 下一处」跳转。

import type { MutableRefObject } from 'react';

export interface ChangeInfo {
  /** 改动处总数 */
  count: number;
  /** 当前定位的改动序号（从 0 开始；-1 表示尚未定位） */
  index: number;
}

export interface ChangeNavigator {
  next: () => void;
  prev: () => void;
}

export interface VersionViewerProps {
  /** 文档路径（推断语言、解析相对资源） */
  path: string;
  docKey: string;
  kind: string;
  /** 对比版本（更早的一版）；null 表示没有可对比的版本 */
  base: string | null;
  /** 正在查看的版本 */
  target: string;
  showChanges: boolean;
  onChangeInfo: (info: ChangeInfo) => void;
  navigatorRef: MutableRefObject<ChangeNavigator | null>;
}
