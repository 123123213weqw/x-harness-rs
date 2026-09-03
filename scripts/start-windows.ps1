[CmdletBinding()]
param(
    [Parameter()]
    [string] $Workspace = (Get-Location).Path,

    [Parameter()]
    [string] $Bind = '127.0.0.1:3080',

    [Parameter()]
    [string] $HostExecutable,

    [Parameter()]
    [string] $ProvidersFile,

    [Parameter()]
    [string] $WebDist
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'PowerShell 7 (pwsh) is required.'
}
if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
    throw 'Set DEEPSEEK_API_KEY in this process before starting XHarness.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($HostExecutable)) {
    $packagedHost = Join-Path $PSScriptRoot 'xharness-host.exe'
    $repositoryHost = Join-Path $repositoryRoot 'target/release/xharness-host.exe'
    $HostExecutable = if (Test-Path -LiteralPath $packagedHost -PathType Leaf) {
        $packagedHost
    } else {
        $repositoryHost
    }
}
if ([string]::IsNullOrWhiteSpace($ProvidersFile)) {
    $packagedConfig = Join-Path $PSScriptRoot 'config/providers.deepseek.example.json'
    $repositoryConfig = Join-Path $repositoryRoot 'config/providers.deepseek.example.json'
    $ProvidersFile = if (Test-Path -LiteralPath $packagedConfig -PathType Leaf) {
        $packagedConfig
    } else {
        $repositoryConfig
    }
}
if ([string]::IsNullOrWhiteSpace($WebDist)) {
    $packagedWeb = Join-Path $PSScriptRoot 'ui'
    $repositoryWeb = Join-Path $repositoryRoot 'ui/dist'
    $WebDist = if (Test-Path -LiteralPath $packagedWeb -PathType Container) {
        $packagedWeb
    } else {
        $repositoryWeb
    }
}

$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$HostExecutable = (Resolve-Path -LiteralPath $HostExecutable).Path
$ProvidersFile = (Resolve-Path -LiteralPath $ProvidersFile).Path
$WebDist = (Resolve-Path -LiteralPath $WebDist).Path

Write-Host "XHarness: http://$Bind/"
Write-Host "Workspace: $Workspace"
& $HostExecutable `
    --bind $Bind `
    --workspace $Workspace `
    --static-dir $WebDist `
    --providers-file $ProvidersFile
exit $LASTEXITCODE
