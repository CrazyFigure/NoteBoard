// Linux 打开文件/文件夹：保留 GTK 原生浏览与校验，并在显示时展开路径输入框。
use gtk::prelude::*;
use serde::Deserialize;
use std::{cell::RefCell, rc::Rc};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_fs::FsExt;
use tokio::sync::oneshot;

/// 与前端系统文件选择器使用相同的扩展名筛选契约。
#[derive(Deserialize)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// GTK 控件只能在主线程操作；通过响应回调返回结果，不阻塞 Tauri 的事件循环。
#[tauri::command]
pub async fn open_linux_path_dialog(
    window: WebviewWindow,
    directory: bool,
    filters: Vec<DialogFilter>,
) -> Result<Option<Vec<String>>, String> {
    let (sender, receiver) = oneshot::channel();
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            let result = parent.gtk_window().map_err(|error| error.to_string());
            let parent_window = match result {
                Ok(parent_window) => parent_window,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    return;
                }
            };
            let action = if directory {
                gtk::FileChooserAction::SelectFolder
            } else {
                gtk::FileChooserAction::Open
            };
            let dialog = gtk::FileChooserDialog::with_buttons(
                Some(if directory {
                    "打开文件夹"
                } else {
                    "打开文件"
                }),
                Some(&parent_window),
                action,
                &[
                    ("取消(_C)", gtk::ResponseType::Cancel),
                    ("打开(_O)", gtk::ResponseType::Accept),
                ],
            );
            dialog.set_modal(true);
            dialog.set_destroy_with_parent(true);
            dialog.set_local_only(true);
            dialog.set_select_multiple(!directory);
            dialog.set_default_response(gtk::ResponseType::Accept);
            for filter in filters {
                let gtk_filter = gtk::FileFilter::new();
                gtk_filter.set_name(Some(&filter.name));
                for extension in filter.extensions {
                    // “全部文件”必须匹配无扩展名文件，不能把通配符转成 *.*。
                    let pattern = if extension == "*" {
                        "*".into()
                    } else {
                        format!("*.{extension}")
                    };
                    gtk_filter.add_pattern(&pattern);
                }
                dialog.add_filter(gtk_filter);
            }

            // map 在 GTK 加载最近使用/路径栏状态之后执行，避免输入框被初始化覆盖。
            // 使用幂等的 location-popup，而非会再次隐藏输入框的 location-toggle-popup。
            dialog.connect_map(|dialog| {
                if let Some(chooser) = find_chooser(dialog.upcast_ref()) {
                    chooser.emit_location_popup("");
                }
            });
            let reply = Rc::new(RefCell::new(Some(sender)));
            let response_reply = reply.clone();
            dialog.connect_response(move |dialog, response| {
                let result = if response == gtk::ResponseType::Accept {
                    selected_paths(&parent, dialog, directory).map(Some)
                } else {
                    Ok(None)
                };
                if let Some(sender) = response_reply.borrow_mut().take() {
                    let _ = sender.send(result);
                }
                // 已读取选择结果；销毁后不再访问 GTK 控件。
                unsafe {
                    dialog.destroy();
                }
            });
            // 父窗口关闭导致对话框直接销毁时，也要结束等待中的 IPC。
            dialog.connect_destroy(move |_| {
                if let Some(sender) = reply.borrow_mut().take() {
                    let _ = sender.send(Ok(None));
                }
            });
            dialog.show();
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "文件选择对话框已关闭".to_string())?
}

/// 只按公开 GTK 类型查找内嵌选择器，不依赖主题、控件名称或固定层级。
fn find_chooser(widget: &gtk::Widget) -> Option<gtk::FileChooserWidget> {
    if let Some(chooser) = widget.downcast_ref::<gtk::FileChooserWidget>() {
        return Some(chooser.clone());
    }
    widget
        .downcast_ref::<gtk::Container>()?
        .children()
        .iter()
        .find_map(find_chooser)
}

/// 与 Tauri dialog 插件保持相同的文件系统/资源作用域授权，避免选中后读取被拒绝。
fn selected_paths(
    window: &WebviewWindow,
    dialog: &gtk::FileChooserDialog,
    directory: bool,
) -> Result<Vec<String>, String> {
    let scopes = window.state::<tauri::scope::Scopes>();
    let mut selected = Vec::new();
    for path in dialog.filenames() {
        if directory {
            if let Some(scope) = window.try_fs_scope() {
                scope
                    .allow_directory(&path, false)
                    .map_err(|error| error.to_string())?;
            }
            scopes
                .allow_directory(&path, true)
                .map_err(|error| error.to_string())?;
        } else {
            if let Some(scope) = window.try_fs_scope() {
                scope.allow_file(&path).map_err(|error| error.to_string())?;
            }
            scopes
                .allow_file(&path)
                .map_err(|error| error.to_string())?;
        }
        selected.push(path.to_string_lossy().into_owned());
    }
    Ok(selected)
}
