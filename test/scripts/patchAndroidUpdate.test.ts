// Android 更新直连打包回归：在隔离的生成工程中执行真实定制脚本，验证权限、源码复制和幂等性。
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('Android 定制脚本应携带更新直连源码并且只声明一次网络查询权限', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'noteboard-android-update-'));
  // 最小生成工程保留 Tauri 模板锚点，测试不触发 Android 构建也不修改仓库生成目录。
  const mainDir = join(fixtureRoot, 'src-tauri/gen/android/app/src/main');
  const appDir = join(fixtureRoot, 'src-tauri/gen/android/app');
  const scriptDir = join(fixtureRoot, 'scripts');
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(scriptDir);
  cpSync(resolve('scripts/patch-android.mjs'), join(scriptDir, 'patch-android.mjs'));
  cpSync(resolve('src-tauri/android'), join(fixtureRoot, 'src-tauri/android'), { recursive: true });
  writeFileSync(join(mainDir, 'AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application>
        <activity>
            <intent-filter>
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`, 'utf8');
  writeFileSync(join(appDir, 'build.gradle.kts'), `android {
    buildTypes {
        getByName("release") {
        }
    }
}`, 'utf8');
  try {
    const script = join(scriptDir, 'patch-android.mjs');
    execFileSync(process.execPath, [script], { cwd: fixtureRoot, stdio: 'pipe' });
    const manifestPath = join(mainDir, 'AndroidManifest.xml');
    const firstManifest = readFileSync(manifestPath, 'utf8');
    execFileSync(process.execPath, [script], { cwd: fixtureRoot, stdio: 'pipe' });
    expect(readFileSync(manifestPath, 'utf8')).toBe(firstManifest);
    expect(firstManifest.match(/android.permission.ACCESS_NETWORK_STATE/g)).toHaveLength(1);
    const sourceDir = join(mainDir, 'java/com/crazyfigure/noteboard');
    expect(readFileSync(join(sourceDir, 'NbUpdateNetwork.kt'), 'utf8'))
      .toBe(readFileSync(resolve('src-tauri/android/src/main/java/com/crazyfigure/noteboard/NbUpdateNetwork.kt'), 'utf8'));
  } finally {
    // 只清理 mkdtemp 创建的独立测试目录，不接触用户的 Android 工程或其他临时文件。
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
