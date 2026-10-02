// NoteBoard 安卓工程定制脚本
// 在 `tauri android init --ci` 生成 src-tauri/gen/android 后执行（CI 中每次重新生成，工程本身不入库）：
// 1. 复制原生桥接源码（NbMobilePlugin / NbFileProvider）与 FileProvider 路径资源；
// 2. AndroidManifest：存储权限、"用其他应用打开 / 分享到 NoteBoard" 的 Intent 过滤器、专用 FileProvider；
// 3. app/build.gradle.kts：存在 keystore.properties 时使用正式签名，否则 release 退化为 debug 签名（仍可安装）。
// 幂等：重复执行不会重复插入；找不到锚点时报错退出，避免模板升级后静默失效。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = join(repoRoot, 'src-tauri');
const androidDir = join(tauriDir, 'gen', 'android');
const appMainDir = join(androidDir, 'app', 'src', 'main');
const nativeSourceDir = join(tauriDir, 'android', 'src', 'main');
const PATCH_MARKER = 'NoteBoard patch';

/** 输出并终止 */
function fail(message) {
  console.error(`[patch-android] ${message}`);
  process.exit(1);
}

/** 在锚点后插入片段；已含标记时跳过 */
function insertAfter(content, anchor, snippet, label) {
  if (content.includes(snippet.trim().split('\n')[0].trim())) return content;
  const index = content.indexOf(anchor);
  if (index < 0) fail(`找不到锚点（${label}）：${anchor}`);
  return content.slice(0, index + anchor.length) + snippet + content.slice(index + anchor.length);
}

/** 在锚点前插入片段；已含标记时跳过 */
function insertBefore(content, anchor, snippet, label) {
  if (content.includes(snippet.trim().split('\n')[0].trim())) return content;
  const index = content.indexOf(anchor);
  if (index < 0) fail(`找不到锚点（${label}）：${anchor}`);
  return content.slice(0, index) + snippet + content.slice(index);
}

/** 递归复制目录 */
function copyTree(from, to) {
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyTree(source, target);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      console.log(`[patch-android] 复制 ${relative(repoRoot, target)}`);
    }
  }
}

if (!existsSync(appMainDir)) fail(`未找到生成的安卓工程：${relative(repoRoot, appMainDir)}（请先执行 tauri android init）`);

// ── 1. 原生源码与资源 ──
copyTree(nativeSourceDir, appMainDir);

// ── 2. AndroidManifest ──
const manifestPath = join(appMainDir, 'AndroidManifest.xml');
let manifest = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n');

if (!manifest.includes('xmlns:tools=')) {
  manifest = manifest.replace(
    'xmlns:android="http://schemas.android.com/apk/res/android"',
    'xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"',
  );
}

manifest = insertAfter(
  manifest,
  '<uses-permission android:name="android.permission.INTERNET" />',
  `
    <!-- ${PATCH_MARKER}: 外部存储访问（"手机存储"浏览外部文件夹；Android 11+ 需用户在系统设置中授予所有文件访问权限） -->
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" tools:ignore="ScopedStorage" />`,
  '权限',
);

if (!manifest.includes('android:requestLegacyExternalStorage')) {
  manifest = manifest.replace('<application', '<application\n        android:requestLegacyExternalStorage="true"');
}

manifest = insertAfter(
  manifest,
  '<category android:name="android.intent.category.LEANBACK_LAUNCHER" />\n            </intent-filter>',
  `
            <!-- ${PATCH_MARKER}: 用 NoteBoard 打开 / 编辑文本类文件 -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <action android:name="android.intent.action.EDIT" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" />
                <data android:scheme="file" />
                <data android:mimeType="text/*" />
                <data android:mimeType="application/json" />
                <data android:mimeType="application/xml" />
                <data android:mimeType="application/x-yaml" />
                <data android:mimeType="application/octet-stream" />
            </intent-filter>
            <!-- ${PATCH_MARKER}: 从其它应用分享文本或文件到 NoteBoard -->
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/*" />
                <data android:mimeType="application/json" />
                <data android:mimeType="application/octet-stream" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/*" />
            </intent-filter>`,
  'Intent 过滤器',
);

manifest = insertBefore(
  manifest,
  '    </application>',
  `        <!-- ${PATCH_MARKER}: 系统分享使用的专用 FileProvider（独立 authority，不与模板默认 FileProvider 冲突） -->
        <provider
          android:name=".NbFileProvider"
          android:authorities="\${applicationId}.nbfileprovider"
          android:exported="false"
          android:grantUriPermissions="true">
          <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/nb_file_paths" />
        </provider>
`,
  'FileProvider',
);
writeFileSync(manifestPath, manifest);
console.log('[patch-android] 已更新 AndroidManifest.xml');

// ── 3. 签名配置 ──
const gradlePath = join(androidDir, 'app', 'build.gradle.kts');
let gradle = readFileSync(gradlePath, 'utf8').replace(/\r\n/g, '\n');

gradle = insertBefore(
  gradle,
  'android {',
  `// ${PATCH_MARKER}: 正式签名（keystore.properties 由 CI 从 Secrets 生成；缺失时 release 使用 debug 签名）
val nbKeystorePropertiesFile = rootProject.file("keystore.properties")
val nbKeystoreProperties = Properties().apply {
    if (nbKeystorePropertiesFile.exists()) {
        nbKeystorePropertiesFile.inputStream().use { load(it) }
    }
}

`,
  'keystore 属性',
);

gradle = insertBefore(
  gradle,
  '    buildTypes {',
  `    // ${PATCH_MARKER}: 签名配置
    signingConfigs {
        if (nbKeystorePropertiesFile.exists()) {
            create("release") {
                storeFile = rootProject.file(nbKeystoreProperties.getProperty("storeFile"))
                storePassword = nbKeystoreProperties.getProperty("storePassword")
                keyAlias = nbKeystoreProperties.getProperty("keyAlias")
                keyPassword = nbKeystoreProperties.getProperty("keyPassword")
            }
        }
    }
`,
  'signingConfigs',
);

gradle = insertAfter(
  gradle,
  '        getByName("release") {',
  `
            // ${PATCH_MARKER}: 使用正式签名，未配置时退化为 debug 签名
            signingConfig = if (nbKeystorePropertiesFile.exists()) signingConfigs.getByName("release") else signingConfigs.getByName("debug")`,
  'release signingConfig',
);
writeFileSync(gradlePath, gradle);
console.log('[patch-android] 已更新 app/build.gradle.kts');

// ── 4. 混淆保留规则 ──
// release 开启 R8 压缩；原生桥接插件按类名反射加载、参数类经反射解析，必须保留
const proguardPath = join(androidDir, 'app', 'proguard-noteboard.pro');
writeFileSync(
  proguardPath,
  [
    `# ${PATCH_MARKER}: 原生桥接插件与 FileProvider 由类名反射加载`,
    '-keep class com.crazyfigure.noteboard.NbMobilePlugin { *; }',
    '-keep class com.crazyfigure.noteboard.NbFileProvider { *; }',
    '-keep class com.crazyfigure.noteboard.InboxArgs { *; }',
    '-keep class com.crazyfigure.noteboard.ShareArgs { *; }',
    '-keep class com.crazyfigure.noteboard.SystemBarArgs { *; }',
    '',
  ].join('\n'),
);
console.log('[patch-android] 已写入 proguard-noteboard.pro');
