!define XHARNESS_HOOK_DIR "${__FILEDIR__}"

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\install-ownership.ps1 "${XHARNESS_HOOK_DIR}\install-ownership.ps1"
  ; Execute only the fixed code embedded in this installer. Paths travel as
  ; data, never interpolated PowerShell source. No execution-policy changes,
  ; downloaded scripts, profile loading or pwsh 7 dependency.
  System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_INSTALL_SCRIPT", t "$PLUGINSDIR\install-ownership.ps1")'
  System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_INSTALL_INVENTORY", t "$PLUGINSDIR\xharness-install-inventory.json")'
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command ". ([scriptblock]::Create([IO.File]::ReadAllText($$env:XHARNESS_INSTALL_SCRIPT))); Invoke-XHarnessPreflight $$env:XHARNESS_INSTALL_INVENTORY"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    FileOpen $2 "$TEMP\XHarness-installation.log" a
    FileWrite $2 "Preflight: $1$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONSTOP "Close all XHarness windows and Hosts, then retry. Installation was not started.$\r$\n$1" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_INSTALL_DIRECTORY", t "$INSTDIR")'
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command ". ([scriptblock]::Create([IO.File]::ReadAllText($$env:XHARNESS_INSTALL_SCRIPT))); Invoke-XHarnessReconcile $$env:XHARNESS_INSTALL_DIRECTORY $$env:XHARNESS_INSTALL_INVENTORY"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    FileOpen $2 "$TEMP\XHarness-installation.log" a
    FileWrite $2 "Reconcile: $1$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONEXCLAMATION "XHarness files were installed but shortcut migration needs attention. Old data was not deleted.$\r$\n$1" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
!macroend
