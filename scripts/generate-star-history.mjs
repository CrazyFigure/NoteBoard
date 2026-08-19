import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录是脚本定位输出文件的唯一基准，保证本地和 GitHub Actions 路径一致。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// README 直接引用仓库内静态 SVG；环境变量仅用于隔离测试输出，不改变默认产物位置。
const outputPath = resolve(process.env.STAR_HISTORY_OUTPUT_PATH || join(repoRoot, 'assets', 'star-history.svg'));
// 历史快照与 SVG 一起纳入版本控制，GitHub 无法提供的取消 Star 历史由定时观测补齐。
const historyPath = resolve(process.env.STAR_HISTORY_DATA_PATH || join(repoRoot, 'assets', 'star-history.json'));
// 自定义 PAT 用于扩大接口配额或兼容特殊权限；令牌过期时不能阻断 Actions 自带令牌兜底。
const starHistoryToken = process.env.STAR_HISTORY_TOKEN || process.env.GH_TOKEN || '';
// Actions 自带令牌单独保留，避免 PAT_STAR_HISTORY 过期或撤销后覆盖可用凭据。
const githubToken = process.env.GITHUB_TOKEN || '';
// 鉴权候选按优先级去重，并保留无令牌分支以支持公开元数据和本地预览。
const githubTokens = [...new Set([starHistoryToken, githubToken].filter(Boolean)), ''];
// GitHub REST API 统一入口，方便后续切换企业版或代理时只改一处。
const githubApiBaseUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
// 图表尺寸固定，README 中渲染时不会因为内容变化产生布局跳动。
const chartWidth = 860;
const chartHeight = 440;
// 内边距为坐标轴和标题预留空间，避免标签贴边或遮挡折线。
const chartMargin = {
  top: 74,
  right: 48,
  bottom: 72,
  left: 68,
};

// GitHub API 异常需要携带状态码和响应正文，方便 Actions 日志直接定位鉴权或限流原因。
class GithubApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
    this.body = body;
  }
}

// SVG 文本节点和属性值统一做 XML 转义，避免仓库名等外部数据破坏 SVG 结构。
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// 数字展示使用英文千分位，和 GitHub star/badge 的常见展示格式保持一致。
function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

// 坐标轴日期固定为 UTC 年月日，避免 Actions 运行地区不同导致输出不稳定。
function formatDateLabel(value) {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

// SVG 坐标保留两位小数，减少文件噪音，同时避免路径精度不足造成抖动。
function formatCoord(value) {
  return Number(value.toFixed(2));
}

// GitHub 请求头集中生成；仓库元数据接口只负责读取当前总 Star 数。
function buildGithubHeaders(accept, token) {
  const headers = {
    Accept: accept,
    'User-Agent': 'CrazyFigure-NoteBoard-Star-History',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 空令牌仍可访问公开仓库，Actions 中优先使用令牌以获得稳定的请求配额。
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

// 远程 JSON 读取统一校验 HTTP 状态；失败时保留原始正文给上层错误处理。
async function fetchJson(url, headers) {
  // 所有 GitHub 远程调用集中在这里处理，便于统一输出状态码和错误正文。
  const response = await fetch(url, { headers });
  const body = await response.text();

  if (!response.ok) {
    throw new GithubApiError(`GitHub API request failed with ${response.status}: ${url}`, response.status, body);
  }

  return JSON.parse(body);
}

// 只有鉴权或权限错误才尝试下一凭据，网络故障和响应格式异常仍立即暴露真实根因。
function isAuthenticationError(error) {
  return error instanceof GithubApiError && (error.status === 401 || error.status === 403);
}

// 远程调用依次尝试自定义 PAT、Actions 令牌和公开访问，避免单个过期令牌导致定时任务中断。
async function withGithubAuthentication(operation) {
  let lastAuthenticationError;

  for (const [index, token] of githubTokens.entries()) {
    try {
      return await operation(token);
    } catch (error) {
      // 非鉴权错误通常无法通过切换令牌恢复，继续重试只会掩盖接口或网络问题。
      if (!isAuthenticationError(error)) {
        throw error;
      }

      lastAuthenticationError = error;

      // 后续仍有候选凭据时记录安全摘要，日志中绝不输出令牌内容。
      if (index < githubTokens.length - 1) {
        console.warn(`GitHub credential rejected with HTTP ${error.status}; trying the next credential.`);
      }
    }
  }

  throw lastAuthenticationError || new Error('No GitHub authentication candidate was available.');
}

// 仓库元数据只读取观测时刻的总 Star 数，不再把当前 stargazer 列表误当作历史事件。
async function fetchRepositoryMetadata(repository, token) {
  const metadataUrl = `${githubApiBaseUrl}/repos/${repository}`;
  return fetchJson(metadataUrl, buildGithubHeaders('application/vnd.github+json', token));
}

// Star 数必须是非负整数，拒绝异常接口值，避免错误快照永久进入版本历史。
function normalizeStarCount(value, source) {
  // API 返回数字，测试注入使用数字字符串；空值、布尔值等隐式转成 0 会污染历史，必须拒绝。
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`Invalid star count from ${source}: ${value}`);
  }

  const count = Number(value);

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid star count from ${source}: ${value}`);
  }

  return count;
}

// 快照文件是走势图的唯一历史依据；格式、仓库名或任一记录异常时立即停止生成。
function readHistory() {
  const history = JSON.parse(readFileSync(historyPath, 'utf8'));

  if (
    history?.version !== 1 ||
    typeof history.repository !== 'string' ||
    !/^[^/]+\/[^/]+$/.test(history.repository) ||
    !Array.isArray(history.snapshots)
  ) {
    throw new Error(`Invalid star history file: ${historyPath}`);
  }

  const snapshots = history.snapshots.map((snapshot, index) => {
    const observedAt = snapshot?.observedAt;
    const stars = normalizeStarCount(snapshot?.stars, `history snapshot ${index + 1}`);

    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
      throw new Error(`Invalid observation time in history snapshot ${index + 1}: ${observedAt}`);
    }

    return { observedAt, stars };
  });

  // 至少保留一个已观测点，禁止退化为根据仓库创建时间猜测的虚假曲线。
  if (snapshots.length === 0) {
    throw new Error(`Star history has no observed snapshots: ${historyPath}`);
  }

  // 同一时刻只能有一个仓库总数，重复时间戳通常意味着手工合并历史时发生了冲突。
  if (new Set(snapshots.map((snapshot) => snapshot.observedAt)).size !== snapshots.length) {
    throw new Error(`Star history contains duplicate observation times: ${historyPath}`);
  }

  snapshots.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  return { version: 1, repository: history.repository, snapshots };
}

// 测试可显式注入 Star 数；正式 Actions 始终从仓库元数据读取当前总数。
async function readCurrentStarCount(repository) {
  if (process.env.STAR_HISTORY_CURRENT_COUNT !== undefined) {
    return normalizeStarCount(process.env.STAR_HISTORY_CURRENT_COUNT, 'STAR_HISTORY_CURRENT_COUNT');
  }

  const metadata = await withGithubAuthentication((token) => fetchRepositoryMetadata(repository, token));
  return normalizeStarCount(metadata?.stargazers_count, 'GitHub repository metadata');
}

// 每次运行追加一个真实观测；相同时间戳用于幂等重跑时覆盖，避免产生重复点。
function recordSnapshot(history, observedAt, stars) {
  const observedTime = Date.parse(observedAt);

  if (!Number.isFinite(observedTime)) {
    throw new Error(`Invalid STAR_HISTORY_RECORDED_AT: ${observedAt}`);
  }

  const latestSnapshot = history.snapshots.at(-1);

  // Action 只能追加当前或未来观测，拒绝异常系统时间倒序改写既有曲线。
  if (latestSnapshot && observedTime < Date.parse(latestSnapshot.observedAt)) {
    throw new Error(`Observation time ${observedAt} is earlier than the latest snapshot ${latestSnapshot.observedAt}.`);
  }

  const snapshots = history.snapshots.filter((snapshot) => snapshot.observedAt !== observedAt);
  snapshots.push({ observedAt, stars });
  snapshots.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));

  return { ...history, snapshots };
}

// 图表序列直接映射观测快照，因此既能上涨也能下降，并明确不猜测两次观测之间的事件时间。
function buildObservedSeries(history) {
  const points = history.snapshots.map((snapshot) => ({
    date: snapshot.observedAt,
    count: snapshot.stars,
  }));
  const totalStars = points.at(-1).count;
  const maxStars = Math.max(...points.map((point) => point.count));

  return {
    repository: history.repository,
    points,
    totalStars,
    maxStars,
    note: 'Generated from observed repository star-count snapshots; changes between observations are unavailable',
  };
}

// Y 轴最大值向上取整到易读刻度，避免最高点贴近顶部边界。
function niceCeil(value) {
  if (value <= 1) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const niceFraction = [1, 2, 3, 5, 10].find((candidate) => fraction <= candidate) || 10;

  return niceFraction * base;
}

// Y 轴刻度按 4 段左右生成，并确保最后一个刻度覆盖最高 star 数。
function buildYTicks(maxCount) {
  const yMax = niceCeil(Math.max(1, maxCount));
  const step = niceCeil(yMax / 4);
  const ticks = [];

  for (let value = 0; value <= yMax; value += step) {
    ticks.push(value);
  }

  // 最大刻度必须覆盖最高 star 数，避免折线顶到图表边界。
  if (ticks.at(-1) < yMax) {
    ticks.push(yMax);
  }

  return {
    yMax,
    ticks,
  };
}

// X 轴按时间范围均分，单点数据只返回一个刻度，避免除零。
function buildXTicks(minTime, maxTime, tickCount) {
  if (minTime === maxTime) {
    return [minTime];
  }

  return Array.from({ length: tickCount }, (_, index) => {
    const ratio = index / (tickCount - 1);
    return minTime + (maxTime - minTime) * ratio;
  });
}

// 快照使用阶梯线连接：变化发生在相邻观测之间，图中仅把新值落在实际观测时刻。
function buildPath(points, xScale, yScale) {
  if (points.length === 0) {
    return '';
  }

  const [firstPoint, ...restPoints] = points;
  let path = `M ${formatCoord(xScale(firstPoint.time))} ${formatCoord(yScale(firstPoint.count))}`;

  for (const point of restPoints) {
    const x = formatCoord(xScale(point.time));
    const y = formatCoord(yScale(point.count));

    // 垂直段允许向上或向下，能够如实展示净增与净减的观测结果。
    path += ` H ${x} V ${y}`;
  }

  return path;
}

// SVG 渲染流程负责归一化日期、构造坐标轴、折线路径和深浅色自适应样式。
function renderSvg(series) {
  const plotWidth = chartWidth - chartMargin.left - chartMargin.right;
  const plotHeight = chartHeight - chartMargin.top - chartMargin.bottom;
  const normalizedPoints = series.points
    .map((point) => ({
      ...point,
      time: Date.parse(point.date),
    }))
    .filter((point) => Number.isFinite(point.time));

  // 没有有效日期时无法构造坐标轴，必须失败以免生成空白图片。
  if (normalizedPoints.length === 0) {
    throw new Error('No valid star history points to render.');
  }

  const minTime = Math.min(...normalizedPoints.map((point) => point.time));
  const maxTime = Math.max(...normalizedPoints.map((point) => point.time));
  const timeSpan = Math.max(1, maxTime - minTime);
  // Y 轴按历史峰值计算，当前值下降后也不会把过去的高点裁出绘图区。
  const { yMax, ticks: yTicks } = buildYTicks(series.maxStars);
  const xTicks = buildXTicks(minTime, maxTime, 5);
  const xScale = (time) => chartMargin.left + ((time - minTime) / timeSpan) * plotWidth;
  const yScale = (count) => chartMargin.top + plotHeight - (count / yMax) * plotHeight;
  const linePath = buildPath(normalizedPoints, xScale, yScale);
  const firstPoint = normalizedPoints[0];
  const lastPoint = normalizedPoints.at(-1);
  const baselineY = yScale(0);
  const areaPath = `${linePath} L ${formatCoord(xScale(lastPoint.time))} ${formatCoord(baselineY)} L ${formatCoord(xScale(firstPoint.time))} ${formatCoord(baselineY)} Z`;
  const latestLabel = `${formatNumber(series.totalStars)} stars`;
  const statusLabel = `Observed snapshots: ${formatDateLabel(firstPoint.time)} – ${formatDateLabel(lastPoint.time)}`;
  const yGrid = yTicks
    .map((tick) => {
      const y = formatCoord(yScale(tick));
      return `<line class="grid" x1="${chartMargin.left}" y1="${y}" x2="${chartWidth - chartMargin.right}" y2="${y}" />`;
    })
    .join('\n    ');
  const yLabels = yTicks
    .map((tick) => {
      const y = formatCoord(yScale(tick) + 4);
      return `<text class="axis-label" x="${chartMargin.left - 14}" y="${y}" text-anchor="end">${formatNumber(tick)}</text>`;
    })
    .join('\n    ');
  const xLabels = xTicks
    .map((tick) => {
      const x = formatCoord(xScale(tick));
      return `<text class="axis-label" x="${x}" y="${chartHeight - 30}" text-anchor="middle">${formatDateLabel(tick)}</text>`;
    })
    .join('\n    ');
  const latestX = formatCoord(xScale(lastPoint.time));
  const latestY = formatCoord(yScale(lastPoint.count));
  const repositoryLabel = escapeXml(series.repository);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-labelledby="title desc">
  <title id="title">Star History for ${repositoryLabel}</title>
  <desc id="desc">${escapeXml(series.note)}.</desc>
  <style>
    .chart-bg { fill: #ffffff; }
    .title { fill: #111827; font: 700 26px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #4b5563; font: 500 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .axis-label { fill: #64748b; font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .grid { stroke: #e5e7eb; stroke-width: 1; }
    .axis { stroke: #94a3b8; stroke-width: 1.2; }
    .area { fill: url(#starGradient); opacity: 0.28; }
    .line { fill: none; stroke: #2563eb; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round; }
    .dot { fill: #2563eb; stroke: #ffffff; stroke-width: 3; }
    .badge { fill: #eff6ff; stroke: #bfdbfe; }
    .badge-text { fill: #1d4ed8; font: 700 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .status { fill: #6b7280; font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @media (prefers-color-scheme: dark) {
      .chart-bg { fill: #0d1117; }
      .title { fill: #f8fafc; }
      .subtitle { fill: #cbd5e1; }
      .axis-label { fill: #94a3b8; }
      .grid { stroke: #1f2937; }
      .axis { stroke: #475569; }
      .dot { stroke: #0d1117; }
      .badge { fill: #172554; stroke: #1d4ed8; }
      .badge-text { fill: #bfdbfe; }
      .status { fill: #94a3b8; }
    }
  </style>
  <defs>
    <linearGradient id="starGradient" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#2563eb" stop-opacity="0.72" />
      <stop offset="100%" stop-color="#2563eb" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect class="chart-bg" width="${chartWidth}" height="${chartHeight}" rx="18" />
  <text class="title" x="${chartMargin.left}" y="42">Star History</text>
  <text class="subtitle" x="${chartMargin.left}" y="64">${repositoryLabel}</text>
  <g>
    ${yGrid}
    <line class="axis" x1="${chartMargin.left}" y1="${chartMargin.top}" x2="${chartMargin.left}" y2="${baselineY}" />
    <line class="axis" x1="${chartMargin.left}" y1="${baselineY}" x2="${chartWidth - chartMargin.right}" y2="${baselineY}" />
    ${yLabels}
    ${xLabels}
  </g>
  <path class="area" d="${areaPath}" />
  <path class="line" d="${linePath}" />
  <circle class="dot" cx="${latestX}" cy="${latestY}" r="6" />
  <rect class="badge" x="${chartWidth - 178}" y="28" width="130" height="34" rx="17" />
  <text class="badge-text" x="${chartWidth - 113}" y="50" text-anchor="middle">${escapeXml(latestLabel)}</text>
  <text class="status" x="${chartWidth - chartMargin.right}" y="${chartHeight - 12}" text-anchor="end">${escapeXml(statusLabel)}</text>
</svg>
`;
}

// 主流程读取已提交快照、记录本次仓库总数，再同时更新 JSON 数据和 SVG 展示文件。
async function main() {
  const history = readHistory();
  const repository = process.env.STAR_HISTORY_REPOSITORY || history.repository;

  // 环境变量切换仓库时必须同步迁移历史文件，防止把两个仓库的快照混在一张图里。
  if (repository !== history.repository) {
    throw new Error(`Star history belongs to ${history.repository}, but ${repository} was requested.`);
  }

  const currentStars = await readCurrentStarCount(repository);
  const observedAt = process.env.STAR_HISTORY_RECORDED_AT || new Date().toISOString();
  const updatedHistory = recordSnapshot(history, observedAt, currentStars);
  const series = buildObservedSeries(updatedHistory);
  const serializedHistory = `${JSON.stringify(updatedHistory, null, 2)}\n`;
  const svg = renderSvg(series);

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, serializedHistory, 'utf8');
  writeFileSync(outputPath, svg, 'utf8');
  console.log(`Recorded ${currentStars} stars at ${observedAt}`);
  console.log(`Updated ${historyPath} and ${outputPath}`);
}

main().catch((error) => {
  // 顶层异常输出保留状态码和正文，方便在 Actions 日志中定位 GitHub 鉴权或限流问题。
  console.error(error);
  if (error instanceof GithubApiError && error.body) {
    console.error(error.body);
  }
  process.exitCode = 1;
});
