# Final NSIS old -> new acceptance on the explicitly authorized disposable VM.
# Never relax test-windows-install-ownership.ps1's hosted-runner guard.
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$RuntimeAudit,
    [Parameter(Mandatory)][string]$BaselineInstaller,
    [Parameter(Mandatory)][string]$Evidence,
    [string]$Collector = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$uuid = '66B64058-BDCC-43E9-85EE-55A79FE2E875'
if ((Get-CimInstance Win32_ComputerSystemProduct).UUID -ne $uuid) { throw 'Wrong disposable Windows VM' }
if ($Collector -and $Collector -ne 'http://10.0.2.2:18086/result') { throw 'Unexpected evidence collector' }
$install = Join-Path $env:LOCALAPPDATA 'XHarness-WinLab'
$root = Join-Path $env:TEMP ('XHarness-Runtime-Gates-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$audit = Get-Content -LiteralPath $RuntimeAudit -Raw | ConvertFrom-Json
if ($audit.schema -ne 1 -or $audit.passed -ne $true -or $audit.installer_sha256 -ne (Get-FileHash -LiteralPath $Installer).Hash.ToLowerInvariant()) { throw 'Wrong candidate installer audit' }
if ((Get-FileHash -LiteralPath $BaselineInstaller).Hash.ToLowerInvariant() -ne '4c2e08971f0fc5a50cad61048a79da2562f57d3e244d2d3c4aef5e80a9e673a7') { throw 'Wrong official baseline installer' }
function Record([string]$Case, $Data) {
    $json = @{case=$Case; utc=[DateTime]::UtcNow.ToString('o'); data=$Data} | ConvertTo-Json -Depth 12 -Compress
    [IO.File]::AppendAllText($Evidence, $json + "`n", [Text.UTF8Encoding]::new($false))
    if ($Collector) {
        try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri $Collector -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 15 -DisableKeepAlive | Out-Null }
        catch { Write-Host 'Collector unavailable; local evidence retained' }
    }
}
function Assert-That($Ok, [string]$Message) { if (-not $Ok) { throw $Message } }
function Owned-Processes {
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetDirectoryName($_.ExecutablePath) -eq $install -and $_.Name -in @('xharness-desktop.exe', 'xharness-host.exe', 'xharness-windows-sandbox-runner.exe') })
}
function Stop-Owned {
    foreach ($p in @(Owned-Processes)) { Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Assert-That (@(Owned-Processes).Count -eq 0) 'Owned fixture processes did not exit'
}
function Assert-CleanRuntime {
    $paths = @((Join-Path $env:SystemRoot 'System32/VCRUNTIME140.dll'), (Join-Path $env:SystemRoot 'SysWOW64/VCRUNTIME140.dll'), (Join-Path $install 'VCRUNTIME140.dll'))
    foreach ($path in $paths) { Assert-That (-not (Test-Path -LiteralPath $path)) "VC runtime installed; not a clean-VM test: $path" }
}
function Install-Copy([string]$Path) {
    $p = Start-Process -FilePath $Path -ArgumentList @('/S', "/D=$install") -PassThru
    try {
        $null = $p.Handle
        Assert-That ($p.WaitForExit(120000)) 'Installer timeout'
        $p.Refresh()
        Assert-That ($p.ExitCode -eq 0) "Installer failed: $($p.ExitCode)"
    } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue } }
}
function Assert-Payload {
    foreach ($m in $audit.modules) {
        Assert-That ($m.path -notmatch '(^/|\.\.|:)' ) 'Unsafe audit module path'
        Assert-That ((Get-FileHash -LiteralPath (Join-Path $install $m.path)).Hash.ToLowerInvariant() -eq $m.sha256) "Stale upgraded module: $($m.path)"
    }
}
function Assert-ReadOnlyTool {
    $workspace = Join-Path $root 'workspace'
    $tempRoot = Join-Path $root 'sandbox-temp'
    New-Item -ItemType Directory -Path $workspace, $tempRoot | Out-Null
    $probe = @'
$ErrorActionPreference='Stop'
Write-Output ('CWD=' + (Get-Location).Path)
try { [IO.File]::WriteAllText((Join-Path (Get-Location).Path 'must-not-write.txt'), 'unexpected'); exit 41 }
catch [UnauthorizedAccessException] { Write-Output 'READ_ONLY_DENIED' }
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
    $out = Join-Path $root 'tool.stdout.txt'
    $err = Join-Path $root 'tool.stderr.txt'
    $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $args = @('--workspace', ('"' + $workspace + '"'), '--temp-root', ('"' + $tempRoot + '"'), '--cwd', ('"' + $workspace + '"'), '--mode', 'read-only', '--', ('"' + $shell + '"'), '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
    $p = Start-Process -FilePath (Join-Path $install 'xharness-windows-sandbox-runner.exe') -ArgumentList $args -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    try {
        $null = $p.Handle
        $ended = $p.WaitForExit(30000)
        $p.Refresh()
        $stdout = [IO.File]::ReadAllText($out)
        $stderr = [IO.File]::ReadAllText($err)
        $cwd = @($stdout -split "`r?`n" | Where-Object { $_.StartsWith('CWD=') })
        $matchesCwd = $cwd.Count -eq 1 -and $cwd[0].Substring(4).Replace('\\?\', '') -ieq $workspace
        $passed = $ended -and $p.ExitCode -eq 0 -and $matchesCwd -and $stdout.Contains('READ_ONLY_DENIED') -and -not (Test-Path (Join-Path $workspace 'must-not-write.txt'))
        Record 'final-installer-read-only-tool' @{passed=$passed; ended=$ended; stdout=$stdout; stderr=$stderr; cwdMatches=$matchesCwd; exitCode=$(if ($ended) {$p.ExitCode} else {$null})}
        Assert-That $passed 'Read-only tool / working-directory acceptance failed'
    } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue } }
}
$desktop = $null
try {
    Stop-Owned
    Assert-CleanRuntime
    Record 'clean-runtime-environment' @{passed=$true; uuid=$uuid; os=(Get-CimInstance Win32_OperatingSystem).Version; adminToken=([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
    Install-Copy $BaselineInstaller
    Assert-That ((Get-FileHash (Join-Path $install 'xharness-host.exe')).Hash -eq 'AABFAF4D44051A8BBE8B36DB43538ECB54ACDC4CA4F721E394F2BF7EF1D74554') 'Baseline Host differs'
    $data = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.xlang.xharness'
    New-Item -ItemType Directory -Force $data | Out-Null
    $sentinel = Join-Path $data ('runtime-gates-' + [guid]::NewGuid().ToString('N') + '.txt')
    [IO.File]::WriteAllText($sentinel, 'retention fixture; no user secrets')
    $retained = (Get-FileHash $sentinel).Hash
    Install-Copy $Installer
    Assert-Payload
    Assert-CleanRuntime
    Assert-That ((Get-FileHash $sentinel).Hash -eq $retained) 'Upgrade changed retained data'
    Record 'official-baseline-to-candidate' @{passed=$true; installerSha256=$audit.installer_sha256; exactInstalledModuleHashes=$true; retainedHash=$retained; signedUpdaterTest=$false}
    # Remove only disposable VM's previous .address receipts, not persistent data.
    $cache = Join-Path $env:LOCALAPPDATA 'com.xlang.xharness'
    foreach ($f in @(Get-ChildItem -LiteralPath $cache -Filter '*.address' -File -Recurse -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $f.FullName }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $desktop = Start-Process -FilePath (Join-Path $install 'xharness-desktop.exe') -PassThru
    $ready = $false
    while ($watch.ElapsedMilliseconds -lt 45000 -and -not $desktop.HasExited) {
        $hosts = @(Owned-Processes | Where-Object { $_.Name -eq 'xharness-host.exe' -and $_.ParentProcessId -eq $desktop.Id })
        foreach ($f in @(Get-ChildItem -LiteralPath $cache -Filter '*.address' -File -Recurse -ErrorAction SilentlyContinue)) {
            $address = (Get-Content -LiteralPath $f.FullName -Raw).Trim()
            if ($address -notmatch '^127\.0\.0\.1:[0-9]+$' -or $hosts.Count -ne 1) { continue }
            try { if ((Invoke-WebRequest -UseBasicParsing "http://$address/health/ready" -TimeoutSec 2).StatusCode -eq 200) { $ready = $true; break } } catch { }
        }
        if ($ready) { break }
        Start-Sleep -Milliseconds 150
    }
    $watch.Stop()
    Record 'final-installer-host-ready' @{passed=$ready; elapsedMs=$watch.ElapsedMilliseconds; ownedHostCount=$hosts.Count; desktopExited=$desktop.HasExited}
    Assert-That $ready 'Final installer Host failed readiness'
    # Keep the rendered window open briefly for independent CUA screenshot verification.
    Start-Sleep -Seconds 12
    $hostId = [int]$hosts[0].ProcessId
    Stop-Process -Id $desktop.Id -Force
    Start-Sleep -Seconds 3
    Assert-That (-not (Get-Process -Id $hostId -ErrorAction SilentlyContinue)) 'Host survived desktop crash'
    Record 'final-installer-crash-cleanup' @{passed=$true; hostReaped=$true}
    Assert-ReadOnlyTool
    Record 'clean-vm-acceptance' @{passed=$true; uiScreenshotAcceptance='separate'; toolExecutionAcceptance='read-only-powershell-cwd-and-write-denial'; installerSha256=$audit.installer_sha256}
} catch {
    Record 'clean-vm-acceptance' @{passed=$false; error=$_.Exception.Message}
    throw
} finally { Stop-Owned }
