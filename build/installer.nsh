!macro pitchordRemoveManagedData
  RMDir /r "$LOCALAPPDATA\Pitchord\base-runtime"
  RMDir /r "$LOCALAPPDATA\Pitchord\analysis-runtime"
  RMDir /r "$LOCALAPPDATA\Pitchord\models"
  RMDir /r "$LOCALAPPDATA\Pitchord\cache"
  RMDir /r "$LOCALAPPDATA\Pitchord\downloads"
  RMDir "$LOCALAPPDATA\Pitchord"
  RMDir /r "$APPDATA\Pitchord"
  RMDir /r "$APPDATA\pitchord"
!macroend

!macro customUnInstall
  StrCpy $R9 "0"
  ${If} ${Silent}
    ClearErrors
    ${GetParameters} $R8
    ${GetOptions} $R8 "--delete-app-data" $R7
    ${IfNot} ${Errors}
      StrCpy $R9 "1"
    ${EndIf}
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 Pitchord 下载的内置 Python、分析依赖、模型和缓存？歌词工程和用户选择的外部 Python 不会被删除。" IDYES pitchord_cleanup_yes IDNO pitchord_cleanup_done
    pitchord_cleanup_yes:
      StrCpy $R9 "1"
  ${EndIf}
  pitchord_cleanup_done:
  ${If} $R9 == "1"
    !insertmacro pitchordRemoveManagedData
  ${EndIf}
!macroend
