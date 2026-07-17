# Synthetic native regression only. No user data or external network access.
$ErrorActionPreference = 'Stop'
# Optional synthetic-test evidence, separate from the streams being asserted.
# A timeout before 'started' means PowerShell never reached the script; a
# timeout between 'started' and 'add-type-ready' isolates C# compilation.
$probeClock = [Diagnostics.Stopwatch]::StartNew()
function Save-ProbeStage([string] $stage) {
    if ($env:XHARNESS_CONSOLE_PROBE_PROGRESS) {
        [IO.File]::AppendAllText($env:XHARNESS_CONSOLE_PROBE_PROGRESS,
            "$stage $($probeClock.ElapsedMilliseconds)ms`n")
    }
}
Save-ProbeStage 'started'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XHarnessConsoleProbe {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
}
'@
Save-ProbeStage 'add-type-ready'
$consoleWindow = [XHarnessConsoleProbe]::GetConsoleWindow()
# A headless PowerShell can retain internal console process membership. That
# does not imply a window; this fixture checks the HWND, not process count.
if ($consoleWindow -ne [IntPtr]::Zero) {
    throw 'Non-interactive child has a console window'
}
Save-ProbeStage 'console-checked'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Out.Write('no-console-stdout-你好')
[Console]::Error.Write('no-console-stderr-错误')
Save-ProbeStage 'streams-written'
exit 17
