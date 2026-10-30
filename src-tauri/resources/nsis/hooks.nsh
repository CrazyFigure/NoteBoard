; NoteBoard NSIS Hooks
; 文件关联宏替换 Tauri 默认的抢占式注册，并自动修复旧安装器遗留的覆盖。
; NSIS_HOOK_POSTINSTALL / POSTUNINSTALL 维护应用程序候选项并刷新 Shell 缓存。
; 详见 docs/09-开发路线图.md 14.4/14.5

!include "${__FILEDIR__}\file-associations.nsh"

!macro NSIS_HOOK_POSTINSTALL
  ; 清理旧版内置更新器遗留的批处理，防止卸载旧版并安装完成后再次启动 NoteBoard
  ; 仅处理系统临时目录中的更新脚本，不触碰 %APPDATA%\NoteBoard 用户数据
  Delete "$TEMP\NoteBoard-updates\apply_update.cmd"

  ; 注册应用程序
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "" "NoteBoard"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "NoteBoard"
  ; SupportedTypes 应为子键中的逐扩展名值，已由 APP_ASSOCIATE 写入；移除旧版无效的字符串值。
  DeleteRegValue HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "SupportedTypes"

  ; 清理旧版指向不存在 ProgID 的候选项；有效候选项由配置中的 NoteBoard.* 类型提供。
  !insertmacro NB_REMOVE_LEGACY_OPENWITH

  ; 刷新 Shell 缓存
  !insertmacro NB_INVALIDATE_ASSOCIATION_CACHE
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 清理应用程序注册
  DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"

  !insertmacro NB_REMOVE_LEGACY_OPENWITH

  ; 刷新 Shell 缓存
  !insertmacro NB_INVALIDATE_ASSOCIATION_CACHE
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

; 仅移除旧版自己写入的无效候选值，保留其他程序的候选项和扩展名子键。
!macro NB_REMOVE_LEGACY_OPENWITH
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.json\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.yaml\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.yml\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.excalidraw\OpenWithProgids" "NoteBoard"
!macroend
