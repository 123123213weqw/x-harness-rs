[CmdletBinding()]
param([string]$RuntimeRoot = (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/resources/powershell'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$manifest = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'manifest.json') -Raw | ConvertFrom-Json
$exe = (Resolve-Path (Join-Path $RuntimeRoot "$($manifest.version)/pwsh.exe")).Path
$before = @{}
$names = @('PATH', 'DOTNET_ROOT', 'DOTNET_MULTILEVEL_LOOKUP', 'PSModulePath')
foreach ($name in $names) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    # No installed pwsh or .NET directory is on PATH. The portable distribution
    # must bring its own hostfxr/CoreCLR and built-in PowerShell modules.
    $env:PATH = "$env:SystemRoot/System32"
    $env:DOTNET_ROOT = Join-Path $env:TEMP 'xharness-no-installed-dotnet'
    $env:DOTNET_MULTILEVEL_LOOKUP = '0'
    $env:PSModulePath = ''
    $output = & $exe -NoLogo -NoProfile -NonInteractive -Command '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Import-Module Microsoft.PowerShell.Utility; @{version=$PSVersionTable.PSVersion.ToString(); edition=$PSVersionTable.PSEdition; text="中文路径"; value=(1+2)} | ConvertTo-Json -Compress'
    if ($LASTEXITCODE) { throw 'Bundled PowerShell failed without system PATH/.NET' }
    $result = $output | ConvertFrom-Json
    if ($result.version -cne $manifest.version -or $result.edition -cne 'Core' -or $result.text -cne '中文路径' -or $result.value -ne 3) { throw 'Wrong interpreter version/module/UTF-8 result' }
    & $exe -NoLogo -NoProfile -NonInteractive -Command 'exit 7'
    if ($LASTEXITCODE -ne 7) { throw 'Portable interpreter lost nonzero exit code' }
    $global:LASTEXITCODE = 0
    Write-Host "Bundled PowerShell $($result.version): isolated PATH, self-contained .NET, modules, UTF-8 and exit status passed"
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $before[$name], 'Process') }
}
