# 软件包管理器分发

- **WinGet**：`winget/0.5.7` 保存本次提交的清单，对应[官方 PR #453871](https://github.com/microsoft/winget-pkgs/pull/453871)。合并入库后可用 `winget install/upgrade --id CrazyFigure.NoteBoard --exact`。已在本机通过 `winget validate --manifest distribution/winget/0.5.7`，实际安装验证由官方流水线执行。
- **Homebrew**：[CrazyFigure/homebrew-tap](https://github.com/CrazyFigure/homebrew-tap) 是 Cask 与更新脚本的唯一维护位置。每 6 小时检查上游正式 Release，两个 DMG 齐全并完成哈希、安装验证后更新清单；也可手动运行 Tap 的 **Update NoteBoard** 工作流。未公证的安装包不申请 Homebrew 官方主仓收录。

后续 WinGet 版本仍需向官方仓库提交更新；发布 GitHub Release 不会自动更新 WinGet 目录。首版入库后可使用微软的 [WinGetCreate](https://github.com/microsoft/winget-create)：

```powershell
wingetcreate update CrazyFigure.NoteBoard --version x.y.z --urls https://github.com/CrazyFigure/NoteBoard/releases/download/vx.y.z/NoteBoard_x.y.z_windows_x64-setup.exe --submit
```

提交前核对新版本清单、安装范围、发布者及 SHA-256，并运行 `winget validate`；不要修改已发布标签或替换同版本安装包。

## 桌面一键更新签名

发布签名包前，用 `pnpm tauri signer generate -w <仓库外的私钥路径>` 生成有密码的 Tauri 密钥对，并安全备份。在 GitHub Actions 配置变量 `NOTEBOARD_UPDATE_PUBLIC_KEY`（`.pub` 的内容）、Secret `TAURI_SIGNING_PRIVATE_KEY`（私钥文件的内容）和 Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。同一公钥随客户端编译，后续版本使用同一私钥签名，私钥只用于正式版签名。没有配置密钥的构建继续提供手动更新。

Windows 安装版和免安装版、macOS Intel 和 Apple Silicon、Linux AppImage 和 DEB 各自使用对应的签名附件。GitHub Release 上传后，同名包和 `.sig` 由现有流程同步到 CNB。旧客户端需先安装一个含更新公钥的发行版，随后可以在更新弹窗内一键更新。macOS 应从可写的应用目录运行，DEB 需要系统 polkit 授权。会话恢复沿用应用的最近窗口设置，更新前需先保存文档并关闭其他窗口。
