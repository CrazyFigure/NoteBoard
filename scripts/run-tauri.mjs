// NoteBoard Tauri 命令入口：开发态自动叠加独立应用标识，发布构建保持正式标识不变。

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCliPath = resolve(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const devConfigPath = resolve(repoRoot, 'src-tauri', 'tauri.dev.conf.json');
const cliArgs = process.argv.slice(2);

// 让操作系统分配当前可用的回环端口，避免与其它项目或本机软件争用固定开发端口。
function allocateDevPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('系统未返回可用的 TCP 端口'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

// 只给 dev 子命令注入开发身份与动态地址；build、info、icon 等命令继续使用正式配置。
const devCommandIndex = cliArgs.findIndex((argument) => argument === 'dev');
let childEnvironment = process.env;
if (devCommandIndex >= 0) {
  const devPort = await allocateDevPort();
  const runtimeConfig = JSON.stringify({
    build: { devUrl: `http://127.0.0.1:${devPort}` },
  });
  const injectedConfigs = cliArgs.includes(devConfigPath)
    ? ['--config', runtimeConfig]
    : ['--config', devConfigPath, '--config', runtimeConfig];

  // 放在 dev 后、用户参数前，使用户显式追加的 --config 仍可按 Tauri 合并规则覆盖默认开发配置。
  cliArgs.splice(devCommandIndex + 1, 0, ...injectedConfigs);
  childEnvironment = {
    ...process.env,
    NOTEBOARD_DEV_PORT: String(devPort),
  };
  console.log(`[run-tauri] NoteBoard 开发服务使用动态端口 ${devPort}`);
}

// 直接调用项目锁定版本的 CLI，避免依赖全局 tauri 或 Windows shell 的参数转义行为。
const result = spawnSync(process.execPath, [tauriCliPath, ...cliArgs], {
  cwd: repoRoot,
  env: childEnvironment,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[run-tauri] 无法启动 Tauri CLI：${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
