; 文件关联只登记“打开方式”，不接管扩展名默认值、UserChoice 或其他应用的 ShellNew。
; Tauri 在引入 installerHooks 前定义这两个宏；若模板顺序变化，必须编译失败，不能退回抢占默认值的实现。
!ifmacrondef APP_ASSOCIATE
  !error "Tauri APP_ASSOCIATE must be defined before NoteBoard hooks"
!endif
!ifmacrondef APP_UNASSOCIATE
  !error "Tauri APP_UNASSOCIATE must be defined before NoteBoard hooks"
!endif

; 测试可将注册表根目录指向隔离的临时键；正式安装始终使用当前用户的 Classes。
!ifndef NB_CLASSES_ROOT
  !define NB_CLASSES_ROOT "Software\Classes"
!endif
!ifndef NB_SHELLNEW_CACHE
  !define NB_SHELLNEW_CACHE "Software\Microsoft\Windows\CurrentVersion\Explorer\Discardable\PostSetup\ShellNew"
!endif
; 只在实际恢复旧覆盖后失效菜单缓存，新装或用户已改用其他程序时不碰该缓存。
Var NB_AssociationsRepaired

; 只修复存在旧安装器备份的扩展名；用户后来选择其他类型、无备份或备份类型异常时均保留原状。
!macro NB_REPAIR_ASSOCIATION EXT FILECLASS
  Push $0
  Push $1
  Push $2
  ClearErrors
  ReadRegStr $1 HKCU "${NB_CLASSES_ROOT}\.${EXT}" "${FILECLASS}_backup"
  ${IfNot} ${Errors}
    ClearErrors
    ReadRegStr $0 HKCU "${NB_CLASSES_ROOT}\.${EXT}" ""
    ${IfNot} ${Errors}
      ; 空值覆盖可能来自旧卸载器恢复空备份；缺失默认值则保持缺失，不重新创建覆盖。
      ${If} $0 == "${FILECLASS}"
      ${OrIf} $0 == ""
        StrCpy $2 $1 10
        ${If} $1 == ""
        ${OrIf} $2 == "NoteBoard."
          ; 重复安装可能已经丢失最初的备份：不硬编码 Office/WPS 类型，不写入机器级注册表。
          DeleteRegValue HKCU "${NB_CLASSES_ROOT}\.${EXT}" ""
          ${IfNot} ${Errors}
            StrCpy $NB_AssociationsRepaired 1
          ${EndIf}
        ${ElseIf} $0 == "${FILECLASS}"
          WriteRegStr HKCU "${NB_CLASSES_ROOT}\.${EXT}" "" "$1"
          ${IfNot} ${Errors}
            StrCpy $NB_AssociationsRepaired 1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; 保留原始备份，兼容用户随后运行仍在磁盘上的旧卸载器，也便于恢复来源核对。
  ClearErrors
  Pop $2
  Pop $1
  Pop $0
!macroend

; 这里只删除 Explorer 可重建的列表和时间戳，不修改任何应用的 ShellNew 模板，也不强制重启 Explorer。
!macro NB_INVALIDATE_ASSOCIATION_CACHE
  ${If} $NB_AssociationsRepaired == 1
    DeleteRegValue HKCU "${NB_SHELLNEW_CACHE}" "Classes"
    DeleteRegValue HKCU "${NB_SHELLNEW_CACHE}" "~reserved~"
    StrCpy $NB_AssociationsRepaired 0
  ${EndIf}
!macroend

; 复用 Tauri 根据 fileAssociations 生成的扩展名列表，避免两份格式清单随版本漂移。
!macroundef APP_ASSOCIATE
!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  !insertmacro NB_REPAIR_ASSOCIATION "${EXT}" "${FILECLASS}"
  WriteRegStr HKCU "${NB_CLASSES_ROOT}\${FILECLASS}" "" `${DESCRIPTION}`
  WriteRegStr HKCU "${NB_CLASSES_ROOT}\${FILECLASS}\DefaultIcon" "" `${ICON}`
  WriteRegStr HKCU "${NB_CLASSES_ROOT}\${FILECLASS}\shell\open" "" `${COMMANDTEXT}`
  ; 可执行文件和文件参数都必须加引号，安装目录含空格时也能正确打开。
  WriteRegStr HKCU "${NB_CLASSES_ROOT}\${FILECLASS}\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr HKCU "${NB_CLASSES_ROOT}\.${EXT}\OpenWithProgids" "${FILECLASS}" ""
  WriteRegStr HKCU "${NB_CLASSES_ROOT}\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

; 卸载只清理 NoteBoard 自己的候选项；绝不把过期备份重新写成用户的默认关联。
!macroundef APP_UNASSOCIATE
!macro APP_UNASSOCIATE EXT FILECLASS
  !insertmacro NB_REPAIR_ASSOCIATION "${EXT}" "${FILECLASS}"
  DeleteRegValue HKCU "${NB_CLASSES_ROOT}\.${EXT}\OpenWithProgids" "${FILECLASS}"
  DeleteRegKey /ifempty HKCU "${NB_CLASSES_ROOT}\.${EXT}\OpenWithProgids"
  DeleteRegKey HKCU "${NB_CLASSES_ROOT}\${FILECLASS}"
!macroend
