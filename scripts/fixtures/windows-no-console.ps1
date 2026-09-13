# Synthetic native regression only. No user data or external network access.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XHarnessConsoleProbe {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
}
'@
$consoleWindow = [XHarnessConsoleProbe]::GetConsoleWindow()
# A headless PowerShell can retain internal console process membership. That
# does not imply a window; this fixture checks the HWND, not process count.
if ($consoleWindow -ne [IntPtr]::Zero) {
    throw 'Non-interactive child has a console window'
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Out.Write('no-console-stdout-你好')
[Console]::Error.Write('no-console-stderr-错误')
exit 17
