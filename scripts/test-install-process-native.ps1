$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Native process fixture compilation/execution requires disposable Windows CI'
}
$tokens = $null; $parseErrors = $null
$source = Join-Path $PSScriptRoot '../apps/desktop/src-tauri/windows/install-ownership.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($fn in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
# Do not enumerate/change the runner's shortcuts; process/file probes stay real.
function Get-XHarnessLinks { }
$fixture = Join-Path $env:RUNNER_TEMP ('xharness-native-process-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$hostBinary = Join-Path $fixture 'xharness-host.exe'
$desktopBinary = Join-Path $fixture 'xharness-desktop.exe'
$inventory = Join-Path $fixture 'inventory.json'
Add-Type -OutputAssembly $hostBinary -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Threading;
[assembly: System.Reflection.AssemblyProduct("XHarness")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]
public static class ProcessFixture {
    public static void Main(string[] args) {
        Thread.Sleep(args.Length > 0 && args[0] == "wait" ? 30000 : 1000);
    }
}
'@
[IO.File]::Copy($hostBinary, $desktopBinary)
$live = $null; $retained = $null
try {
    $live = Start-Process -FilePath $hostBinary -ArgumentList 'wait' -WindowStyle Hidden -PassThru
    $null = $live.Handle
    $blocking = @(Get-XHarnessProcesses -Directories @($fixture))
    if (@($blocking | Where-Object ProcessId -EQ $live.Id).Count -ne 1) { throw 'Real live child was not blocked' }
    $refused = $false
    try { Assert-XHarnessFilesAvailable @($fixture) } catch { $refused = $true }
    if (-not $refused) { throw 'Executing image was incorrectly considered writable' }
    # Only this fixture's retained process handle is used for termination.
    $live.Kill(); $live.WaitForExit(); $live.Dispose(); $live = $null
    $retained = Start-Process -FilePath $hostBinary -WindowStyle Hidden -PassThru
    $null = $retained.Handle
    if (-not $retained.WaitForExit(10000)) { throw 'Fixture failed to exit' }
    $record = Get-CimInstance Win32_Process -Filter "ProcessId=$($retained.Id)"
    $ownerStatus = $null
    if ($record) { $ownerStatus = (Invoke-CimMethod -InputObject $record -MethodName GetOwnerSid).ReturnValue }
    [pscustomobject]@{
        test = 'exited-child-with-retained-handle'; listed = [bool]$record
        threads = $record.ThreadCount; handles = $record.HandleCount; ownerStatus = $ownerStatus
    } | ConvertTo-Json -Compress
    # If Windows removes the entry immediately this validates the disappearance
    # path, not reproduction of the laptop's inaccessible retained object.
    if (@(Get-XHarnessProcesses -Directories @($fixture)).Count) { throw 'Exited fixture still blocks installation' }
    Invoke-XHarnessPreflight $inventory $fixture
    Invoke-XHarnessReconcile $fixture $inventory
    if (-not (Test-Path -LiteralPath $hostBinary)) { throw 'Probe changed fixture installation' }
    Write-Output 'PASS: native live-image refusal, retained exited child, preflight and reconciliation.'
} finally {
    foreach ($child in @($live, $retained)) {
        if ($null -ne $child) {
            if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
            $child.Dispose()
        }
    }
    foreach ($file in @($hostBinary, $desktopBinary, $inventory)) { [IO.File]::Delete($file) }
    [IO.Directory]::Delete($fixture)
}
