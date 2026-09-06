# Real NSIS/desktop test. Not a substitute for signed two-hop updater acceptance.
param([Parameter(Mandatory)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installation ownership acceptance requires a disposable GitHub-hosted Windows runner'
}
. "$PSScriptRoot/../apps/desktop/src-tauri/windows/install-ownership.ps1"
$fixture = Join-Path $env:RUNNER_TEMP ('xharness-install-' + [guid]::NewGuid().ToString('N'))
$canonical = Join-Path $fixture 'custom path 中文'
$legacy = Join-Path ([Environment]::GetFolderPath('Desktop')) 'XHarness'
$data = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.xlang.xharness'
$legacyLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'XHarness legacy acceptance.lnk'
foreach ($directory in @($fixture, $legacy, $data)) {
    if (Test-Path -LiteralPath $directory) { throw "Refuse pre-existing fixture: $directory" }
}
New-Item -ItemType Directory -Path $fixture | Out-Null
$evidence = Join-Path $fixture 'result.json'
$owned = [Collections.Generic.List[int]]::new()
function Assert-That($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Wait-Until([scriptblock]$Check, [string]$Message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do { if (& $Check) { return }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline)
    throw $Message
}
function Install-TestCopy([bool]$ExpectedSuccess) {
    $process = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$canonical") -WindowStyle Hidden -PassThru
    $owned.Add($process.Id)
    if (-not $process.WaitForExit(90000)) { throw 'NSIS installation timed out' }
    Assert-That (($process.ExitCode -eq 0) -eq $ExpectedSuccess) "Unexpected installer exit: $($process.ExitCode)"
}
function Start-TestCopy([string]$Directory) {
    $process = Start-Process -FilePath (Join-Path $Directory 'xharness-desktop.exe') -WindowStyle Hidden -PassThru
    $owned.Add($process.Id)
    return $process
}
function Host-Children([int]$Parent) {
    @(Get-CimInstance Win32_Process -Filter "Name='xharness-host.exe'" | Where-Object ParentProcessId -eq $Parent)
}
function Host-Ready {
    $cache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'com.xlang.xharness'
    foreach ($ready in @(Get-ChildItem -LiteralPath $cache -Filter '*.address' -File -Recurse -ErrorAction SilentlyContinue)) {
        $address = (Get-Content -LiteralPath $ready.FullName -Raw).Trim()
        if ($address -notmatch '^127\.0\.0\.1:[0-9]+$') { continue }
        try {
            $reply = Invoke-WebRequest -Uri "http://$address/health/ready" -TimeoutSec 2
            if ($reply.StatusCode -eq 200) { return $true }
        } catch { }
    }
    return $false
}
try {
    Install-TestCopy $true
    Assert-That (Test-Path -LiteralPath (Join-Path $canonical 'xharness-desktop.exe')) 'Custom installation path changed'
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $sentinel = Join-Path $data 'retained-dialogue-fixture.txt'
    [IO.File]::WriteAllText($sentinel, 'Conversation/config retention fixture; no real credentials')
    $before = (Get-FileHash -LiteralPath $sentinel).Hash
    Copy-Item -LiteralPath $canonical -Destination $legacy -Recurse
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($legacyLink)
    $link.TargetPath = Join-Path $legacy 'xharness-desktop.exe'
    $link.Save()

    $first = Start-TestCopy $legacy
    Wait-Until { @(Host-Children $first.Id).Count -eq 1 } 'First desktop did not start its Host'
    Wait-Until { Host-Ready } 'First Host failed readiness after startup gate'
    $hostPid = @(Host-Children $first.Id)[0].ProcessId
    $owned.Add([int]$hostPid)
    $second = Start-TestCopy $canonical
    Assert-That ($second.WaitForExit(15000)) 'Second installation launched a competing desktop'
    Assert-That (-not $first.HasExited) 'Duplicate launch terminated the owner'
    Assert-That (@(Host-Children $first.Id).Count -eq 1) 'Duplicate launch changed Host count'

    Install-TestCopy $false
    Assert-That (-not $first.HasExited) 'Installer killed a live old desktop'
    Assert-That ((Get-FileHash -LiteralPath $sentinel).Hash -eq $before) 'Blocked install changed data'
    # Exact process created in this fixture. Deliberately simulate an App crash,
    # not taskkill /T: the Job must reap the Host on its own.
    Stop-Process -Id $first.Id -Force
    Wait-Until { -not (Get-Process -Id $hostPid -ErrorAction SilentlyContinue) } 'Host survived desktop crash'

    Install-TestCopy $true
    Assert-That ([XHarnessInstaller.Shortcuts]::Read($legacyLink).TargetPath -ieq (Join-Path $canonical 'xharness-desktop.exe')) 'Old shortcut was not reconciled'
    foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe')) {
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $legacy $name))) 'Legacy executable remains launchable'
        Assert-That (Test-Path -LiteralPath (Join-Path $legacy ($name + '.before-xharness-update'))) 'Recovery binary missing'
    }
    $replacement = Start-TestCopy $canonical
    Wait-Until { @(Host-Children $replacement.Id).Count -eq 1 } 'Replacement could not start Host'
    Wait-Until { Host-Ready } 'Replacement Host failed readiness'
    Assert-That ((Get-FileHash -LiteralPath $sentinel).Hash -eq $before) 'Reinstall changed data'
    @{ passed = $true; signedUpdaterTest = $false; customPath = $canonical; duplicateLaunch = $true;
       liveInstallBlocked = $true; hostReapedOnCrash = $true; shortcutRetargeted = $true;
       legacyRetiredRecoverably = $true; retainedHash = $before } | ConvertTo-Json | Set-Content -LiteralPath $evidence
    Get-Content -LiteralPath $evidence
} finally {
    if (Test-Path -LiteralPath (Join-Path $env:TEMP 'XHarness-installation.log')) {
        Get-Content -LiteralPath (Join-Path $env:TEMP 'XHarness-installation.log')
    }
    # Exact PIDs owned by this disposable fixture; no image-name-wide termination.
    foreach ($id in $owned) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($process -and $process.Path -and (
            $process.Path.StartsWith($fixture + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $process.Path.StartsWith($legacy + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $process.Path -ieq $Installer)) {
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
    }
    New-Item -ItemType Directory -Force -Path 'dist/install-ownership-evidence' | Out-Null
    if (Test-Path -LiteralPath $evidence) { Copy-Item -LiteralPath $evidence -Destination 'dist/install-ownership-evidence/result.json' }
}
