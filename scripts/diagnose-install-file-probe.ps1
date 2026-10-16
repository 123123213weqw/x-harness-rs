# Inert PE observations only. Never launches the supplied application or changes installation policy.
param([Parameter(Mandatory)][string]$DesktopBinary, [Parameter(Mandatory)][string]$ReportPath)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Disposable GitHub-hosted Windows only'
}
$source = Join-Path $PSScriptRoot '../apps/desktop/src-tauri/windows/install-ownership.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($fn in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$fixture = Join-Path $env:RUNNER_TEMP ('xharness-pe-observation-' + [guid]::NewGuid().ToString('N'))
$rows = [Collections.Generic.List[object]]::new()
$nativeObservation = $null; $nativeProcess = $null
function Observe-ExclusiveWrite([string]$Path) {
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $stream.Dispose()
        return @{ available = $true }
    } catch {
        $cause = $_.Exception.GetBaseException()
        return @{ available = $false; type = $cause.GetType().FullName; hresult = ('0x{0:X8}' -f $cause.HResult) }
    }
}
try {
    for ($i = 0; $i -lt 12; $i++) {
        $unicode = -join @([char]0x4E2D, [char]0x6587)
        $directory = Join-Path $fixture ("copy $i " + $unicode)
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $desktop = Join-Path $directory 'xharness-desktop.exe'
        [IO.File]::Copy($DesktopBinary, $desktop)
        [IO.File]::Copy($DesktopBinary, (Join-Path $directory 'xharness-host.exe'))
        $before = Observe-ExclusiveWrite $desktop
        $null = Get-XHarnessDirectory $directory
        $after = Observe-ExclusiveWrite $desktop
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        $afterGc = Observe-ExclusiveWrite $desktop
        $rows.Add(@{ iteration = $i; beforeVersionInfo = $before; afterVersionInfo = $after; afterGc = $afterGc })
    }
    # Contrast the managed C# fixture with an inert native Windows PE. Keep the
    # real process handle through exit, then compare before/after Dispose. This
    # executes only the hosted VM's hostname utility, never XHarness itself.
    $nativeDirectory = Join-Path $fixture 'retained-native-image'
    [IO.Directory]::CreateDirectory($nativeDirectory) | Out-Null
    $nativeImage = Join-Path $nativeDirectory 'xharness-host.exe'
    [IO.File]::Copy((Join-Path $env:SystemRoot 'System32/hostname.exe'), $nativeImage)
    $nativeProcess = Start-Process -FilePath $nativeImage -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $nativeDirectory 'stdout.txt') `
        -RedirectStandardError (Join-Path $nativeDirectory 'stderr.txt')
    $null = $nativeProcess.Handle
    if (-not $nativeProcess.WaitForExit(10000)) { throw 'Disposable native image did not exit' }
    $pidToInspect = $nativeProcess.Id
    $retained = Observe-ExclusiveWrite $nativeImage
    $record = @(Get-CimInstance Win32_Process -Filter "ProcessId=$pidToInspect")
    $nativeProcess.Dispose(); $nativeProcess = $null
    $disposed = Observe-ExclusiveWrite $nativeImage
    $nativeObservation = @{ exitedWithRetainedHandle = $retained; afterHandleDisposed = $disposed;
        listedAfterExit = ($record.Count -gt 0); records = @($record | Select-Object ProcessId, ThreadCount, HandleCount) }
} finally {
    if ($null -ne $nativeProcess) {
        if (-not $nativeProcess.HasExited) { $nativeProcess.Kill(); $nativeProcess.WaitForExit() }
        $nativeProcess.Dispose()
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath))) | Out-Null
    @{ diagnosticOnly = $true; powershell = $PSVersionTable.PSVersion.ToString(); rows = $rows.ToArray(); nativeRetainedProcess = $nativeObservation } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Get-Content -LiteralPath $ReportPath
    # Exact disposable files only; a locked file stays on this disposable VM.
    foreach ($row in @(Get-ChildItem -LiteralPath $fixture -Directory -ErrorAction SilentlyContinue)) {
        foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe', 'stdout.txt', 'stderr.txt')) {
            try { [IO.File]::Delete((Join-Path $row.FullName $name)) } catch { Write-Warning $_.Exception.Message }
        }
        try { [IO.Directory]::Delete($row.FullName) } catch { Write-Warning $_.Exception.Message }
    }
    try { [IO.Directory]::Delete($fixture) } catch { Write-Warning $_.Exception.Message }
}
