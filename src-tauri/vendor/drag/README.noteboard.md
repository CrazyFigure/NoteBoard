# NoteBoard 原生标签拖放适配

来源：[CrabNebula drag 2.1.1](https://github.com/crabnebula-dev/drag-rs)。保留上游 MIT / Apache-2.0 许可和原有注释。

NoteBoard 的标签不是待导出的文件。此处保留上游的 OLE / AppKit 和位图处理，增加 `Options.internal_only`：

- Windows：松手时只向本进程的顶层窗口投递；其他落点取消系统文件投递，由上层拆窗。同时使用普通箭头配合标签卡片，应用外不显示错误的“禁止投递”光标。
- macOS：对 `OutsideApplication` 返回空操作，Finder 和桌面不会复制临时票据；应用内仍能合并。坐标翻转使用主屏逻辑点高度，兼容 Retina。
- Linux：应用没有使用此库的 GTK 后端；自己的适配从真实鼠标事件发起，以取得 Wayland 输入串行号，并通过私有 MIME 与 `SAME_APP` 目标传递票据，不提供外部文件 URI。

后续升级上游版本时须保留这些修改，并重新验证桌面松手不会生成票据文件。
