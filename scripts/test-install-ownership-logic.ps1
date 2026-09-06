param([Parameter(Mandatory)][string]$DesktopBinary)
$ErrorActionPreference = 'Stop'
trap { Write-Output $_.ScriptStackTrace; Write-Output $_.Exception.ToString(); throw }
. "$PSScriptRoot/../apps/desktop/src-tauri/windows/install-ownership.ps1"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('xharness-reconcile-unit-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
function Assert-That($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-XHarnessProcesses { @() }
$shell = New-Object -ComObject WScript.Shell
function New-TestCopy([string]$Name) {
    $directory = Join-Path $fixture $Name
    New-Item -ItemType Directory -Path $directory | Out-Null
    Copy-Item -LiteralPath $DesktopBinary -Destination (Join-Path $directory 'xharness-desktop.exe')
    New-Item -ItemType File -Path (Join-Path $directory 'xharness-host.exe') | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory 'user-project.txt'), 'DO NOT DELETE')
    return $directory
}
$canonical = New-TestCopy ('new ' + [char]0x4e2d + [char]0x6587 + ' path')
$old = New-TestCopy 'legacy'
$custom = New-TestCopy 'custom-launch'
$unknown = New-TestCopy 'unknown-location'
function Get-XHarnessLegacyLocations { $old; $custom }
$empty = Join-Path $fixture 'empty.json'
Write-Output 'Checking empty shortcut inventory'
[IO.File]::WriteAllText($empty, '[]')
Invoke-XHarnessReconcile $canonical $empty
$records = @()
foreach ($copy in @($old, $custom, $unknown)) {
    Write-Output "Creating fixture shortcut for $copy"
    $shortcut = Join-Path $fixture ((Split-Path $copy -Leaf) + '.lnk')
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = Join-Path $copy 'xharness-desktop.exe'
    if ($copy -eq $custom) { $link.Arguments = '--custom-profile' }
    $link.Save()
    $records += [pscustomobject]@{ Link = $shortcut; Directory = $copy; Custom = ($copy -eq $custom) }
}
$inventory = Join-Path $fixture 'inventory.json'
$records | ConvertTo-Json | Set-Content -LiteralPath $inventory -Encoding UTF8
Invoke-XHarnessReconcile $canonical $inventory
Write-Output 'Reconciliation completed; checking copies and shortcuts'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $old 'xharness-desktop.exe'))) 'Legacy remains executable'
Assert-That (Test-Path -LiteralPath (Join-Path $old 'xharness-desktop.exe.before-xharness-update')) 'Backup missing'
Assert-That ((Get-Content -LiteralPath (Join-Path $old 'user-project.txt') -Raw) -eq 'DO NOT DELETE') 'User project changed'
Assert-That (Test-Path -LiteralPath (Join-Path $custom 'xharness-desktop.exe')) 'Custom launcher was retired'
Assert-That (Test-Path -LiteralPath (Join-Path $unknown 'xharness-desktop.exe')) 'Unknown directory was retired'
Assert-That ([XHarnessInstaller.Shortcuts]::Read($records[0].Link).TargetPath -ieq (Join-Path $canonical 'xharness-desktop.exe')) 'Known shortcut not updated'
Assert-That ($shell.CreateShortcut($records[1].Link).Arguments -eq '--custom-profile') 'Custom shortcut changed'
[IO.File]::WriteAllText((Join-Path $fixture 'broken.lnk'), 'Not a shell link')
$links = @(Get-XHarnessLinks -Roots @($fixture))
Assert-That ($links.Count -gt 0) 'Known links were not inventoried'
Assert-That (-not ($links | Where-Object { $_.Link -like '*broken.lnk' })) 'Corrupt unrelated shortcut was accepted'
# A second migration against its old inventory must not destroy the backup.
$backupHash = (Get-FileHash -LiteralPath (Join-Path $old 'xharness-desktop.exe.before-xharness-update')).Hash
try { Invoke-XHarnessReconcile $canonical $inventory } catch { }
Assert-That ((Get-FileHash -LiteralPath (Join-Path $old 'xharness-desktop.exe.before-xharness-update')).Hash -eq $backupHash) 'Recovery copy overwritten'
Write-Output "Installer logic passed: custom/unknown preservation, shortcut repair, recoverable retirement. Fixtures: $fixture"
