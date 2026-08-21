; NoteBoard NSIS Hooks
; NSIS_HOOK_POSTINSTALL: 手写文件关联注册表项
; NSIS_HOOK_POSTUNINSTALL: 清理注册表项
; 详见 docs/09-开发路线图.md 14.4/14.5

!macro NSIS_HOOK_POSTINSTALL
  ; 清理旧版内置更新器遗留的批处理，防止卸载旧版并安装完成后再次启动 NoteBoard
  ; 仅处理系统临时目录中的更新脚本，不触碰 %APPDATA%\NoteBoard 用户数据
  Delete "$TEMP\NoteBoard-updates\apply_update.cmd"

  ; 注册应用程序
  WriteRegStr HKCU "Software\Classes\Applications\NoteBoard.exe" "" "NoteBoard"
  WriteRegStr HKCU "Software\Classes\Applications\NoteBoard.exe\shell\open\command" "" '"$INSTDIR\NoteBoard.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\NoteBoard.exe" "FriendlyAppName" "NoteBoard"
  WriteRegStr HKCU "Software\Classes\Applications\NoteBoard.exe" "SupportedTypes" ".md;.markdown;.txt;.json;.yaml;.yml;.sql;.js;.ts;.py;.rs;.go;.java;.c;.cpp;.cs;.sh;.css;.xml;.html;.excalidraw"

  ; 为每个扩展名注册 OpenWithProgids
  !define EXTENSIONS ".md;.markdown;.txt;.json;.yaml;.yml;.sql;.js;.ts;.py;.rs;.go;.java;.c;.cpp;.cs;.sh;.css;.xml;.html;.excalidraw"

  ; Markdown 文件关联
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "NoteBoard" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "NoteBoard" ""
  WriteRegStr HKCU "Software\Classes\.txt\OpenWithProgids" "NoteBoard" ""
  WriteRegStr HKCU "Software\Classes\.json\OpenWithProgids" "NoteBoard" ""
  WriteRegStr HKCU "Software\Classes\.yaml\OpenWithProgids" "NoteBoard" ""
  WriteRegStr HKCU "Software\Classes\.yml\OpenWithProgids" "NoteBoard" ""
  WriteRegStr HKCU "Software\Classes\.excalidraw\OpenWithProgids" "NoteBoard" ""

  ; 刷新 Shell 缓存
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 清理应用程序注册
  DeleteRegKey HKCU "Software\Classes\Applications\NoteBoard.exe"

  ; 清理文件关联
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.json\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.yaml\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.yml\OpenWithProgids" "NoteBoard"
  DeleteRegValue HKCU "Software\Classes\.excalidraw\OpenWithProgids" "NoteBoard"

  ; 刷新 Shell 缓存
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend
