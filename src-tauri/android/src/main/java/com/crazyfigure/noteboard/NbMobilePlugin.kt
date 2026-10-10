// NoteBoard Android 原生桥接插件
// 由 CI 在 `tauri android init` 后复制到生成工程 app/src/main/java/com/crazyfigure/noteboard/ 下，
// Rust 侧通过 register_android_plugin("com.crazyfigure.noteboard", "NbMobilePlugin") 注册。
// 提供：
// 1. 所有文件访问权限查询与申请（浏览手机外部文件夹）；
// 2. 接收"用其他应用打开 / 分享到 NoteBoard"的文件（content:// 复制到应用收件箱后返回真实路径）；
// 3. 调用系统分享面板分享文件。
// 4. 更新检测失败时通过非 VPN 的 Wi-Fi / 蜂窝网络尝试直连 GitHub。

package com.crazyfigure.noteboard

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.View
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@InvokeArg
class InboxArgs {
  lateinit var inboxDir: String
}

@InvokeArg
class SystemBarArgs {
  lateinit var color: String
  var dark: Boolean = false
}

@InvokeArg
class ShareArgs {
  lateinit var path: String
  var mimeType: String? = null
}

/** 待处理的外部输入：文件 URI 或纯文本分享 */
private sealed class IncomingItem {
  data class Content(val uri: Uri) : IncomingItem()
  data class Text(val text: String, val subject: String?) : IncomingItem()
}

@TauriPlugin
class NbMobilePlugin(private val activity: Activity) : Plugin(activity) {
  private val pending = mutableListOf<IncomingItem>()

  override fun load(webView: WebView) {
    // 冷启动：读取启动 Intent
    collectIntent(activity.intent)
    applySystemInsets()
  }

  /**
   * targetSdk 36 强制全面屏（edge-to-edge），WebView 默认会绘制到状态栏、导航栏与输入法下方，
   * 而 WebView 的 safe-area env() 支持并不可靠。这里把系统栏、刘海与输入法区域作为内容视图内边距，
   * WebView 随之收缩：顶栏不被状态栏遮挡，键盘弹出时底部格式栏自动贴住键盘上沿。
   */
  private fun applySystemInsets() {
    // 视图操作必须在主线程执行
    activity.runOnUiThread {
      val root = activity.findViewById<View>(android.R.id.content) ?: return@runOnUiThread
      ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
        val area = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
        )
        view.setPadding(area.left, area.top, area.right, area.bottom)
        WindowInsetsCompat.CONSUMED
      }
      ViewCompat.requestApplyInsets(root)
    }
  }

  /** 系统栏区域背景与图标深浅跟随应用主题（避免深色主题下出现白色状态栏条） */
  @Command
  fun setSystemBarStyle(invoke: Invoke) {
    val args = invoke.parseArgs(SystemBarArgs::class.java)
    activity.runOnUiThread {
      try {
        val color = Color.parseColor(args.color)
        activity.window.decorView.setBackgroundColor(color)
        activity.findViewById<View>(android.R.id.content)?.setBackgroundColor(color)
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightStatusBars = !args.dark
        controller.isAppearanceLightNavigationBars = !args.dark
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("设置系统栏样式失败: ${e.message}")
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    // 热启动（singleTask）：系统把新 Intent 投递到已存在的 Activity
    collectIntent(intent)
  }

  /** 解析 VIEW / EDIT / SEND / SEND_MULTIPLE 等外部输入，消费后清空 action 防止重建时重复处理 */
  private fun collectIntent(intent: Intent?) {
    if (intent == null) return
    when (intent.action) {
      Intent.ACTION_VIEW, Intent.ACTION_EDIT -> intent.data?.let { pending.add(IncomingItem.Content(it)) }
      Intent.ACTION_SEND -> {
        val stream = streamExtra(intent)
        if (stream != null) {
          pending.add(IncomingItem.Content(stream))
        } else {
          val text = intent.getStringExtra(Intent.EXTRA_TEXT)
          if (!text.isNullOrEmpty()) {
            pending.add(IncomingItem.Text(text, intent.getStringExtra(Intent.EXTRA_SUBJECT)))
          }
        }
      }
      Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent).forEach { pending.add(IncomingItem.Content(it)) }
      else -> return
    }
    intent.action = Intent.ACTION_MAIN
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM)

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri> =
    (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()

  /** 是否已获得外部存储完整访问权限（Android 11+ 为"所有文件访问权限"） */
  private fun hasAccess(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

  @Command
  fun getStorageInfo(invoke: Invoke) {
    val result = JSObject()
    result.put("allFilesAccess", hasAccess())
    result.put("externalRoot", Environment.getExternalStorageDirectory().absolutePath)
    result.put("sdkInt", Build.VERSION.SDK_INT)
    invoke.resolve(result)
  }

  /** 更新直连在独立短时线程执行，结果交回 Rust；只绑定此请求，不改变整个应用的网络路由。 */
  @Command
  fun checkUpdateDirect(invoke: Invoke) {
    val context = activity.applicationContext
    Thread({
      try {
        invoke.resolve(NbUpdateNetwork.fetchLatestRelease(context))
      } catch (error: Exception) {
        invoke.reject("更新直连失败: ${error.message}")
      }
    }, "noteboard-update-direct").start()
  }

  @Command
  fun requestAllFilesAccess(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // 跳转到本应用的"所有文件访问权限"开关页；用户返回后前端在 resume 时重新查询
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}"))
        try {
          activity.startActivity(intent)
        } catch (_: Exception) {
          activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
      } else {
        ActivityCompat.requestPermissions(
          activity,
          arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE),
          4201,
        )
      }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("无法打开权限设置: ${e.message}")
    }
  }

  @Command
  fun takeIncomingFiles(invoke: Invoke) {
    val args = invoke.parseArgs(InboxArgs::class.java)
    val inbox = File(args.inboxDir)
    inbox.mkdirs()
    val files = JSArray()
    val failures = JSArray()
    val items = pending.toList()
    pending.clear()
    for (item in items) {
      try {
        val target = when (item) {
          is IncomingItem.Content -> copyContent(item.uri, inbox)
          is IncomingItem.Text -> writeSharedText(item, inbox)
        }
        files.put(target.absolutePath)
      } catch (e: Exception) {
        failures.put(e.message ?: "未知错误")
      }
    }
    val result = JSObject()
    result.put("files", files)
    result.put("failures", failures)
    invoke.resolve(result)
  }

  /** file:// 直接返回原路径；content:// 复制到收件箱（同名文件追加序号） */
  private fun copyContent(uri: Uri, inbox: File): File {
    if (uri.scheme == "file") {
      val path = uri.path ?: throw IllegalArgumentException("无效的文件路径")
      return File(path)
    }
    val name = sanitizeFileName(queryDisplayName(uri) ?: "导入文件")
    val target = uniqueFile(inbox, name)
    activity.contentResolver.openInputStream(uri).use { input ->
      if (input == null) throw IllegalStateException("无法读取：$name")
      target.outputStream().use { output -> input.copyTo(output) }
    }
    return target
  }

  /** 纯文本分享保存为 Markdown 笔记 */
  private fun writeSharedText(item: IncomingItem.Text, inbox: File): File {
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.getDefault()).format(Date())
    val title = item.subject?.takeIf { it.isNotBlank() }?.let { sanitizeFileName(it).take(40) } ?: "分享-$stamp"
    val target = uniqueFile(inbox, "$title.md")
    target.writeText(item.text)
    return target
  }

  private fun queryDisplayName(uri: Uri): String? {
    activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0) return cursor.getString(index)
      }
    }
    return uri.lastPathSegment?.substringAfterLast('/')
  }

  private fun sanitizeFileName(name: String): String =
    name.replace(Regex("[\\\\/:*?\"<>|\\n\\r\\t]"), "_").trim().ifEmpty { "导入文件" }

  private fun uniqueFile(dir: File, name: String): File {
    var candidate = File(dir, name)
    if (!candidate.exists()) return candidate
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var index = 1
    while (candidate.exists()) {
      candidate = File(dir, "$base ($index)$ext")
      index += 1
    }
    return candidate
  }

  /** 首页再次按返回键：与系统默认行为一致，退到后台而不销毁（保留未保存内容与编辑状态） */
  @Command
  fun moveToBackground(invoke: Invoke) {
    activity.moveTaskToBack(true)
    invoke.resolve()
  }

  @Command
  fun shareFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareArgs::class.java)
      val file = File(args.path)
      if (!file.exists()) {
        invoke.reject("文件不存在")
        return
      }
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.nbfileprovider", file)
      val extension = file.extension.lowercase(Locale.ROOT)
      val mime = args.mimeType
        ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
        ?: if (extension == "md" || extension == "markdown") "text/markdown" else "application/octet-stream"
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(Intent.createChooser(send, file.name))
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("分享失败: ${e.message}")
    }
  }
}
