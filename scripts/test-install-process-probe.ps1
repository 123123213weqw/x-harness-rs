param([switch]$Native)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../apps/desktop/src-tauri/windows/install-ownership.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Load actual functions without COM setup, installer dispatch, or user inventory.
foreach ($fn in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('xharness-process-probe-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$binary = Join-Path $fixture 'xharness-host.exe'
[IO.File]::WriteAllText($binary, 'synthetic file; never executed')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sample = [pscustomobject]@{ ProcessId = 4242; Name = 'xharness-host.exe'; CreationDate = [datetime]'2026-09-18T12:00:00'; ThreadCount = 0; HandleCount = 0 }
$script:checks = 0
function Assert-That($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Assert-Blocked([scriptblock]$Action, [string]$Pattern) {
    $message = $null
    try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
    Assert-That ($message -and $message -match $Pattern) "Expected refusal /$Pattern/, got: $message"
}
function Reset-Probe {
    $script:listed = @($sample)
    $script:samples = @($sample, $sample)
    $script:sampleIndex = 0
    $script:ownerStatus = 2
    $script:ownerSid = $sid
    $script:ownerThrows = $false
    $script:queryThrows = $false
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($script:queryThrows) { throw 'synthetic CIM query failure' }
    if ($Filter -like 'ProcessId=*') {
        if ($script:sampleIndex -ge $script:samples.Count) { throw 'Unbounded process probing' }
        $value = $script:samples[$script:sampleIndex]; $script:sampleIndex++
        if ($null -eq $value) { return }
        return $value
    }
    return $script:listed
}
function Invoke-CimMethod {
    param($InputObject, $MethodName, $ErrorAction)
    if ($script:ownerThrows) { throw 'synthetic owner exception' }
    [pscustomobject]@{ ReturnValue = $script:ownerStatus; Sid = $script:ownerSid }
}
function Start-Sleep { param($Milliseconds) }
try {
    Reset-Probe
    $script:samples = @($null)
    Assert-That (@(Get-XHarnessProcesses -Directories @($fixture)).Count -eq 0) 'Exited-between-enumeration-and-owner-query must not block'
    Reset-Probe
    Assert-That (@(Get-XHarnessProcesses -Directories @($fixture)).Count -eq 0) 'Stable retired entry and writable target must not block'
    Reset-Probe
    $script:ownerThrows = $true
    Assert-That (@(Get-XHarnessProcesses -Directories @($fixture)).Count -eq 0) 'CIM owner exception must use the same bounded fallback'
    Reset-Probe
    $script:ownerStatus = 0
    Assert-That (@(Get-XHarnessProcesses -Directories @($fixture)).Count -eq 1) 'Known current-user process must remain a blocker'
    Reset-Probe
    $script:ownerStatus = 0; $script:ownerSid = 'S-1-5-18'
    Assert-That (@(Get-XHarnessProcesses -Directories @($fixture)).Count -eq 0) 'Known foreign user is outside the current-user data guard'
    Reset-Probe
    $script:ownerStatus = 0; $script:ownerSid = $null
    Assert-Blocked { Get-XHarnessProcesses -Directories @($fixture) } 'PID 4242'
    foreach ($field in @('ThreadCount', 'HandleCount', 'CreationDate')) {
        Reset-Probe
        $missing = $sample.PSObject.Copy(); $missing.$field = $null
        $script:samples = @($missing, $missing)
        Assert-Blocked { Get-XHarnessProcesses -Directories @($fixture) } 'PID 4242'
    }
    foreach ($field in @('ThreadCount', 'HandleCount')) {
        Reset-Probe
        $active = $sample.PSObject.Copy(); $active.$field = 1
        $script:samples = @($sample, $active)
        Assert-Blocked { Get-XHarnessProcesses -Directories @($fixture) } 'PID 4242'
    }
    Reset-Probe
    $reused = $sample.PSObject.Copy(); $reused.CreationDate = $sample.CreationDate.AddSeconds(1)
    $script:samples = @($reused, $reused)
    Assert-Blocked { Get-XHarnessProcesses -Directories @($fixture) } 'PID 4242'
    Reset-Probe
    $script:queryThrows = $true
    Assert-Blocked { Get-XHarnessProcesses -Directories @($fixture) } 'CIM query failure'
    Reset-Probe
    Assert-Blocked { Get-XHarnessProcesses } 'directory'
    Reset-Probe
    $lock = [IO.File]::Open($binary, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        Assert-Blocked { Get-XHarnessProcesses -Directories @($fixture) } 'xharness-host.exe'
        Assert-Blocked { Assert-XHarnessFilesAvailable @($fixture) } 'xharness-host.exe'
    } finally { $lock.Dispose() }
    Assert-XHarnessFilesAvailable @($fixture)
    Assert-That ([IO.File]::ReadAllText($binary) -eq 'synthetic file; never executed') 'File probe must not modify contents'
    Write-Output "PASS: $script:checks installer probe assertions (fault injection, real exclusive file locks)."
} finally {
    # Remove only this test's exact known file and now-empty temporary directory.
    [IO.File]::Delete($binary)
    [IO.Directory]::Delete($fixture)
}
if ($Native) {
    # A separate process avoids carrying the CIM mocks into native tests.
    & "$PSHOME/powershell.exe" -NoLogo -NoProfile -NonInteractive -File "$PSScriptRoot/test-install-process-native.ps1"
    if ($LASTEXITCODE) { throw 'Native process regression failed' }
}
