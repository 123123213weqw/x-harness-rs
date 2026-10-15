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
} finally {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath))) | Out-Null
    @{ diagnosticOnly = $true; powershell = $PSVersionTable.PSVersion.ToString(); rows = $rows.ToArray() } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Get-Content -LiteralPath $ReportPath
    # Exact disposable files only; a locked file stays on this disposable VM.
    foreach ($row in @(Get-ChildItem -LiteralPath $fixture -Directory -ErrorAction SilentlyContinue)) {
        foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe')) {
            try { [IO.File]::Delete((Join-Path $row.FullName $name)) } catch { Write-Warning $_.Exception.Message }
        }
        try { [IO.Directory]::Delete($row.FullName) } catch { Write-Warning $_.Exception.Message }
    }
    try { [IO.Directory]::Delete($fixture) } catch { Write-Warning $_.Exception.Message }
}
