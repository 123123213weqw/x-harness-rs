!define XHARNESS_HOOK_DIR "${__FILEDIR__}"

; NSIS is a 32-bit process even for our x64 payload. WOW64's Shell Link API
; can reinterpret known-folder targets under Program Files as Program Files
; (x86), silently omitting user-created shortcuts from the ownership inventory.
; Use the native Windows PowerShell, without changing process-wide redirection.
!macro XHARNESS_SELECT_NATIVE_POWERSHELL
  Push $3
  StrCpy $3 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $3 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
!macroend

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  ; Migration is explicit and current-user only. Never retire the old directory.
  ClearErrors
  ${GetOptions} $CMDLINE "/XHARNESS_USER_MIGRATION" $0
  ${If} ${Errors}
    System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_USER_MIGRATION", t "0")'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_USER_MIGRATION", t "1")'
  ${EndIf}
  File /oname=$PLUGINSDIR\install-ownership.ps1 "${XHARNESS_HOOK_DIR}\install-ownership.ps1"
  File /oname=$PLUGINSDIR\install-shortcuts.cs "${XHARNESS_HOOK_DIR}\install-shortcuts.cs"
  ; Execute only the fixed code embedded in this installer. Paths travel as
  ; data, never interpolated PowerShell source. No execution-policy changes,
  ; downloaded scripts, profile loading or pwsh 7 dependency.
  System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_INSTALL_SCRIPT", t "$PLUGINSDIR\install-ownership.ps1")'
  System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_INSTALL_INVENTORY", t "$PLUGINSDIR\xharness-install-inventory.json")'
  System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_INSTALL_DIRECTORY", t "$INSTDIR")'
  !insertmacro XHARNESS_SELECT_NATIVE_POWERSHELL
  nsExec::ExecToStack '"$3" -NoLogo -NoProfile -NonInteractive -Command ". ([scriptblock]::Create([IO.File]::ReadAllText($$env:XHARNESS_INSTALL_SCRIPT))); Invoke-XHarnessPreflight $$env:XHARNESS_INSTALL_INVENTORY $$env:XHARNESS_INSTALL_DIRECTORY -UserMigration:($$env:XHARNESS_USER_MIGRATION -eq 1)"'
  Pop $0
  Pop $1
  Pop $3
  ${If} $0 != 0
    DetailPrint "$1"
    FileOpen $2 "$TEMP\XHarness-installation.log" a
    FileWrite $2 "Preflight: $1$\r$\n"
    FileClose $2
    MessageBox MB_OK|MB_ICONSTOP "Installation was stopped safely before replacing files. Resolve the process or file-access issue below, then retry.$\r$\n$1" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'kernel32::SetEnvironmentVariable(t "XHARNESS_INSTALL_DIRECTORY", t "$INSTDIR")'
  !insertmacro XHARNESS_SELECT_NATIVE_POWERSHELL
  nsExec::ExecToStack '"$3" -NoLogo -NoProfile -NonInteractive -Command ". ([scriptblock]::Create([IO.File]::ReadAllText($$env:XHARNESS_INSTALL_SCRIPT))); Invoke-XHarnessReconcile $$env:XHARNESS_INSTALL_DIRECTORY $$env:XHARNESS_INSTALL_INVENTORY -UserMigration:($$env:XHARNESS_USER_MIGRATION -eq 1)"'
  Pop $0
  Pop $1
  Pop $3
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
