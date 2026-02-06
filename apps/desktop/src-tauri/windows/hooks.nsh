!define XHARNESS_HOOK_DIR "${__FILEDIR__}"

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\install-ownership.ps1 "${XHARNESS_HOOK_DIR}\install-ownership.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -File "$PLUGINSDIR\install-ownership.ps1" -Mode Preflight -InventoryPath "$PLUGINSDIR\xharness-install-inventory.json"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONSTOP "Close all XHarness windows and Hosts, then retry. Installation was not started.$\r$\n$1" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -File "$PLUGINSDIR\install-ownership.ps1" -Mode Reconcile -InstallDirectory "$INSTDIR" -InventoryPath "$PLUGINSDIR\xharness-install-inventory.json"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "XHarness files were installed but shortcut migration needs attention. Old data was not deleted.$\r$\n$1" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
!macroend
