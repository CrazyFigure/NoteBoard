// NoteBoard 专用 FileProvider：用于系统分享面板读取应用私有目录/外部存储中的文件。
// 使用独立子类与 authority（${applicationId}.nbfileprovider），避免与 Tauri 模板或其它插件声明的 FileProvider 冲突。

package com.crazyfigure.noteboard

import androidx.core.content.FileProvider

class NbFileProvider : FileProvider()
