// 发布渠道：官方资源统一以 GitHub 下载地址登记，选择腾讯云 CNB 时只替换固定前缀，与原生端一致。
const GITHUB_DOWNLOAD_BASE = 'https://github.com/CrazyFigure/NoteBoard/releases/download/';
const CNB_DOWNLOAD_BASE = 'https://cnb.cool/crazy-figure/NoteBoard/-/releases/download/';

/** 设置值只认 cnb，缺失或未知值回到默认 GitHub。 */
export function normalizeChannel(value) {
  return String(value ?? '').trim().toLowerCase() === 'cnb' ? 'cnb' : 'github';
}

/** 把登记的 GitHub 附件地址换成所选渠道地址；非官方前缀原样返回，由调用方继续校验。 */
export function channelUrl(url, channel) {
  return normalizeChannel(channel) === 'cnb' && url.startsWith(GITHUB_DOWNLOAD_BASE)
    ? CNB_DOWNLOAD_BASE + url.slice(GITHUB_DOWNLOAD_BASE.length)
    : url;
}
