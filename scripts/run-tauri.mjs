// NoteBoard Tauri 命令入口：开发态自动叠加独立应用标识，发布构建保持正式标识不变。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCliPath = resolve(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const devConfigPath = resolve(repoRoot, 'src-tauri', 'tauri.dev.conf.json');
// 上次使用的开发端口记录在 Rust 构建目录中，cargo clean 时随构建缓存一并清除。
const devPortCachePath = resolve(repoRoot, 'src-tauri', 'target', '.noteboard-dev-port');
const cliArgs = process.argv.slice(2);

// 在回环地址上独占监听指定端口（0 表示由操作系统分配），成功后立即释放并返回实际端口。
function probeDevPort(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
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

// 优先沿用上次的端口：devUrl 写入 TAURI_CONFIG，端口一变就会触发 Rust 主 crate 重编译（约 15 秒）。
// 上次端口已被占用或没有记录时，才让操作系统重新分配，仍可避免与其它项目或本机软件争用固定端口。
async function allocateDevPort() {
  let cachedPort = 0;
  try {
    cachedPort = Number.parseInt(readFileSync(devPortCachePath, 'utf8').trim(), 10);
  } catch {
    // 首次运行或缓存已被清理，直接走动态分配。
  }
  if (Number.isInteger(cachedPort) && cachedPort > 0 && cachedPort <= 65535) {
    try {
      return await probeDevPort(cachedPort);
    } catch {
      // 上次端口已被其它进程占用，改为重新分配。
    }
  }

  const port = await probeDevPort(0);
  try {
    mkdirSync(dirname(devPortCachePath), { recursive: true });
    writeFileSync(devPortCachePath, String(port), 'utf8');
  } catch (error) {
    // 记录失败只影响下次能否复用端口，不阻断本次启动。
    console.warn(`[run-tauri] 无法记录开发端口：${error.message}`);
  }
  return port;
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
