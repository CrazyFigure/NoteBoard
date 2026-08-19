// NoteBoard 应用更新工具函数
// 包含后端更新错误码解析与友好中文提示转换

/**
 * 将后端更新检查返回的错误字符串转换为用户友好的中文文案
 * 后端错误遵循 "update_error:{code}:{params}" 规范
 */
export function translateUpdateCheckError(reason: string): string {
  const PREFIX = 'update_error:';
  if (!reason.startsWith(PREFIX)) {
    return `检查更新失败：${reason}`;
  }

  const rest = reason.slice(PREFIX.length);
  const sepIndex = rest.indexOf(':');
  const code = sepIndex >= 0 ? rest.slice(0, sepIndex) : rest;
  const params = sepIndex >= 0 ? rest.slice(sepIndex + 1) : '';

  switch (code) {
    case 'rate_limited': {
      // 解析配额重置时间戳（Unix 秒数）
      const resetTs = Number(params);
      const resetText =
        Number.isFinite(resetTs) && resetTs > 0
          ? `预计将在 ${new Date(resetTs * 1000).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })} 恢复，`
          : '';
      return `GitHub API 访问频次已达上限。${resetText}您也可以前往 Release 页面手动下载最新安装包。`;
    }
    case 'forbidden':
      return 'GitHub API 访问被拒绝（可能为代理 IP 被拦截）。建议检查代理网络或前往 Release 页面手动下载。';
    case 'network':
      return `网络连接失败，请检查网络设置或代理：${params}`;
    case 'http_status':
      return `GitHub 请求异常返回：${params}`;
    case 'parse':
      return `解析版本数据失败：${params}`;
    default:
      return `检查更新失败：${reason}`;
  }
}
