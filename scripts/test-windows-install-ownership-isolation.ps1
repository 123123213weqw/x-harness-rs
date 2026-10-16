# Pure filesystem/process-negative fixtures. No installer, application launch,
# KnownFolder enumeration, registry changes, or Rust compilation.
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$source = Join-Path $PSScriptRoot 'test-windows-install-ownership.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($fn in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('xharness-isolation-unit-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$unicodeFixture = -join @([char]0x4E2D, [char]0x6587)
$script:checks = 0; $script:serial = 0; $script:moves = 0; $script:inventoryMode = 'empty'
function Check($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Blocked([scriptblock]$Action, [string]$Pattern) {
    $failure = $null
    try { & $Action | Out-Null } catch { $failure = $_ }
    Check ($null -ne $failure -and $failure.Exception.Message -match $Pattern) ('Expected refusal: ' + $Pattern)
    return $failure
}
function Get-XHarnessProcesses {
    if ($script:inventoryMode -eq 'uncertain') { throw 'fixture inventory unavailable' }
    if ($script:inventoryMode -eq 'live') { [pscustomobject]@{ ProcessId = 4242 } }
}
$moveFunction = (Get-Item Function:Move-FixtureProfile).ScriptBlock
$stopFunction = (Get-Item Function:Stop-OwnedFixtureProcesses).ScriptBlock
function New-TestClaims {
    $script:serial++
    $script:nonce = [guid]::NewGuid().ToString('N')
    $script:fixture = Join-Path $root ('case-' + $script:serial)
    New-Item -ItemType Directory -Path $fixture | Out-Null
    $script:canonical = Join-Path $fixture 'install'; $script:legacy = Join-Path $fixture 'legacy'
    $script:owned = [Collections.Generic.List[object]]::new()
    $script:profiles = [Collections.Generic.List[object]]::new()
    $script:archives = [Collections.Generic.List[object]]::new()
    $script:inventoryMode = 'empty'; $script:moves = 0
    Set-Item Function:script:Move-FixtureProfile $moveFunction
    Set-Item Function:script:Stop-OwnedFixtureProcesses $stopFunction
    foreach ($name in @(('data ' + $unicodeFixture), 'cache [literal]')) { $profiles.Add((New-FixtureClaim (Join-Path $fixture $name) $nonce)) }
    foreach ($name in @('archive-data', 'archive-cache')) { $archives.Add((New-FixtureClaim (Join-Path $fixture $name) $nonce)) }
    foreach ($claim in $profiles) { [IO.File]::WriteAllText((Join-Path $claim.Path 'retained.txt'), 'not user data: preserve exact fixture bytes') }
}
function Close-TestClaims {
    foreach ($claim in ($profiles.ToArray() + $archives.ToArray())) { if ($claim.MarkerHandle) { $claim.MarkerHandle.Dispose() } }
}
function Check-Originals {
    foreach ($claim in $profiles) { Check (Test-Path -LiteralPath $claim.Path -PathType Container) 'Refused cleanup moved an original root' }
    foreach ($claim in $archives) { Check (-not (Test-Path -LiteralPath (Join-Path $claim.Path 'profile'))) 'Refused cleanup touched an archive destination' }
}
# A real Windows deny-delete handle, released by a C# thread (no PowerShell
# scriptblock on a thread without a runspace). It touches only this unit's root.
if (-not ('XHarnessAcceptance.DelayedFileLock' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
namespace XHarnessAcceptance {
    public sealed class DelayedFileLock : IDisposable {
        private readonly FileStream stream;
        private Thread worker;
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private readonly ManualResetEvent released = new ManualResetEvent(false);
        public DelayedFileLock(string path) {
            stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
        }
        public void ReleaseAfter(int milliseconds) {
            if (worker != null) throw new InvalidOperationException("Release already scheduled");
            worker = new Thread(delegate() {
                try { stop.WaitOne(milliseconds); }
                finally { stream.Dispose(); released.Set(); }
            });
            worker.IsBackground = true;
            worker.Start();
        }
        public bool IsReleased { get { return released.WaitOne(0); } }
        public void Dispose() {
            stop.Set();
            if (worker != null) worker.Join();
            else { stream.Dispose(); released.Set(); }
            released.Dispose(); stop.Dispose();
        }
    }
}
'@
}
try {
    # Exact positive control: same-volume rename releases both namespaces while
    # preserving every sentinel byte, rather than deleting application data.
    New-TestClaims
    Complete-FixtureIsolation
    foreach ($claim in $profiles) {
        Check (-not (Test-Path -LiteralPath $claim.Path)) 'Original namespace not released'
        Check ((Get-Content -LiteralPath (Join-Path $claim.ArchivedTo 'retained.txt') -Raw) -ceq 'not user data: preserve exact fixture bytes') 'Fixture bytes lost'
    }
    Check (New-FixtureReceipt @{ retainedHash = 'fixture-hash' } $null $null).passed 'Successful isolation not receipted'
    Close-TestClaims

    # Mirror the native failure: the first root moves, the second holds a real
    # cache handle. Only that second move may retry after the handle is released.
    New-TestClaims
    $lockPath = Join-Path $profiles[1].Path 'held-cache.bin'
    $delayed = [XHarnessAcceptance.DelayedFileLock]::new($lockPath)
    try {
        $destination = Join-Path $archives[1].Path 'profile'
        # Remove only the unit's marker pin for this raw probe, so the separate
        # held-cache.bin handle (not the marker itself) proves the native lock.
        $profiles[1].MarkerHandle.Dispose()
        try {
            $locked = Blocked { [IO.Directory]::Move($profiles[1].Path, $destination) } 'denied|used by another process'
        } finally {
            $profiles[1].MarkerHandle = [IO.File]::Open($profiles[1].Marker, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        }
        Assert-FixtureClaim $profiles[1]
        Check (Test-FixtureTransientMoveError $locked) 'Real deny-delete lock was not classified as a Win32 rename lock'
        Check (-not (Test-Path -LiteralPath $destination)) 'Locked raw move changed the destination'
        $script:firstMoves = 0; $script:secondMoves = 0
        function Move-FixtureProfile {
            param($Source, $Destination)
            $script:moves++
            if ($Source -ceq $profiles[0].Path) { $script:firstMoves++ } else { $script:secondMoves++ }
            [IO.Directory]::Move($Source, $Destination)
        }
        $delayed.ReleaseAfter(2000)
        Complete-FixtureIsolation
        Check ($delayed.IsReleased -and $script:moves -gt 2) 'Delayed Windows handle release did not exercise a real rename retry'
        Check ($script:firstMoves -eq 1 -and $script:secondMoves -gt 1) 'Delayed release repeated an already archived root'
        Check ((New-FixtureReceipt @{} $null $null).passed) 'Delayed release falsely failed isolation'
        foreach ($claim in $profiles) {
            Check (-not (Test-Path -LiteralPath $claim.Path)) 'Delayed release left original namespace'
            Check ((Get-Content -LiteralPath (Join-Path $claim.ArchivedTo 'retained.txt') -Raw) -ceq 'not user data: preserve exact fixture bytes') 'Delayed release lost fixture bytes'
        }
    } finally { $delayed.Dispose(); Close-TestClaims }

    # Reconcile a completed rename even if a transient exception is surfaced
    # afterward; never retry the now-missing original source.
    New-TestClaims
    function Move-FixtureProfile {
        param($Source, $Destination)
        $script:moves++
        [IO.Directory]::Move($Source, $Destination)
        if ($script:moves -eq 1) { throw [UnauthorizedAccessException]::new('synthetic error after completed rename') }
    }
    Complete-FixtureIsolation
    Check ($script:moves -eq 2 -and (New-FixtureReceipt @{} $null $null).passed) 'Completed rename was repeated or lost from the receipt'
    Close-TestClaims
    foreach ($hresult in @(-2147483643, -2147024894)) {
        $unrelated = [pscustomobject]@{ Exception = [IO.IOException]::new('synthetic unrelated HRESULT', $hresult) }
        Check (-not (Test-FixtureTransientMoveError $unrelated)) 'Non-Win32 or unrelated error was accepted for retry'
    }

    # A persistent real handle must exhaust the unchanged shared 40s budget,
    # retain the remaining source, and never manufacture a passed receipt.
    New-TestClaims
    $persistent = [IO.File]::Open((Join-Path $profiles[1].Path 'held-cache.bin'), [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    $started = [DateTime]::UtcNow
    try {
        $failure = Blocked { Complete-FixtureIsolation } '40-second isolation budget'
        Check (([DateTime]::UtcNow - $started).TotalSeconds -ge 40) 'Persistent handle bypassed the full isolation deadline'
        Check ($null -ne $profiles[0].ArchivedTo -and -not (Test-Path -LiteralPath $profiles[0].Path)) 'Persistent second-root lock corrupted the first archive'
        Check (Test-Path -LiteralPath $profiles[1].Path -PathType Container) 'Persistent handle lost the second source'
        Check (-not (Test-Path -LiteralPath (Join-Path $archives[1].Path 'profile'))) 'Persistent handle created an ambiguous destination'
        Check (-not (New-FixtureReceipt @{} $null $failure).passed) 'Persistent handle produced a passed receipt'
    } finally { $persistent.Dispose(); Close-TestClaims }

    # Change a SECOND-root identity after a real FIRST-root lock refusal. Both
    # sources must be revalidated before retrying, with immediate failure.
    foreach ($identity in @('marker', 'creation')) {
        New-TestClaims
        $persistent = [IO.File]::Open((Join-Path $profiles[0].Path 'held-cache.bin'), [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        try {
            function Move-FixtureProfile {
                param($Source, $Destination)
                $script:moves++
                try { [IO.Directory]::Move($Source, $Destination) } catch {
                    if ($identity -eq 'marker') {
                        [IO.File]::WriteAllText($profiles[1].Marker, ('0' * 32))
                    } else {
                        $changed = [DateTime]::new([long]$profiles[1].Created, [DateTimeKind]::Utc).AddSeconds(1)
                        [IO.Directory]::SetCreationTimeUtc($profiles[1].Path, $changed)
                    }
                    throw
                }
            }
            $failure = Blocked { Complete-FixtureIsolation } 'marker changed|root identity changed'
            Check ($script:moves -eq 1) 'Changed fixture identity was retried'
            Check-Originals
            Check (-not (New-FixtureReceipt @{} $null $failure).passed) 'Changed identity produced a passed receipt'
        } finally { $persistent.Dispose(); Close-TestClaims }
    }

    # A writer/inventory uncertainty or destination conflict appearing after a
    # lock failure must fail immediately, not disappear behind blind retries.
    foreach ($change in @('live', 'uncertain', 'destination')) {
        New-TestClaims
        $persistent = [IO.File]::Open((Join-Path $profiles[0].Path 'held-cache.bin'), [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        try {
            function Move-FixtureProfile {
                param($Source, $Destination)
                $script:moves++
                try { [IO.Directory]::Move($Source, $Destination) } catch {
                    if ($change -eq 'destination') {
                        New-Item -ItemType Directory -Path (Join-Path $archives[1].Path 'profile') | Out-Null
                    } else { $script:inventoryMode = $change }
                    throw
                }
            }
            $failure = Blocked { Complete-FixtureIsolation } 'writer|inventory|pre-existing'
            Check ($script:moves -eq 1) 'Changed writer/destination state was blindly retried'
            foreach ($claim in $profiles) { Check (Test-Path -LiteralPath $claim.Path) 'Changed state moved a source' }
            Check (-not (Test-Path -LiteralPath (Join-Path $archives[0].Path 'profile'))) 'Changed state moved the first root'
            Check (-not (New-FixtureReceipt @{} $null $failure).passed) 'Changed state produced a passed receipt'
        } finally { $persistent.Dispose(); Close-TestClaims }
    }

    # Pre-existing data/cache may contain genuine user files. Neither root may
    # be claimed, modified, archived, or deleted by this fixture.
    foreach ($name in @('pre-existing-data', 'pre-existing-cache')) {
        $existing = Join-Path $root $name
        New-Item -ItemType Directory -Path $existing | Out-Null
        $sentinel = Join-Path $existing 'do-not-touch.txt'
        [IO.File]::WriteAllText($sentinel, 'synthetic user data')
        $before = (Get-FileHash -LiteralPath $sentinel).Hash
        Blocked { New-FixtureClaim $existing ([guid]::NewGuid().ToString('N')) } 'pre-existing' | Out-Null
        Check ((Get-FileHash -LiteralPath $sentinel).Hash -ceq $before) 'Pre-existing data changed'
        Check (-not (Test-Path -LiteralPath (Join-Path $existing '.xharness-install-ownership'))) 'Pre-existing root was falsely claimed'
    }

    # Validate both roots before starting any move; a bad SECOND marker must
    # not cause the first root to be moved as partial "cleanup".
    New-TestClaims
    $profiles[1].MarkerHandle.Position = 0
    $bytes = [Text.Encoding]::ASCII.GetBytes(('0' * 32))
    $profiles[1].MarkerHandle.Write($bytes, 0, 32); $profiles[1].MarkerHandle.Flush($true)
    $failure = Blocked { Complete-FixtureIsolation } 'marker changed'
    Check-Originals
    Check (-not (New-FixtureReceipt @{ retainedHash = 'keep' } $null $failure).passed) 'Cleanup failure claimed success'
    Close-TestClaims

    New-TestClaims
    $profiles[0].MarkerHandle.Dispose()
    Remove-Item -LiteralPath $profiles[0].Marker -ErrorAction Stop
    Blocked { Complete-FixtureIsolation } 'ownership ledger|marker' | Out-Null
    Check-Originals
    Close-TestClaims

    New-TestClaims
    $profiles[1].Path = Join-Path $root 'pre-existing-data'
    Blocked { Complete-FixtureIsolation } 'ownership ledger' | Out-Null
    Check ((Get-Content -LiteralPath (Join-Path $root 'pre-existing-data/do-not-touch.txt') -Raw) -ceq 'synthetic user data') 'Out-of-ledger data changed'
    Check (-not (Test-Path -LiteralPath (Join-Path $archives[0].Path 'profile'))) 'Missing ledger moved first root'
    Close-TestClaims

    New-TestClaims
    # Keep the deliberately dropped ledger entry from leaking its marker lock.
    $profiles[1].MarkerHandle.Dispose()
    $profiles.RemoveAt(1)
    Blocked { Complete-FixtureIsolation } 'Incomplete' | Out-Null
    Close-TestClaims

    New-TestClaims
    New-Item -ItemType Directory -Path (Join-Path $archives[1].Path 'profile') | Out-Null
    Blocked { Complete-FixtureIsolation } 'pre-existing' | Out-Null
    foreach ($claim in $profiles) { Check (Test-Path -LiteralPath $claim.Path) 'Destination conflict moved an original' }
    Check (-not (Test-Path -LiteralPath (Join-Path $archives[0].Path 'profile'))) 'Second destination conflict moved the first root'
    Close-TestClaims

    foreach ($mode in @('live', 'uncertain')) {
        New-TestClaims
        $script:inventoryMode = $mode
        Blocked { Complete-FixtureIsolation } 'writer|inventory' | Out-Null
        Check-Originals
        Close-TestClaims
    }

    New-TestClaims
    function Stop-OwnedFixtureProcesses { throw 'fixture stop failed' }
    $failure = Blocked { Complete-FixtureIsolation } 'stop failed'
    Check-Originals
    $testFailure = Blocked { throw 'original native assertion failed' } 'original native'
    $receipt = New-FixtureReceipt @{ retainedHash = 'keep' } $testFailure $failure
    Check (-not $receipt.passed -and $receipt.testError -eq 'original native assertion failed' -and $receipt.cleanupError -eq 'fixture stop failed' -and $receipt.retainedHash -eq 'keep') 'Original and cleanup errors were not preserved'
    Close-TestClaims

    New-TestClaims
    function Move-FixtureProfile { param($Source, $Destination); throw 'fixture move failed' }
    $failure = Blocked { Complete-FixtureIsolation } 'move failed'
    Check-Originals
    Check (-not (New-FixtureReceipt @{} $null $failure).passed) 'Move failure produced passed receipt'
    Close-TestClaims

    New-TestClaims
    function Move-FixtureProfile {
        param($Source, $Destination)
        $script:moves++
        if ($script:moves -eq 2) { throw 'second fixture move failed' }
        [IO.Directory]::Move($Source, $Destination)
    }
    $failure = Blocked { Complete-FixtureIsolation } 'second fixture move'
    Check ((Get-Content -LiteralPath (Join-Path $profiles[0].ArchivedTo 'retained.txt') -Raw) -ceq 'not user data: preserve exact fixture bytes') 'Partial move lost first root bytes'
    Check (Test-Path -LiteralPath $profiles[1].Path) 'Partial move lost second root'
    Check (-not (New-FixtureReceipt @{} $null $failure).passed) 'Partial move claimed success'
    Close-TestClaims

    # Junction tests are Windows-native; this unit is wired to both Windows
    # PowerShell 5.1 and PowerShell 7, never a Unix simulation of KnownFolders.
    $outside = Join-Path $root 'junction-target'
    New-Item -ItemType Directory -Path $outside | Out-Null
    [IO.File]::WriteAllText((Join-Path $outside 'untouched.txt'), 'synthetic outside bytes')
    $redirect = Join-Path $root 'redirect-parent'
    New-Item -ItemType Junction -Path $redirect -Target $outside | Out-Null
    Blocked { New-FixtureClaim (Join-Path $redirect 'new-data') ([guid]::NewGuid().ToString('N')) } 'redirecting' | Out-Null
    Check (-not (Test-Path -LiteralPath (Join-Path $outside 'new-data'))) 'Ancestor junction was followed'
    New-TestClaims
    $childRedirect = Join-Path $profiles[1].Path 'redirect-child'
    New-Item -ItemType Junction -Path $childRedirect -Target $outside | Out-Null
    Blocked { Complete-FixtureIsolation } 'redirecting' | Out-Null
    Check-Originals
    Check ((Get-Content -LiteralPath (Join-Path $outside 'untouched.txt') -Raw) -ceq 'synthetic outside bytes') 'Redirect target changed'
    Close-TestClaims
    # Remove only the unit's junction entry before removing its own test root.
    [IO.Directory]::Delete($childRedirect); [IO.Directory]::Delete($redirect)

    # Native command-line parsing and exact ready-file containment, without
    # reading any real Host command line or runtime credential.
    $runtime = Join-Path $root ('runtime ' + $unicodeFixture)
    $ready = Join-Path $runtime ('ready-' + ('a' * 64) + '.address')
    $command = '"C:\fixture\xharness-host.exe" --auth-token "synthetic-not-a-credential" --ready-file "' + $ready + '"'
    Check ((Get-FixtureReadyFile $command $runtime) -ceq $ready) 'Unicode ready-file did not parse exactly'
    Blocked { Get-FixtureReadyFile ($command + ' --ready-file "' + $ready + '"') $runtime } 'Ambiguous' | Out-Null
    Blocked { Get-FixtureReadyFile 'xharness-host.exe --ready-file' $runtime } 'Missing' | Out-Null
    Blocked { Get-FixtureReadyFile ('xharness-host.exe --ready-file "' + (Join-Path $root ('ready-' + ('b' * 64) + '.address')) + '"') $runtime } 'outside' | Out-Null
    Write-Output "Installation ownership isolation passed: $script:checks exact positive/negative checks; original namespace guards retained."
} finally {
    Close-TestClaims
    # Every file here was created by this pure unit under its exclusive GUID
    # temp root. This is not the production application-data cleanup path.
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
