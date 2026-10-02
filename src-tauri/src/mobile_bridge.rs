// NoteBoard 平台信息与移动端原生桥接
// 前端通过这里的命令获取平台信息、默认工作区，并在 Android 上调用 NbMobilePlugin（Kotlin）：
// 所有文件访问权限、外部文件收件、系统分享。桌面端对应命令返回安全的默认值。

use serde::Serialize;
use std::path::Path;

/// 平台信息（供前端选择桌面/移动界面与存储策略）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// 平台标识：windows / macos / linux / android / ios
    pub platform: String,
    /// 是否为移动端
    pub is_mobile: bool,
    /// 默认笔记工作区路径（移动端为应用私有目录；桌面端仅在强制移动布局调试时使用，不会主动创建）
    pub default_workspace: String,
    /// 外部存储根目录（仅 Android，例如 /storage/emulated/0）
    pub external_root: String,
    /// 是否已获得外部存储完整访问权限（仅 Android）
    pub all_files_access: bool,
}

/// 当前平台标识
fn platform_name() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// 移动端首次启动的欢迎笔记
const WELCOME_NOTE: &str = "# 欢迎使用 NoteBoard\n\n这是你的笔记工作区，所有内容默认保存在本应用的私有目录中。\n\n## 快速上手\n\n- 点击右下角 **＋** 新建笔记、画板、思维导图或多维表格\n- 长按文件可重命名、分享、加入收藏或删除\n- 在「设置 → 存储」中授权后，可以打开手机里的其它文件夹\n- 编辑页右上角 **⋮** 可切换源码 / 可视化模式、查看大纲\n\n> [!TIP]\n> 从其它应用「分享」或「用其他应用打开」文件到 NoteBoard，即可直接编辑。\n";

/// 确保默认工作区存在；首次创建时写入欢迎笔记（不覆盖已有文件）
fn ensure_workspace(dir: &Path) -> Result<(), String> {
    let existed = dir.exists();
    std::fs::create_dir_all(dir).map_err(|e| format!("创建工作区失败: {}", e))?;
    if !existed {
        let welcome = dir.join("欢迎使用 NoteBoard.md");
        if !welcome.exists() {
            std::fs::write(&welcome, WELCOME_NOTE).map_err(|e| format!("写入欢迎笔记失败: {}", e))?;
        }
    }
    Ok(())
}

// ── Android 原生插件注册 ──

#[cfg(target_os = "android")]
pub struct NbMobile<R: tauri::Runtime>(pub tauri::plugin::PluginHandle<R>);

/// 注册 Kotlin 侧 NbMobilePlugin（类由 CI 复制到生成工程的应用包名下）
#[cfg(target_os = "android")]
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::Manager;
    tauri::plugin::Builder::new("nb-mobile")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.crazyfigure.noteboard", "NbMobilePlugin")?;
            app.manage(NbMobile(handle));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StorageInfoResponse {
    #[serde(default)]
    all_files_access: bool,
    #[serde(default)]
    external_root: String,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize, Default)]
struct IncomingFilesResponse {
    #[serde(default)]
    files: Vec<String>,
}

pub mod commands {
    use super::*;

    /// 获取平台信息（只读，不创建任何目录）
    #[tauri::command]
    pub fn get_platform_info(app: tauri::AppHandle) -> Result<PlatformInfo, String> {
        let _ = &app;
        #[allow(unused_mut)]
        let mut info = PlatformInfo {
            platform: platform_name().to_string(),
            is_mobile: cfg!(mobile),
            default_workspace: crate::app_dirs::default_workspace_dir().to_string_lossy().to_string(),
            external_root: String::new(),
            all_files_access: false,
        };
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            if let Some(bridge) = app.try_state::<NbMobile<tauri::Wry>>() {
                if let Ok(storage) = bridge.0.run_mobile_plugin::<StorageInfoResponse>("getStorageInfo", ()) {
                    info.all_files_access = storage.all_files_access;
                    info.external_root = storage.external_root;
                }
            }
        }
        Ok(info)
    }

    /// 确保默认工作区存在（首次创建时写入欢迎笔记），返回其路径
    #[tauri::command]
    pub fn ensure_default_workspace() -> Result<String, String> {
        let workspace = crate::app_dirs::default_workspace_dir();
        ensure_workspace(&workspace)?;
        Ok(workspace.to_string_lossy().to_string())
    }

    /// 申请外部存储完整访问权限（Android 跳转系统设置页；其它平台无需申请）
    #[tauri::command]
    pub fn request_all_files_access(app: tauri::AppHandle) -> Result<(), String> {
        let _ = &app;
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            let bridge = app.try_state::<NbMobile<tauri::Wry>>().ok_or("原生桥接未初始化")?;
            bridge
                .0
                .run_mobile_plugin::<serde_json::Value>("requestAllFilesAccess", ())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 取出外部传入（打开方式 / 分享）的文件：content:// 已复制到收件箱，返回可直接读写的路径
    #[tauri::command]
    pub fn take_incoming_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
        let _ = &app;
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            let bridge = app.try_state::<NbMobile<tauri::Wry>>().ok_or("原生桥接未初始化")?;
            let inbox = crate::app_dirs::inbox_dir();
            let response = bridge
                .0
                .run_mobile_plugin::<IncomingFilesResponse>(
                    "takeIncomingFiles",
                    serde_json::json!({ "inboxDir": inbox.to_string_lossy() }),
                )
                .map_err(|e| e.to_string())?;
            return Ok(response.files);
        }
        #[allow(unreachable_code)]
        Ok(Vec::new())
    }

    /// 将应用退到后台（Android 首页按返回键时使用；其它平台无操作）
    #[tauri::command]
    pub fn move_app_to_background(app: tauri::AppHandle) -> Result<(), String> {
        let _ = &app;
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            let bridge = app.try_state::<NbMobile<tauri::Wry>>().ok_or("原生桥接未初始化")?;
            bridge
                .0
                .run_mobile_plugin::<serde_json::Value>("moveToBackground", ())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 设置系统栏（状态栏/导航栏）背景色与图标深浅，跟随应用主题（仅 Android）
    #[tauri::command]
    pub fn set_system_bar_style(app: tauri::AppHandle, color: String, dark: bool) -> Result<(), String> {
        let _ = (&app, &color, dark);
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            let bridge = app.try_state::<NbMobile<tauri::Wry>>().ok_or("原生桥接未初始化")?;
            bridge
                .0
                .run_mobile_plugin::<serde_json::Value>(
                    "setSystemBarStyle",
                    serde_json::json!({ "color": color, "dark": dark }),
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 调用系统分享面板分享文件（仅移动端）
    #[tauri::command]
    pub fn share_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
        let _ = (&app, &path);
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            let bridge = app.try_state::<NbMobile<tauri::Wry>>().ok_or("原生桥接未初始化")?;
            bridge
                .0
                .run_mobile_plugin::<serde_json::Value>("shareFile", serde_json::json!({ "path": path }))
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        #[allow(unreachable_code)]
        Err("当前平台不支持系统分享".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_workspace_writes_welcome_once() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        ensure_workspace(&workspace).unwrap();
        let welcome = workspace.join("欢迎使用 NoteBoard.md");
        assert!(welcome.exists());
        // 用户删除欢迎笔记后，再次调用不得重新写入
        std::fs::remove_file(&welcome).unwrap();
        ensure_workspace(&workspace).unwrap();
        assert!(!welcome.exists());
    }
}
