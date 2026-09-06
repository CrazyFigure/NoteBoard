// NoteBoard web 端 spans 上报 — 低频批量调用，诊断失败不影响任何业务流程
// 调用时机：启动链路完成（boot）与窗口关闭（window-close）两个里程碑。

import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import * as ipc from '../ipc/commands';
import { takePendingSpans, markReported } from './perfMarks';

// 🔴 R15/N10：前端诊断开关——与 Rust NOTEBOARD_PERF_SPANS 对齐。
//    未启用时跳过 record/dump 上报 IPC；首次有挂起事件时会查询一次开关并缓存
//    （一次低成本 invoke；查询失败按关闭处理）。不宣称"绝对零 IPC"。

let perfEnabledCache: boolean | null = null;

async function isPerfEnabled(): Promise<boolean> {
  if (perfEnabledCache !== null) return perfEnabledCache;
  try {
    const enabled = await invoke<boolean>('is_perf_spans_enabled');
    perfEnabledCache = enabled === true;
  } catch {
    perfEnabledCache = false;
  }
  return perfEnabledCache;
}

/** 把尚未上报的 spans 发给 Rust 侧统一落盘；无挂起数据或诊断关闭时为 no-op */
export async function reportWebSpans(reason: string): Promise<void> {
  const pending = takePendingSpans();
  if (pending.spans.length === 0) return;
  if (!(await isPerfEnabled())) return;
  try {
    const label = getCurrentWindow().label;
    await ipc.recordWebSpans(label, pending.spans);
    // 🔴 N10：游标按实际发送的批次数量推进——本函数 await 期间新增的事件
    //    不在本批快照内，不得被跳过（下一批继续上报）
    markReported(pending.spans.length);
    await ipc.dumpPerfSpans(reason);
  } catch {
    // 诊断上报失败完全静默，绝不影响业务；未确认的批次留在游标之后待下次上报
  }
}
