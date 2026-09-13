# Synthetic native regression only. No user data or external network access.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XHarnessConsoleProbe {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList([Out] uint[] ids, uint count);
}
'@
$consoleWindow = [XHarnessConsoleProbe]::GetConsoleWindow()
$consoleProcesses = [XHarnessConsoleProbe]::GetConsoleProcessList([uint[]]::new(8), 8)
if ($consoleWindow -ne [IntPtr]::Zero -or $consoleProcesses -ne 0) {
    throw 'Non-interactive child has an attached console'
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Out.Write('no-console-stdout-你好')
[Console]::Error.Write('no-console-stderr-错误')
exit 17
