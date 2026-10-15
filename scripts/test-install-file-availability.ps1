# Native Windows sharing violations + deterministic refusal cases. No Rust or installed user data.
param([string]$LegacySource)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Disposable Windows CI only'
}
$source = Join-Path $PSScriptRoot '../apps/desktop/src-tauri/windows/install-ownership.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($fn in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$originalProbe = (Get-Item Function:Invoke-XHarnessFileWriteProbe).ScriptBlock
$originalClock = (Get-Item Function:Get-XHarnessProbeMilliseconds).ScriptBlock
$originalProcesses = (Get-Item Function:Get-XHarnessProcesses).ScriptBlock
$fixedAvailability = (Get-Item Function:Assert-XHarnessFilesAvailable).ScriptBlock
$unicode = -join @([char]0x4E2D, [char]0x6587)
$fixture = Join-Path $env:RUNNER_TEMP ('xharness-availability-' + [guid]::NewGuid().ToString('N') + ' ' + $unicode)
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$binary = Join-Path $fixture 'xharness-desktop.exe'
$hostBinary = Join-Path $fixture 'xharness-host.exe'
$script:checks = 0
function Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function Refused([scriptblock]$Action, [string]$Pattern) {
    $message = $null
    try { & $Action } catch { $message = $_.Exception.Message }
    Check ($message -and $message -match $Pattern) "Expected refusal /$Pattern/, got $message"
}
function Reset-Case {
    [IO.File]::WriteAllText($binary, 'unchanged')
    [IO.File]::Delete($hostBinary)
    $script:clock = 0; $script:attempts = 0; $script:mode = 'recover'; $script:hresult = -2147024864
    function script:Get-XHarnessProbeMilliseconds { return $script:clock }
    function script:Start-Sleep { param($Milliseconds) $script:clock += $Milliseconds }
    function script:Invoke-XHarnessFileWriteProbe([string]$Path) {
        $script:attempts++
        if ($script:mode -eq 'access') { throw [UnauthorizedAccessException]::new('injected ACL denial') }
        if ($script:mode -eq 'unexpected') { throw [InvalidOperationException]::new('injected unexpected error') }
        if ($script:mode -eq 'change') { [IO.File]::WriteAllText($Path, 'changed after snapshot') }
        if ($script:mode -eq 'disappear') { [IO.File]::Delete($Path) }
        if ($script:mode -eq 'appear') { [IO.File]::WriteAllText($script:hostBinary, 'unexpected new file') }
        if ($script:mode -eq 'persistent' -or $script:mode -in @('change', 'disappear', 'appear') -or $script:attempts -le 2) {
            throw [IO.IOException]::new('injected sharing error', $script:hresult)
        }
    }
}
try {
    foreach ($code in @(-2147024864, -2147024863)) {
        Reset-Case; $script:hresult = $code
        Assert-XHarnessFilesAvailable @($fixture) -TimeoutMilliseconds 600
        Check ($script:attempts -eq 3 -and $script:clock -eq 400) 'Transient sharing/lock failure did not recover within one budget'
        Check ([IO.File]::ReadAllText($binary) -ceq 'unchanged') 'Probe changed file bytes'
        Reset-Case; $script:hresult = $code; $script:mode = 'persistent'
        Refused { Assert-XHarnessFilesAvailable @($fixture) -TimeoutMilliseconds 400 } '0x8007002[01]'
        Check ($script:clock -eq 400 -and $script:attempts -eq 2) 'Persistent lock wait is not bounded'
    }
    foreach ($failureMode in @('access', 'unexpected')) {
        Reset-Case; $script:mode = $failureMode
        Refused { Assert-XHarnessFilesAvailable @($fixture) } 'busy or not writable'
        Check ($script:clock -eq 0 -and $script:attempts -eq 1) 'Non-transient failure was retried'
    }
    Reset-Case; $script:hresult = -2147024873
    Refused { Assert-XHarnessFilesAvailable @($fixture) } '0x80070017'
    Check ($script:clock -eq 0) 'Unrecognized I/O error was retried'
    foreach ($failureMode in @('change', 'disappear', 'appear')) {
        Reset-Case; $script:mode = $failureMode
        Write-Output "Checking namespace refusal: $failureMode"
        Refused { Assert-XHarnessFilesAvailable @($fixture) } 'changed while waiting'
    }
    Reset-Case
    Refused { Assert-XHarnessFilesAvailable @($fixture) -TimeoutMilliseconds -1 } 'TimeoutMilliseconds'
    Refused { Assert-XHarnessFilesAvailable @($fixture) -TimeoutMilliseconds 10001 } 'TimeoutMilliseconds'

    # Two binaries share ONE budget, even when each becomes temporarily locked.
    Reset-Case
    [IO.File]::WriteAllText($hostBinary, 'unchanged')
    function script:Invoke-XHarnessFileWriteProbe([string]$Path) {
        if (($Path -eq $script:binary -and $script:clock -lt 400) -or
            ($Path -eq $script:hostBinary -and $script:clock -lt 800)) {
            throw [IO.IOException]::new('injected multiple binary sharing', -2147024864)
        }
    }
    Refused { Assert-XHarnessFilesAvailable @($fixture) -TimeoutMilliseconds 600 } 'xharness-host.exe'
    Check ($script:clock -eq 600) 'Budget multiplied across binaries'

    Reset-Case
    $script:processReads = 0
    function script:Get-XHarnessProcesses {
        param($Directories)
        $script:processReads++
        if ($script:processReads -gt 1) { [pscustomobject]@{ ProcessId = 1234 } }
    }
    $inventory = Join-Path $fixture 'must-not-be-written.json'
    Refused { Invoke-XHarnessPreflight $inventory $fixture } 'started during file availability wait'
    Check (-not (Test-Path -LiteralPath $inventory)) 'Late live process allowed inventory side effects'

    # Real kernel-enforced sharing violation, released by a native background
    # thread while the synchronous production probe waits. Not a fake provider.
    Set-Item Function:script:Invoke-XHarnessFileWriteProbe $originalProbe
    Set-Item Function:script:Get-XHarnessProbeMilliseconds $originalClock
    Set-Item Function:script:Get-XHarnessProcesses $originalProcesses
    Remove-Item Function:Start-Sleep
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public sealed class XHarnessTimedSharingLock : IDisposable {
    private readonly Thread worker;
    public XHarnessTimedSharingLock(string path) {
        var file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        worker = new Thread(() => { try { Thread.Sleep(700); } finally { file.Dispose(); } });
        worker.Start();
    }
    public void Dispose() { if (!worker.Join(5000)) throw new IOException("Fixture failed to release its own lock"); }
}
'@
    [IO.File]::WriteAllText($binary, 'unchanged')
    $lock = [XHarnessTimedSharingLock]::new($binary)
    try {
        $blocked = $false
        try { & $originalProbe $binary } catch { $blocked = $true }
        Check $blocked 'Fixture never acquired a real sharing lock'
        if ($LegacySource) {
            $legacyTokens = $null; $legacyErrors = $null
            $legacyAst = [Management.Automation.Language.Parser]::ParseFile($LegacySource, [ref]$legacyTokens, [ref]$legacyErrors)
            if ($legacyErrors.Count) { throw 'Invalid authenticated legacy source' }
            $legacy = @($legacyAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq 'Assert-XHarnessFilesAvailable' }, $false))
            Check ($legacy.Count -eq 1) 'Missing exact legacy availability function'
            . ([scriptblock]::Create($legacy[0].Extent.Text))
            Refused { Assert-XHarnessFilesAvailable @($fixture) } 'busy or not writable'
            Set-Item Function:script:Assert-XHarnessFilesAvailable $fixedAvailability
            Write-Output 'A/B: authenticated pre-fix function rejects the same native timed sharing lock.'
        }
        Assert-XHarnessFilesAvailable @($fixture) -TimeoutMilliseconds 5000
        Check ([IO.File]::ReadAllText($binary) -ceq 'unchanged') 'Recovered native probe changed bytes'
    } finally { $lock.Dispose() }
    Write-Output "PASS: $script:checks availability recovery/refusal assertions including native sharing lock."
} finally {
    foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe', 'must-not-be-written.json')) {
        [IO.File]::Delete((Join-Path $fixture $name))
    }
    [IO.Directory]::Delete($fixture)
}
