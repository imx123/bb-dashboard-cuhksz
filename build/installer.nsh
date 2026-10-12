; Clear embedded-browser credentials on explicit uninstall only.
; Do not erase logs, course caches, completion marks or custom data locations.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    SetShellVarContext current
    ClearErrors
    IfFileExists "$APPDATA\bb-dashboard-cuhksz\browser\*.*" 0 browser_removed
    RMDir /r "$APPDATA\bb-dashboard-cuhksz\browser"
    IfErrors browser_cleanup_failed
  browser_removed:
    IfFileExists "$APPDATA\bb-dashboard-cuhksz\dashboard-startup.json" 0 browser_cleanup_done
    Delete "$APPDATA\bb-dashboard-cuhksz\dashboard-startup.json"
    IfErrors browser_cleanup_failed
    Goto browser_cleanup_done
  browser_cleanup_failed:
    MessageBox MB_OK|MB_ICONEXCLAMATION "The embedded browser session or startup marker could not be fully removed. Close the Dashboard and retry uninstalling."
    Abort "Embedded browser session cleanup failed."
  browser_cleanup_done:
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
