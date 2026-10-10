// NoteBoard Android 更新直连：绑定已有非 VPN 网络，同时忽略该网络的 HTTP 代理。
// 是否允许绕过 VPN 由系统与 VPN 服务决定；禁止修改全进程路由或自行启动蜂窝数据。
package com.crazyfigure.noteboard

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import app.tauri.plugin.JSObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

internal object NbUpdateNetwork {
  // 固定为本仓库 Release API，不接受前端传入任意直连地址。
  private const val RELEASE_URL = "https://api.github.com/repos/CrazyFigure/NoteBoard/releases/latest"
  // 与 Rust 侧更新检查保持 8 秒连接、40 秒总体时限，并限制元数据为 2 MiB。
  private const val CONNECT_TIMEOUT_MS = 8_000
  private const val TOTAL_TIMEOUT_MS = 40_000L
  private const val MAX_BODY_BYTES = 2 * 1024 * 1024

  /** 查找当前可用的非 VPN 网络，优先 Wi-Fi；网络不可达或限流时在总体时限内尝试其他现有网络。 */
  @Suppress("DEPRECATION")
  fun fetchLatestRelease(context: Context): JSObject {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val networks = manager.allNetworks.mapNotNull { network ->
      val capabilities = manager.getNetworkCapabilities(network) ?: return@mapNotNull null
      // 只选择具备公网能力的物理网络，排除 VPN、受限网络及无法上网的局域连接。
      if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
          !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED) ||
          !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) ||
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@mapNotNull null
      val priority = when {
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> 0
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> 1
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> 2
        else -> return@mapNotNull null
      }
      network to priority
    }.sortedBy { it.second }.map { it.first }
    if (networks.isEmpty()) throw IllegalStateException("没有可用的 Wi-Fi 或蜂窝直连网络")

    val deadline = SystemClock.elapsedRealtime() + TOTAL_TIMEOUT_MS
    var lastResponse: JSObject? = null
    var lastError: Exception? = null
    for (network in networks) {
      if (SystemClock.elapsedRealtime() >= deadline) break
      try {
        val response = fetchOnNetwork(network, deadline)
        val status = response.getInt("status")
        // 成功立即返回；限流响应保留准确错误信息，再尝试另一个已连接的物理网络。
        if (status in 200..299) return response
        lastResponse = response
      } catch (error: Exception) {
        // VPN 禁止绕行、网络切换或直连不可达时继续尝试其他网络，最终由 Rust 保留原错误。
        lastError = error
      }
    }
    return lastResponse ?: throw IllegalStateException(
      "普通网络无法直连，VPN 可能禁止绕行或 GitHub 直连不可达：${lastError?.message ?: "请求超时"}",
      lastError,
    )
  }

  /** 在单个 Network 上执行 HTTPS，DNS 和连接均使用该网络，读取有大小与时间边界的 UTF-8 响应。 */
  private fun fetchOnNetwork(network: Network, deadline: Long): JSObject {
    val connection = network.openConnection(URL(RELEASE_URL), Proxy.NO_PROXY) as HttpURLConnection
    try {
      val remaining = (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1).toInt()
      connection.connectTimeout = minOf(CONNECT_TIMEOUT_MS, remaining)
      connection.readTimeout = remaining
      connection.instanceFollowRedirects = false
      connection.useCaches = false
      connection.setRequestProperty("User-Agent", "NoteBoard")
      connection.setRequestProperty("Accept", "application/vnd.github+json")
      val status = connection.responseCode
      val output = ByteArrayOutputStream()
      // 错误响应也需要读取正文，以识别 GitHub 次级限流；所有流和连接均在完成或失败后关闭。
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      stream?.use { input ->
        val buffer = ByteArray(8 * 1024)
        while (true) {
          val remainingRead = deadline - SystemClock.elapsedRealtime()
          if (remainingRead <= 0) throw IllegalStateException("更新直连请求超时")
          connection.readTimeout = remainingRead.toInt()
          val count = input.read(buffer)
          if (count < 0) break
          if (output.size() + count > MAX_BODY_BYTES) throw IllegalStateException("更新元数据体积超出限制")
          output.write(buffer, 0, count)
        }
      }
      return JSObject().apply {
        put("status", status)
        put("rateLimitRemaining", connection.getHeaderField("x-ratelimit-remaining"))
        put("rateLimitReset", connection.getHeaderField("x-ratelimit-reset"))
        put("body", output.toString("UTF-8"))
      }
    } finally {
      connection.disconnect()
    }
  }
}
