# Native Windows architecture regression; temporary fixtures only, no installer.
param([Parameter(Mandatory)][string]$DesktopBinary)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    throw 'This regression requires a native x64 Windows test process'
}
$owner = (Resolve-Path "$PSScriptRoot/../apps/desktop/src-tauri/windows/install-ownership.ps1").Path
. $owner
$id = [guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) ('xharness-native-shell-' + $id)
$protected = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('XHarness-native-shell-' + $id)
foreach ($path in @($root, $protected)) { if (Test-Path -LiteralPath $path) { throw 'Refuse pre-existing fixture' } }
$created = [Collections.Generic.List[string]]::new()
try {
    foreach ($path in @($root, $protected)) {
        New-Item -ItemType Directory -Path $path | Out-Null
        $created.Add($path)
    }
    Copy-Item -LiteralPath $DesktopBinary -Destination (Join-Path $protected 'xharness-desktop.exe')
    [IO.File]::WriteAllText((Join-Path $protected 'xharness-host.exe'), 'Synthetic ownership fixture, not executable')
    $target = Join-Path $protected 'xharness-desktop.exe'
    $before = Get-XHarnessFileHash $target
    # Exercise shortcuts made by another Windows API, not only our own writer.
    # WScript adds known-folder metadata that WOW64 resolves differently.
    $shell = New-Object -ComObject WScript.Shell
    foreach ($kind in @('managed', 'custom')) {
        $link = $shell.CreateShortcut((Join-Path $root ($kind + '.lnk')))
        $link.TargetPath = $target
        $link.Arguments = if ($kind -eq 'custom') { '--custom-profile' } else { '' }
        $link.Save()
    }
    $probe = Join-Path $root 'probe.ps1'
    @'
param([string]$OwnerScript, [string]$InventoryRoot)
$ErrorActionPreference = 'Stop'
. $OwnerScript
@{bits=[IntPtr]::Size*8;links=@(Get-XHarnessLinks -Roots @($InventoryRoot))} | ConvertTo-Json -Depth 6 -Compress
'@ | Set-Content -LiteralPath $probe -Encoding UTF8
    $bridge = Join-Path $root 'bridge.ps1'
    @'
param([string]$OwnerScript, [string]$InventoryRoot, [string]$Probe)
$ErrorActionPreference = 'Stop'
# Same path selection as the NSIS hook, executed from a real WOW64 parent.
$native = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
if (Test-Path -LiteralPath "$env:SystemRoot\Sysnative\WindowsPowerShell\v1.0\powershell.exe") {
    $native = "$env:SystemRoot\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
}
& $native -NoLogo -NoProfile -NonInteractive -File $Probe -OwnerScript $OwnerScript -InventoryRoot $InventoryRoot
if ($LASTEXITCODE) { throw 'Native ownership subprocess failed' }
'@ | Set-Content -LiteralPath $bridge -Encoding UTF8
    $wow = "$env:SystemRoot\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
    # A wrong-bitness direct invocation must fail before classifying any links.
    $ErrorActionPreference = 'Continue'
    $rejected = & $wow -NoLogo -NoProfile -NonInteractive -File $probe -OwnerScript $owner -InventoryRoot $root 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -eq 0 -or ($rejected -join "`n") -notmatch 'requires native 64-bit') { throw 'WOW64 ownership did not fail closed' }
    $reply = (& $wow -NoLogo -NoProfile -NonInteractive -File $bridge -OwnerScript $owner -InventoryRoot $root -Probe $probe | Out-String) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $reply.bits -ne 64 -or $reply.links.Count -ne 2) { throw 'Native bridge lost Program Files shortcuts' }
    foreach ($record in $reply.links) {
        if ($record.Directory -ine $protected) { throw 'Known-folder target was reinterpreted as Program Files (x86)' }
        if ($record.Custom -ne ((Split-Path $record.Link -Leaf) -eq 'custom.lnk')) { throw 'Custom arguments were misclassified' }
    }
    if ((Get-XHarnessFileHash $target) -ne $before) { throw 'Read-only inventory changed the protected fixture' }
    Write-Output 'Native shell regression passed: WOW64 rejected, Sysnative bridge x64, managed/custom targets retained.'
} finally {
    # Both random directories were created above; never alter an existing install.
    foreach ($path in $created) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
}
