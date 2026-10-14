# Real NSIS/desktop test. Not a substitute for signed two-hop updater acceptance.
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$RuntimeAudit)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installation ownership acceptance requires a disposable GitHub-hosted Windows runner'
}
$audit = Get-Content -LiteralPath $RuntimeAudit -Raw | ConvertFrom-Json
if ($audit.schema -ne 1 -or $audit.passed -ne $true -or $audit.installer_sha256 -ne (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw 'Dependency audit is not for this exact installer'
}
. "$PSScriptRoot/../apps/desktop/src-tauri/windows/install-ownership.ps1"
$fixture = Join-Path $env:RUNNER_TEMP ('xharness-install-' + [guid]::NewGuid().ToString('N'))
# ASCII source keeps the Unicode path exact under Windows PowerShell 5.1 too.
$unicodeFixture = -join @([char]0x4E2D, [char]0x6587)
$canonical = Join-Path $fixture ('custom path ' + $unicodeFixture)
$legacy = Join-Path ([Environment]::GetFolderPath('Desktop')) 'XHarness'
$data = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'com.xlang.xharness'
$cache = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'com.xlang.xharness'
$legacyLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'XHarness legacy acceptance.lnk'
$nonce = [guid]::NewGuid().ToString('N')
# RUNNER_TEMP can be D: while KnownFolder roots are C:. Quarantine each owned
# root by a same-volume directory rename, never cross-volume copy/delete.
$archivePaths = @($data, $cache) | ForEach-Object {
    Join-Path ([IO.Path]::GetDirectoryName($_)) ('xharness-install-archive-' + $nonce)
}
$evidence = Join-Path $fixture 'result.json'
$owned = [Collections.Generic.List[object]]::new()
$profiles = [Collections.Generic.List[object]]::new()
$archives = [Collections.Generic.List[object]]::new()
$testError = $null; $cleanupError = $null; $result = $null; $fixtureCreated = $false
function Assert-That($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-FixtureNoRedirect([string]$Path, [switch]$Recurse) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            Assert-That (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Refuse redirecting fixture path'
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if ($Recurse -and (Test-Path -LiteralPath $Path)) {
        # Inspect before descending; PS5.1's recursive provider can otherwise
        # enumerate a junction target before we have rejected the junction.
        $pending = [Collections.Generic.Stack[string]]::new()
        $pending.Push($Path)
        while ($pending.Count) {
            foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)) {
                Assert-That (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Refuse redirecting fixture contents'
                if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            }
        }
    }
}
function Assert-FixtureAbsent([string[]]$Paths) {
    foreach ($path in $Paths) {
        Assert-FixtureNoRedirect $path
        Assert-That (-not (Test-Path -LiteralPath $path)) 'Refuse pre-existing fixture namespace'
    }
}
function New-FixtureClaim([string]$Path, [string]$Nonce) {
    Assert-FixtureAbsent @($Path)
    Assert-That ($Nonce -cmatch '^[0-9a-f]{32}$') 'Invalid fixture ownership nonce'
    $path = [IO.Path]::GetFullPath($Path)
    # No -Force: an existing/racing directory is not ours to claim.
    New-Item -ItemType Directory -Path $path -ErrorAction Stop | Out-Null
    Assert-FixtureNoRedirect $path
    $marker = Join-Path $path '.xharness-install-ownership'
    $handle = [IO.File]::Open($marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try {
        $bytes = [Text.Encoding]::ASCII.GetBytes($Nonce)
        $handle.Write($bytes, 0, $bytes.Length); $handle.Flush($true)
        return [pscustomobject]@{ Path = $path; ExpectedPath = $path; Nonce = $Nonce; Marker = $marker;
            MarkerHandle = $handle; Created = (Get-Item -LiteralPath $path -Force).CreationTimeUtc.Ticks; ArchivedTo = $null }
    } catch { $handle.Dispose(); throw }
}
function Assert-FixtureIdentity($Claim, [string]$Location) {
    Assert-That ($null -ne $Claim -and $Claim.Path -ceq $Claim.ExpectedPath -and
        $Claim.Marker -ceq (Join-Path $Claim.ExpectedPath '.xharness-install-ownership') -and
        $Claim.Nonce -cmatch '^[0-9a-f]{32}$') 'Missing or changed fixture ownership ledger'
    Assert-FixtureNoRedirect $Location -Recurse
    $directory = Get-Item -LiteralPath $Location -Force
    Assert-That ($directory.PSIsContainer -and $directory.CreationTimeUtc.Ticks -eq $Claim.Created) 'Fixture root identity changed'
    $markerPath = Join-Path $Location '.xharness-install-ownership'
    $marker = Get-Item -LiteralPath $markerPath -Force
    Assert-That (-not $marker.PSIsContainer -and $marker.Length -eq 32) 'Fixture ownership marker missing or changed'
    # The retained marker denies write/delete sharing on Windows, pinning the
    # claim until all roots have been validated and are ready for rename.
    $reader = [IO.File]::Open($markerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $bytes = New-Object byte[] 32
        Assert-That ($reader.Read($bytes, 0, 32) -eq 32 -and [Text.Encoding]::ASCII.GetString($bytes) -ceq $Claim.Nonce) 'Fixture ownership marker changed'
    } finally { $reader.Dispose() }
}
function Assert-FixtureClaim($Claim) {
    Assert-That ($null -ne $Claim -and $null -ne $Claim.MarkerHandle -and $Claim.MarkerHandle.CanRead) 'Missing or changed fixture ownership ledger'
    Assert-FixtureIdentity $Claim $Claim.Path
}
function Add-OwnedFixtureProcess($Process, [string]$ExpectedPath) {
    $null = $Process.Handle # Retain the real process identity, not just a recyclable PID.
    $start = if ($Process.HasExited) { $null } else { $Process.StartTime.ToUniversalTime().Ticks }
    $owned.Add([pscustomobject]@{ Process = $Process; Path = [IO.Path]::GetFullPath($ExpectedPath); Started = $start })
}
function Stop-OwnedFixtureProcesses {
    foreach ($record in $owned) {
        $process = $record.Process
        if ($process.HasExited) { continue }
        Assert-That ($null -ne $record.Started -and $process.StartTime.ToUniversalTime().Ticks -eq $record.Started -and
            $process.Path -ieq $record.Path) 'Fixture process identity is uncertain; refusing termination'
        $process.Kill()
        Assert-That ($process.WaitForExit(15000)) 'Fixture process failed to stop'
    }
}
function Assert-FixtureQuiescent {
    foreach ($record in $owned) { Assert-That $record.Process.HasExited 'Fixture process is still running' }
    # Another same-user installation shares these KnownFolders. Never move its
    # data or kill it: uncertain/live process inventory makes cleanup fail closed.
    Assert-That (@(Get-XHarnessProcesses -Directories @($canonical, $legacy)).Count -eq 0) 'Application-data writer is still running or uncertain'
}
function Move-FixtureProfile([string]$Source, [string]$Destination) {
    [IO.Directory]::Move($Source, $Destination)
}
function Assert-FixtureIsolationState([string[]]$Destinations) {
    Assert-FixtureQuiescent
    Assert-That ($profiles.Count -eq 2 -and $archives.Count -eq 2 -and $Destinations.Count -eq 2) 'Incomplete fixture ownership ledger'
    for ($i = 0; $i -lt 2; $i++) {
        Assert-FixtureClaim $archives[$i]
        Assert-That ($Destinations[$i] -ceq (Join-Path $archives[$i].Path 'profile') -and
            [IO.Path]::GetPathRoot($profiles[$i].Path) -ieq [IO.Path]::GetPathRoot($Destinations[$i])) 'Profile archive destination changed'
        if ($profiles[$i].ArchivedTo) {
            Assert-That ($profiles[$i].ArchivedTo -ceq $Destinations[$i]) 'Profile archive ledger changed'
            Assert-FixtureAbsent @($profiles[$i].Path)
            Assert-FixtureIdentity $profiles[$i] $Destinations[$i]
        } else {
            Assert-FixtureIdentity $profiles[$i] $profiles[$i].Path
            Assert-FixtureAbsent @($Destinations[$i])
        }
    }
}
function Resolve-FixtureMoveOutcome($Claim, [string]$Destination) {
    $sourceExists = Test-Path -LiteralPath $Claim.Path
    $destinationExists = Test-Path -LiteralPath $Destination
    if ($sourceExists -and -not $destinationExists) { return $false }
    Assert-That (-not $sourceExists -and $destinationExists) 'Fixture move left ambiguous source/destination state'
    # A rename may have completed before an error was surfaced. Validate its
    # exact preserved identity and record it; never repeat a completed move.
    Assert-FixtureAbsent @($Claim.Path)
    Assert-FixtureIdentity $Claim $Destination
    $Claim.ArchivedTo = $Destination
    return $true
}
function Test-FixtureTransientMoveError($Failure) {
    $exception = $Failure.Exception.GetBaseException()
    # Win32 access denied, sharing violation, lock violation only. An ACL denial
    # also expires as failure; neither this nor a cache handle justifies deletion.
    return (($exception -is [IO.IOException] -or $exception -is [UnauthorizedAccessException]) -and
        (($exception.HResult -band 0xFFFF0000) -eq 0x80070000) -and
        (($exception.HResult -band 0xFFFF) -in @(5, 32, 33)))
}
function Complete-FixtureIsolation {
    Stop-OwnedFixtureProcesses
    Assert-FixtureQuiescent
    Assert-That ($profiles.Count -eq 2 -and $archives.Count -eq 2) 'Incomplete fixture ownership ledger'
    $destinations = @()
    for ($i = 0; $i -lt 2; $i++) {
        Assert-FixtureClaim $profiles[$i]
        Assert-FixtureClaim $archives[$i]
        $destination = Join-Path $archives[$i].Path 'profile'
        Assert-FixtureAbsent @($destination)
        Assert-That ([IO.Path]::GetPathRoot($profiles[$i].Path) -ieq [IO.Path]::GetPathRoot($destination)) 'Profile archive must be on the same volume'
        $destinations += $destination
    }
    # Validate BOTH roots/destinations and process state before the first move.
    foreach ($claim in $profiles) { $claim.MarkerHandle.Dispose() }
    # Retain the existing 40-second waiting budget, shared by BOTH renames.
    # Desktop/Host exit does not prove every Windows cache handle is released.
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    for ($i = 0; $i -lt 2; $i++) {
        while (-not $profiles[$i].ArchivedTo) {
            # Revalidate both sources until the first move, then the preserved
            # first archive and remaining source, including all writer guards.
            Assert-FixtureIsolationState $destinations
            Assert-That ([DateTime]::UtcNow -lt $deadline) 'Fixture profile rename remained locked after the 40-second isolation budget'
            try {
                Move-FixtureProfile $profiles[$i].Path $destinations[$i]
            } catch {
                $failure = $_
                $completed = Resolve-FixtureMoveOutcome $profiles[$i] $destinations[$i]
                Assert-FixtureIsolationState $destinations
                if (-not (Test-FixtureTransientMoveError $failure)) { throw $failure }
                if ($completed) { break }
                Assert-That ([DateTime]::UtcNow -lt $deadline) 'Fixture profile rename remained locked after the 40-second isolation budget'
                Start-Sleep -Milliseconds 200
                continue
            }
            Assert-That (Resolve-FixtureMoveOutcome $profiles[$i] $destinations[$i]) 'Fixture profile rename did not release its source'
        }
    }
    Assert-FixtureIsolationState $destinations
    foreach ($claim in $profiles) {
        Assert-That (-not (Test-Path -LiteralPath $claim.Path)) 'Original application namespace was not released'
        Assert-FixtureNoRedirect $claim.ArchivedTo -Recurse
    }
}
function New-FixtureReceipt($Result, $TestFailure, $IsolationFailure) {
    if ($null -eq $Result) { $Result = @{} }
    $Result.passed = ($null -eq $TestFailure -and $null -eq $IsolationFailure)
    $Result.fixtureNonce = $nonce
    $Result.profileArchives = @($profiles | ForEach-Object { @{ original = $_.Path; archivedTo = $_.ArchivedTo } })
    $Result.testError = if ($TestFailure) { $TestFailure.Exception.Message } else { $null }
    $Result.cleanupError = if ($IsolationFailure) { $IsolationFailure.Exception.Message } else { $null }
    return $Result
}
function Assert-PeSubsystem([string]$Path, [int]$Expected) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    Assert-That ($bytes.Length -ge 64 -and [BitConverter]::ToUInt16($bytes, 0) -eq 0x5A4D) "Invalid DOS header: $Path"
    $pe = [BitConverter]::ToInt32($bytes, 60)
    Assert-That ($pe -ge 64 -and $pe -le $bytes.Length - 94) "Invalid PE offset: $Path"
    Assert-That ([BitConverter]::ToUInt32($bytes, $pe) -eq 0x4550) "Invalid PE signature: $Path"
    $magic = [BitConverter]::ToUInt16($bytes, $pe + 24)
    Assert-That ($magic -in @(0x10B, 0x20B)) "Invalid optional header: $Path"
    # Subsystem has the same offset in PE32 and PE32+ optional headers.
    $actual = [BitConverter]::ToUInt16($bytes, $pe + 24 + 68)
    Assert-That ($actual -eq $Expected) "Unexpected PE subsystem $actual (expected $Expected): $Path"
}
function Wait-Until([scriptblock]$Check, [string]$Message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do { if (& $Check) { return }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline)
    throw $Message
}
function Install-TestCopy([bool]$ExpectedSuccess) {
    $process = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$canonical") -WindowStyle Hidden -PassThru
    Add-OwnedFixtureProcess $process $Installer
    if (-not $process.WaitForExit(90000)) { throw 'NSIS installation timed out' }
    Assert-That (($process.ExitCode -eq 0) -eq $ExpectedSuccess) "Unexpected installer exit: $($process.ExitCode)"
}
function Assert-InstalledPayload {
    foreach ($module in $audit.modules) {
        $path = Join-Path $canonical $module.path
        Assert-That ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $module.sha256) "Installed payload is stale or mixed: $($module.path)"
    }
    Assert-That ($null -ne $audit.powershell) 'Missing bundled PowerShell acceptance receipt'
    $runtimeRoot = Join-Path $canonical 'runtime/powershell'
    Assert-That ((Get-FileHash -LiteralPath (Join-Path $runtimeRoot 'manifest.json')).Hash.ToLowerInvariant() -eq $audit.powershell.manifest_sha256) 'Installed PowerShell manifest differs from audited installer'
    foreach ($file in $audit.powershell.files.PSObject.Properties) {
        Assert-That ((Get-FileHash -LiteralPath (Join-Path $runtimeRoot $file.Name)).Hash.ToLowerInvariant() -eq $file.Value.sha256) "Installed runtime is stale or mixed: $($file.Name)"
    }
}
function Start-TestCopy([string]$Directory) {
    $process = Start-Process -FilePath (Join-Path $Directory 'xharness-desktop.exe') -WindowStyle Hidden -PassThru
    Add-OwnedFixtureProcess $process (Join-Path $Directory 'xharness-desktop.exe')
    return $process
}
function Host-Children([int]$Parent) {
    @(Get-CimInstance Win32_Process -Filter "Name='xharness-host.exe'" | Where-Object ParentProcessId -eq $Parent)
}
function Owned-Host($Desktop, [string]$Directory) {
    $children = @(Host-Children $Desktop.Id)
    Assert-That ($children.Count -eq 1) 'Expected one fixture-owned Host'
    $child = $children[0]
    Assert-That ($child.ExecutablePath -ieq (Join-Path $Directory 'xharness-host.exe') -and $null -ne $child.CreationDate) 'Uncertain fixture Host identity'
    $process = Get-Process -Id $child.ProcessId -ErrorAction Stop
    $null = $process.Handle
    # Opening the retained handle can race a CIM snapshot. Confirm the same
    # creation/path/parent identity before putting this process in the kill ledger.
    $current = @(Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)" -ErrorAction Stop)
    Assert-That (-not $process.HasExited -and $current.Count -eq 1 -and
        $current[0].CreationDate -eq $child.CreationDate -and $current[0].ExecutablePath -ieq $child.ExecutablePath -and
        $current[0].ParentProcessId -eq $Desktop.Id) 'Fixture Host changed before its handle was retained'
    Add-OwnedFixtureProcess $process $child.ExecutablePath
    $child | Add-Member -NotePropertyName FixtureProcess -NotePropertyValue $process
    return $child
}
function Initialize-FixtureCommandLine {
    if ('XHarnessAcceptance.CommandLine' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace XHarnessAcceptance {
    public static class CommandLine {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW(string text, out int count);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr value);
        public static string[] Parse(string text) {
            if (String.IsNullOrEmpty(text) || text.Length > 32768) throw new ArgumentException("Invalid fixture Host command line");
            int count;
            IntPtr argv = CommandLineToArgvW(text, out count);
            if (argv == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                string[] result = new string[count];
                for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
                return result;
            } finally { LocalFree(argv); }
        }
    }
}
'@
}
function Get-FixtureReadyFile([string]$CommandLine, [string]$Runtime) {
    Initialize-FixtureCommandLine
    $arguments = [XHarnessAcceptance.CommandLine]::Parse($CommandLine)
    $matches = @()
    for ($i = 1; $i -lt $arguments.Count; $i++) {
        if ($arguments[$i] -ceq '--ready-file') {
            Assert-That ($i + 1 -lt $arguments.Count) 'Missing fixture readiness argument'
            $matches += $arguments[$i + 1]
        }
    }
    Assert-That ($matches.Count -eq 1) 'Ambiguous fixture readiness argument'
    $path = [IO.Path]::GetFullPath($matches[0])
    Assert-That ([IO.Path]::GetDirectoryName($path) -ieq [IO.Path]::GetFullPath($Runtime) -and
        [IO.Path]::GetFileName($path) -cmatch '^ready-[0-9a-f]{64}\.address$') 'Fixture readiness file is outside the claimed runtime'
    return $path
}
function Host-Ready($ExpectedHost) {
    Assert-FixtureClaim $profiles[1]
    $current = @(Get-CimInstance Win32_Process -Filter "ProcessId=$($ExpectedHost.ProcessId)" -ErrorAction Stop)
    if ($current.Count -ne 1) { return $false }
    Assert-That ($current[0].ParentProcessId -eq $ExpectedHost.ParentProcessId -and
        $current[0].CreationDate -eq $ExpectedHost.CreationDate -and $current[0].ExecutablePath -ieq $ExpectedHost.ExecutablePath) 'Fixture Host identity changed'
    $runtime = Join-Path $profiles[1].Path 'runtime'
    $readyPath = Get-FixtureReadyFile $current[0].CommandLine $runtime
    Assert-FixtureNoRedirect $readyPath
    if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) { return $false }
    $ready = Get-Item -LiteralPath $readyPath -Force
    Assert-That ($ready.Length -le 64) 'Invalid fixture readiness file'
    $address = (Get-Content -LiteralPath $readyPath -Raw).Trim()
    if ($address -notmatch '^127\.0\.0\.1:[0-9]+$') { return $false }
    $port = [int]$address.Split(':')[1]
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $ExpectedHost.ProcessId) { return $false }
    try {
        $reply = Invoke-WebRequest -Uri "http://$address/health/ready" -UseBasicParsing -TimeoutSec 2
        $body = $reply.Content | ConvertFrom-Json
        if ($reply.StatusCode -eq 200 -and $body.ok -eq $true -and $body.service -eq 'xharness-host' -and $body.state -eq 'ready') { return $true }
    } catch { }
    return $false
}
try {
    Assert-FixtureAbsent @($fixture, $legacy, $legacyLink, $data, $cache, $archivePaths[0], $archivePaths[1])
    New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null
    $fixtureCreated = $true
    # These are real Windows KnownFolders, not APPDATA environment overrides.
    # Refuse an existing root; never consume/delete/claim another test's data.
    foreach ($path in @($data, $cache)) { $profiles.Add((New-FixtureClaim $path $nonce)) }
    foreach ($path in $archivePaths) { $archives.Add((New-FixtureClaim $path $nonce)) }
    Install-TestCopy $true
    Assert-InstalledPayload
    Assert-That (Test-Path -LiteralPath (Join-Path $canonical 'xharness-desktop.exe')) 'Custom installation path changed'
    # Inspect installed payload: Start-Process -WindowStyle Hidden alone would
    # mask an accidental console-subsystem regression in the desktop executable.
    Assert-PeSubsystem (Join-Path $canonical 'xharness-desktop.exe') 2
    Assert-PeSubsystem (Join-Path $canonical 'xharness-host.exe') 3
    # Assert the actual NSIS payload, not only the source-side resource manifest.
    foreach ($relative in @('index.html', 'client-graph.json', 'plugins/@xlang/xharness-client-ui-directory/client.js')) {
        $installed = Join-Path (Join-Path $canonical 'web') $relative
        $expected = Join-Path "$PSScriptRoot/../ui/dist" $relative
        Assert-That ((Get-FileHash -LiteralPath $installed).Hash -eq (Get-FileHash -LiteralPath $expected).Hash) "Packaged workspace directory UI is stale: $relative"
    }
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
    $firstHost = Owned-Host $first $legacy
    Wait-Until { Host-Ready $firstHost } 'First Host failed readiness after startup gate'
    $second = Start-TestCopy $canonical
    Assert-That ($second.WaitForExit(15000)) 'Second installation launched a competing desktop'
    Assert-That ($second.ExitCode -eq 0) 'Second desktop crashed instead of forwarding to the owner'
    Assert-That (-not $first.HasExited) 'Duplicate launch terminated the owner'
    Assert-That (@(Host-Children $first.Id).Count -eq 1) 'Duplicate launch changed Host count'

    Install-TestCopy $false
    Assert-That (-not $first.HasExited) 'Installer killed a live old desktop'
    Assert-That ((Get-FileHash -LiteralPath $sentinel).Hash -eq $before) 'Blocked install changed data'
    # Exact process created in this fixture. Deliberately simulate an App crash,
    # not taskkill /T: the Job must reap the Host on its own.
    $first.Kill()
    Assert-That ($first.WaitForExit(15000)) 'Desktop crash fixture failed to stop'
    Wait-Until { $firstHost.FixtureProcess.HasExited } 'Host survived desktop crash'

    Install-TestCopy $true
    Assert-InstalledPayload
    Assert-That ([XHarnessInstaller.Shortcuts]::Read($legacyLink).TargetPath -ieq (Join-Path $canonical 'xharness-desktop.exe')) 'Old shortcut was not reconciled'
    foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe')) {
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $legacy $name))) 'Legacy executable remains launchable'
        Assert-That (Test-Path -LiteralPath (Join-Path $legacy ($name + '.before-xharness-update'))) 'Recovery binary missing'
    }
    $replacement = Start-TestCopy $canonical
    Wait-Until { @(Host-Children $replacement.Id).Count -eq 1 } 'Replacement could not start Host'
    $replacementHost = Owned-Host $replacement $canonical
    Wait-Until { Host-Ready $replacementHost } 'Replacement Host failed readiness'
    Assert-That ((Get-FileHash -LiteralPath $sentinel).Hash -eq $before) 'Reinstall changed data'
    $result = @{ signedUpdaterTest = $false; customPath = $canonical; duplicateLaunch = $true;
       installedPayloadHashes = $true; installerSha256 = $audit.installer_sha256; desktopGuiSubsystem = $true; hostCliSubsystem = $true;
       liveInstallBlocked = $true; hostReapedOnCrash = $true; shortcutRetargeted = $true;
       legacyRetiredRecoverably = $true; retainedHash = $before }
} catch {
    $testError = $_
} finally {
    if (Test-Path -LiteralPath (Join-Path $env:TEMP 'XHarness-installation.log')) {
        Get-Content -LiteralPath (Join-Path $env:TEMP 'XHarness-installation.log')
    }
    try { Complete-FixtureIsolation } catch { $cleanupError = $_ }
    foreach ($claim in ($profiles.ToArray() + $archives.ToArray())) {
        if ($claim.MarkerHandle) { $claim.MarkerHandle.Dispose() }
    }
    if ($fixtureCreated -and (Test-Path -LiteralPath $fixture -PathType Container)) {
        Assert-FixtureNoRedirect $fixture
        $result = New-FixtureReceipt $result $testError $cleanupError
        $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $evidence
        New-Item -ItemType Directory -Force -Path 'dist/install-ownership-evidence' | Out-Null
        Copy-Item -LiteralPath $evidence -Destination 'dist/install-ownership-evidence/result.json'
        Get-Content -LiteralPath $evidence
    }
}
if ($testError -or $cleanupError) {
    throw ('Installation ownership acceptance failed. Test: ' + $(if ($testError) { $testError.Exception.Message } else { 'none' }) +
        '; isolation: ' + $(if ($cleanupError) { $cleanupError.Exception.Message } else { 'none' }))
}
