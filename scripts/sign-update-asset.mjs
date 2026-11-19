// 使用项目锁定的 Tauri CLI 签名，并在上传前检查发布公钥与签名密钥 ID 匹配。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [asset] = process.argv.slice(2);
const publicKey = process.env.NOTEBOARD_UPDATE_PUBLIC_KEY;
if (!asset || !publicKey || !process.env.TAURI_SIGNING_PRIVATE_KEY || !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  throw new Error('请提供更新包路径、更新公钥和带密码的 Tauri 签名私钥');
}

// 签名工具可能在输出中包含签名配置；失败只返回退出码，不将原始内容写入 CI 日志。
const result = spawnSync(process.execPath, ['scripts/run-tauri.mjs', 'signer', 'sign', asset], { stdio: 'ignore' });
if (result.error || result.status !== 0) throw new Error(`无法签名 ${basename(asset)}`);

const decodeLines = (encoded) => Buffer.from(encoded.trim(), 'base64').toString('utf8').split(/\r?\n/);
const [, encodedKey] = decodeLines(publicKey);
const [, encodedSignature, trustedComment] = decodeLines(readFileSync(`${asset}.sig`, 'utf8'));
const key = Buffer.from(encodedKey ?? '', 'base64');
const signature = Buffer.from(encodedSignature ?? '', 'base64');
// Minisign 的前 2 字节为算法，之后 8 字节为密钥 ID。
if (key.length !== 42 || signature.length !== 74 || !key.subarray(2, 10).equals(signature.subarray(2, 10))) {
  throw new Error('发布公钥与更新签名的密钥 ID 不一致');
}
if (!trustedComment?.split('\t').includes(`file:${basename(asset)}`)) {
  throw new Error('更新签名未绑定发布文件名');
}
