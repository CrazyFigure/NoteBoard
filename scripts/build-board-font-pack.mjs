// NoteBoard 画板手写字体包（小赖）制包脚本。
//
// 小赖中文手写体约 13 MB（209 个按 unicode-range 切分的 WOFF2 分片），不再随桌面/安卓安装包分发，
// 改为在「设置 → 插件 → 字体」按需下载。本脚本从已安装的 @excalidraw/excalidraw 读取分片与 unicode-range：
//   1. 生成清单 src-tauri/src/board_font_pack.json（Rust 内嵌为信任根：逐文件大小 + SHA-256 + unicode-range）；
//   2. 传 --zip <输出目录> 时额外生成发布附件 NoteBoard-fontpack-board-v<版本>.zip（仅存储，不压缩，字节可复现）。
//
// 用法：
//   node scripts/build-board-font-pack.mjs              # 只刷新清单
//   node scripts/build-board-font-pack.mjs --check      # 校验清单与当前 Excalidraw 一致（不写文件）
//   node scripts/build-board-font-pack.mjs --zip out    # 刷新清单并生成 zip
//
// 🔴 升级 Excalidraw 后分片哈希可能变化：--check 失败时须提升 BOARD_FONT_PACK_VERSION 并重新发布 Release。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

export const BOARD_FONT_PACK_VERSION = '1.0.0';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = path.join(rootDir, 'src-tauri', 'src', 'board_font_pack.json');
const require = createRequire(import.meta.url);

/** 读取 Excalidraw 生产包中的小赖分片清单（文件名 → unicode-range），顺序与 Excalidraw 注册顺序一致 */
export function readExcalidrawXiaolai() {
  // 入口可能按 development 条件解析到 dist/dev（写法不同），固定从包根目录取生产产物
  const prodDir = path.join(require.resolve('@excalidraw/excalidraw').split(/[\\/]dist[\\/]/)[0], 'dist', 'prod');
  const packageJson = JSON.parse(fs.readFileSync(path.join(prodDir, '..', '..', 'package.json'), 'utf8'));
  const chunk = fs.readdirSync(prodDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(prodDir, name), 'utf8'))
    .find((code) => code.includes('./fonts/Xiaolai/'));
  if (!chunk) throw new Error('Excalidraw 产物中未找到小赖字体声明');
  // 压缩产物形如 var Ic="./fonts/Xiaolai/x.woff2"; ... {uri:Ic,descriptors:{unicodeRange:"U+..."}}
  const uriByVar = new Map([...chunk.matchAll(/var ([\w$]+)="\.\/fonts\/Xiaolai\/([^"]+\.woff2)"/g)].map((m) => [m[1], m[2]]));
  const files = [];
  for (const match of chunk.matchAll(/\{uri:([\w$]+),descriptors:\{unicodeRange:"([^"]+)"/g)) {
    const name = uriByVar.get(match[1]);
    if (name) files.push({ name, unicodeRange: match[2] });
  }
  if (!files.length || files.length !== uriByVar.size) {
    throw new Error(`小赖分片解析不完整：声明 ${uriByVar.size} 个，取得 unicode-range ${files.length} 个`);
  }
  return { excalidrawVersion: packageJson.version, fontsDir: path.join(prodDir, 'fonts', 'Xiaolai'), files };
}

/** 生成清单对象（大小与哈希来自实际字体文件） */
export function buildManifest() {
  const { excalidrawVersion, fontsDir, files } = readExcalidrawXiaolai();
  return {
    id: 'board',
    version: BOARD_FONT_PACK_VERSION,
    excalidrawVersion,
    family: 'Xiaolai',
    files: files.map(({ name, unicodeRange }) => {
      const bytes = fs.readFileSync(path.join(fontsDir, name));
      return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), unicodeRange };
    }),
  };
}

/** 极简 ZIP 写入器：只用 Stored 方式，固定时间戳，保证同一输入产出逐字节相同的附件 */
function writeStoredZip(outputPath, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // Stored
    local.writeUInt16LE(0, 10); // 时间 00:00
    local.writeUInt16LE(0x21, 12); // 日期 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outputPath, Buffer.concat([...parts, ...central, end]));
}

const serialize = (manifest) => `${JSON.stringify(manifest, null, 1)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const manifest = buildManifest();
  if (args.includes('--check')) {
    const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
    if (current !== serialize(manifest)) {
      console.error('画板字体清单与当前 Excalidraw 不一致：请提升 BOARD_FONT_PACK_VERSION 后重新运行本脚本并发布 Release');
      process.exit(1);
    }
    console.log(`画板字体清单一致（${manifest.files.length} 个分片，Excalidraw ${manifest.excalidrawVersion}）`);
    process.exit(0);
  }
  fs.writeFileSync(manifestPath, serialize(manifest));
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  console.log(`已写入 ${path.relative(rootDir, manifestPath)}：${manifest.files.length} 个分片，共 ${total} 字节`);

  const zipIndex = args.indexOf('--zip');
  if (zipIndex >= 0) {
    const outDir = path.resolve(args[zipIndex + 1] ?? 'dist-font-pack');
    fs.mkdirSync(outDir, { recursive: true });
    const { fontsDir } = readExcalidrawXiaolai();
    const licenseDir = path.join(rootDir, 'assets', 'font-pack');
    const entries = [
      ...manifest.files.map((file) => ({ name: `fonts/Xiaolai/${file.name}`, data: fs.readFileSync(path.join(fontsDir, file.name)) })),
      { name: 'licenses/OFL-1.1.txt', data: fs.readFileSync(path.join(licenseDir, 'OFL-1.1.txt')) },
      { name: 'licenses/THIRD_PARTY_NOTICES.md', data: fs.readFileSync(path.join(licenseDir, 'BOARD_THIRD_PARTY_NOTICES.md')) },
      // 发布清单不含 unicode-range，便于审计；客户端以内置清单为准
      { name: 'font-pack.json', data: Buffer.from(JSON.stringify({ ...manifest, files: manifest.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }, null, 1)) },
    ];
    const zipPath = path.join(outDir, `NoteBoard-fontpack-board-v${BOARD_FONT_PACK_VERSION}.zip`);
    writeStoredZip(zipPath, entries);
    console.log(`已生成 ${zipPath}（${fs.statSync(zipPath).size} 字节）`);
  }
}
