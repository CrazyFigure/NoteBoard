# 软件包管理器分发

- **WinGet**：`winget/0.5.7` 保存本次提交的清单，对应[官方 PR #453871](https://github.com/microsoft/winget-pkgs/pull/453871)。合并入库后可用 `winget install/upgrade --id CrazyFigure.NoteBoard --exact`。已在本机通过 `winget validate --manifest distribution/winget/0.5.7`，实际安装验证由官方流水线执行。
- **Homebrew**：[CrazyFigure/homebrew-tap](https://github.com/CrazyFigure/homebrew-tap) 是 Cask 与更新脚本的唯一维护位置。每 6 小时检查上游正式 Release，两个 DMG 齐全并完成哈希、安装验证后更新清单；也可手动运行 Tap 的 **Update NoteBoard** 工作流。未公证的安装包不申请 Homebrew 官方主仓收录。

后续 WinGet 版本仍需向官方仓库提交更新；发布 GitHub Release 不会自动更新 WinGet 目录。首版入库后可使用微软的 [WinGetCreate](https://github.com/microsoft/winget-create)：

```powershell
wingetcreate update CrazyFigure.NoteBoard --version x.y.z --urls https://github.com/CrazyFigure/NoteBoard/releases/download/vx.y.z/NoteBoard_x.y.z_windows_x64-setup.exe --submit
```

提交前核对新版本清单、安装范围、发布者及 SHA-256，并运行 `winget validate`；不要修改已发布标签或替换同版本安装包。
