// 回归：发版 CSP 的 connect-src 未放行 Tauri 自定义 IPC 协议，invoke 的 fetch 被拦截后整个会话退回 postMessage，
// Uint8Array 正文被序列化成 JSON 数组，save_binary_file_raw 报「文件数据格式无效」（导出 Mermaid / PlantUML 图片失败）。
// 开发态页面来自 devUrl，不注入 CSP，只有打包后才暴露；Tauri 不会自动把 IPC 地址补进 connect-src。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'));

/** 取出指定指令的来源列表 */
function directiveSources(csp: string, name: string): string[] {
  const directive = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name);
  return directive ? directive.slice(1) : [];
}

it('connect-src 放行 IPC 自定义协议（macOS / Linux 为 ipc:，Windows / 安卓为 http://ipc.localhost）', () => {
  const sources = directiveSources(config.app.security.csp, 'connect-src');
  expect(sources).toContain('ipc:');
  expect(sources).toContain('http://ipc.localhost');
});
