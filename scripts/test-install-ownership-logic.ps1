param([Parameter(Mandatory)][string]$DesktopBinary)
$ErrorActionPreference = 'Stop'
trap { Write-Output $_.ScriptStackTrace; Write-Output $_.Exception.ToString(); throw }
. "$PSScriptRoot/../apps/desktop/src-tauri/windows/install-ownership.ps1"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('xharness-reconcile-unit-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
function Assert-That($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-XHarnessProcesses { @() }
function Get-XHarnessShortcutBackupRoot { Join-Path $fixture 'local-app-data/installer-backups' }
# ANSI WScript setters can reject Chinese targets or corrupt Chinese arguments.
# Build all links through IShellLinkW, then check the fixture before migration.
function New-TestShortcut([string]$Path, [string]$TargetPath, [string]$LaunchArguments = '') {
    $TargetPath = [IO.Path]::GetFullPath($TargetPath)
    [XHarnessInstaller.Shortcuts]::Update($Path, $TargetPath, ([IO.Path]::GetDirectoryName($TargetPath)))
    [XHarnessInstaller.Shortcuts]::SetArguments($Path, $LaunchArguments)
    # Retargeting an existing link must not clear custom launch arguments.
    [XHarnessInstaller.Shortcuts]::Update($Path, $TargetPath, ([IO.Path]::GetDirectoryName($TargetPath)))
    $actual = [XHarnessInstaller.Shortcuts]::Read($Path)
    Assert-That ($actual.TargetPath -ieq $TargetPath) ('Fixture target did not round-trip: ' + $Path)
    Assert-That ($actual.Arguments -ceq $LaunchArguments) ('Fixture arguments did not round-trip: ' + $Path)
}
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
    $launchArguments = if ($copy -eq $custom) { '--custom-profile' } else { '' }
    New-TestShortcut $shortcut (Join-Path $copy 'xharness-desktop.exe') $launchArguments
    $records += [pscustomobject]@{ Link = $shortcut; Directory = $copy; Custom = ($copy -eq $custom) }
}
$inventory = Join-Path $fixture 'inventory.json'
$records | ConvertTo-Json | Set-Content -LiteralPath $inventory -Encoding UTF8
# Simulate the adjacent recovery files produced by previous installers.
$legacyShortcutBackup = $records[0].Link + '.before-xharness-update'
Copy-Item -LiteralPath $records[0].Link -Destination $legacyShortcutBackup
$legacyShortcutHash = (Get-FileHash -LiteralPath $legacyShortcutBackup).Hash
$customShortcutBackup = $records[1].Link + '.before-xharness-update'
Copy-Item -LiteralPath $records[1].Link -Destination $customShortcutBackup
$corruptShortcutBackup = $records[2].Link + '.before-xharness-update'
[IO.File]::WriteAllText($corruptShortcutBackup, 'Not a shortcut; preserve me')
Invoke-XHarnessReconcile $canonical $inventory
Write-Output 'Reconciliation completed; checking copies and shortcuts'
Assert-That (-not (Test-Path -LiteralPath $legacyShortcutBackup)) 'Verified legacy shortcut backup still on desktop'
Assert-That (Test-Path -LiteralPath $customShortcutBackup) 'Custom shortcut backup was removed'
Assert-That ((Get-Content -LiteralPath $corruptShortcutBackup -Raw) -eq 'Not a shortcut; preserve me') 'Corrupt backup changed'
$recoveryFiles = @(Get-ChildItem -LiteralPath (Get-XHarnessShortcutBackupRoot) -Filter 'shortcut.lnk' -Recurse)
Assert-That (@($recoveryFiles | Where-Object { (Get-FileHash -LiteralPath $_.FullName).Hash -eq $legacyShortcutHash }).Count -gt 0) 'Original shortcut bytes were not retained'
$metadata = @(Get-ChildItem -LiteralPath (Get-XHarnessShortcutBackupRoot) -Filter 'source.json' -Recurse | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json })
Assert-That (@($metadata | Where-Object { $_.original_path -eq $legacyShortcutBackup -and $_.sha256 -eq $legacyShortcutHash }).Count -eq 1) 'Recovery source path/hash missing'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $old 'xharness-desktop.exe'))) 'Legacy remains executable'
Assert-That (Test-Path -LiteralPath (Join-Path $old 'xharness-desktop.exe.before-xharness-update')) 'Backup missing'
Assert-That ((Get-Content -LiteralPath (Join-Path $old 'user-project.txt') -Raw) -eq 'DO NOT DELETE') 'User project changed'
Assert-That (Test-Path -LiteralPath (Join-Path $custom 'xharness-desktop.exe')) 'Custom launcher was retired'
Assert-That (Test-Path -LiteralPath (Join-Path $unknown 'xharness-desktop.exe')) 'Unknown directory was retired'
Assert-That ([XHarnessInstaller.Shortcuts]::Read($records[0].Link).TargetPath -ieq (Join-Path $canonical 'xharness-desktop.exe')) 'Known shortcut not updated'
Assert-That ([XHarnessInstaller.Shortcuts]::Read($records[1].Link).Arguments -eq '--custom-profile') 'Custom shortcut changed'
[IO.File]::WriteAllText((Join-Path $fixture 'broken.lnk'), 'Not a shell link')
$links = @(Get-XHarnessLinks -Roots @($fixture))
Assert-That ($links.Count -gt 0) 'Known links were not inventoried'
Assert-That (-not ($links | Where-Object { $_.Link -like '*broken.lnk' })) 'Corrupt unrelated shortcut was accepted'
# A second migration against its old inventory must not destroy the backup.
$backupHash = (Get-FileHash -LiteralPath (Join-Path $old 'xharness-desktop.exe.before-xharness-update')).Hash
try { Invoke-XHarnessReconcile $canonical $inventory } catch { }
Assert-That ((Get-FileHash -LiteralPath (Join-Path $old 'xharness-desktop.exe.before-xharness-update')).Hash -eq $backupHash) 'Recovery copy overwritten'

# Fresh inventory on subsequent updates must not recreate adjacent backups.
$nextInventory = Join-Path $fixture 'next.json'
ConvertTo-Json -InputObject @(Get-XHarnessLinks -Roots @($fixture) | Where-Object { $_.Link -notlike '*installer-backups*' }) | Set-Content -LiteralPath $nextInventory -Encoding UTF8
Invoke-XHarnessReconcile $canonical $nextInventory
$beforeCount = @(Get-ChildItem -LiteralPath (Get-XHarnessShortcutBackupRoot) -Filter 'shortcut.lnk' -Recurse).Count
Invoke-XHarnessReconcile $canonical $nextInventory
Assert-That (@(Get-ChildItem -LiteralPath (Get-XHarnessShortcutBackupRoot) -Filter 'shortcut.lnk' -Recurse).Count -eq $beforeCount) 'Identical recovery copies were duplicated'
Assert-That (-not (Test-Path -LiteralPath $legacyShortcutBackup)) 'Later upgrade recreated desktop backup'

# A legacy file can refer to an installation already retired by an older updater.
$savedLegacy = $recoveryFiles | Where-Object { (Get-FileHash -LiteralPath $_.FullName).Hash -eq $legacyShortcutHash } | Select-Object -First 1
Copy-Item -LiteralPath $savedLegacy.FullName -Destination $legacyShortcutBackup
Invoke-XHarnessReconcile $canonical $nextInventory
Assert-That (-not (Test-Path -LiteralPath $legacyShortcutBackup)) 'Retired-install shortcut backup was not migrated'

# Hash helper is literal-path safe, streams large files, and releases file handles.
$hashPath = Join-Path $fixture ('hash [literal] ' + [char]0x4e2d + '.bin')
foreach ($bytes in @([byte[]]@(), [Text.Encoding]::UTF8.GetBytes('abc'), (New-Object byte[] (1024 * 1024 + 7)))) {
    [IO.File]::WriteAllBytes($hashPath, $bytes)
    $expectedHash = (Get-FileHash -LiteralPath $hashPath -Algorithm SHA256).Hash
    $actualHash = & {
        function Get-FileHash { throw 'Unavailable in installer subprocess' }
        Get-XHarnessFileHash $hashPath
    }
    Assert-That ($actualHash -ceq $expectedHash) 'Module-independent SHA256 did not match'
    # No leaked reader should block an exclusive writer on Windows.
    $exclusive = [IO.File]::Open($hashPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $exclusive.Dispose()
}
$hashFailure = $false
try { Get-XHarnessFileHash (Join-Path $fixture 'no-such-hash-file') | Out-Null } catch { $hashFailure = $true }
Assert-That $hashFailure 'Missing file hash must fail closed'

$version = [version](Get-Item -LiteralPath $DesktopBinary).VersionInfo.FileVersion
$target = Join-Path $canonical 'xharness-desktop.exe'
function New-TestShortcutPair([string]$Name, [string]$BackupTarget, [string]$Arguments = '') {
    $path = Join-Path $fixture ($Name + '.lnk')
    [XHarnessInstaller.Shortcuts]::Update($path, $target, $canonical)
    $staging = Join-Path $fixture ($Name + '-staging.lnk')
    New-TestShortcut $staging $BackupTarget $Arguments
    Move-Item -LiteralPath $staging -Destination ($path + '.before-xharness-update')
    return $path
}
$unicodeName = 'spaces [literal] ' + [char]0x4e2d + [char]0x6587
$path = New-TestShortcutPair $unicodeName $target
$source = $path + '.before-xharness-update'
Move-XHarnessLegacyShortcutBackup $path $target $version
Assert-That (-not (Test-Path -LiteralPath $source)) 'Unicode/literal path migration failed'
$unicodeMetadata = @(Get-ChildItem -LiteralPath (Get-XHarnessShortcutBackupRoot) -Filter source.json -Recurse | ForEach-Object {
    Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
} | Where-Object { $_.original_path -eq $source })
Assert-That ($unicodeMetadata.Count -eq 1) 'Unicode recovery metadata did not round-trip'
foreach ($case in @(
    @{ Name = 'custom-backup'; Target = $target; Arguments = '--custom-profile' },
    @{ Name = 'unicode-custom-backup'; Target = $target; Arguments = ('--profile "' + $unicodeName + '"') },
    @{ Name = 'unrelated-backup'; Target = "$env:SystemRoot/notepad.exe"; Arguments = '' },
    @{ Name = 'unverified-backup'; Target = (Join-Path $fixture 'missing/xharness-desktop.exe'); Arguments = '' }
)) {
    $path = New-TestShortcutPair $case.Name $case.Target $case.Arguments
    $source = $path + '.before-xharness-update'
    $hash = (Get-FileHash -LiteralPath $source).Hash
    Move-XHarnessLegacyShortcutBackup $path $target $version
    Assert-That ((Get-FileHash -LiteralPath $source).Hash -eq $hash) ('Unsafe legacy backup was changed: ' + $case.Name)
}

# Failure during archival must retain both the old bytes and the active link.
$path = New-TestShortcutPair 'failed-archive' $target
$source = $path + '.before-xharness-update'
$hash = (Get-FileHash -LiteralPath $source).Hash
$saveFunction = (Get-Item Function:Save-XHarnessShortcutBackup).ScriptBlock
function Save-XHarnessShortcutBackup { throw 'Simulated destination unavailable' }
Move-XHarnessLegacyShortcutBackup $path $target $version
Assert-That ((Get-FileHash -LiteralPath $source).Hash -eq $hash) 'Failed archival lost source'
Assert-That ([XHarnessInstaller.Shortcuts]::Read($path).TargetPath -eq $target) 'Failed archival damaged current shortcut'
Set-Item Function:Save-XHarnessShortcutBackup $saveFunction
Move-XHarnessLegacyShortcutBackup $path $target $version
Assert-That (-not (Test-Path -LiteralPath $source)) 'Retry after archival failure did not recover'

# A corrupt existing archive is never silently overwritten and cannot authorize removal.
$path = New-TestShortcutPair 'corrupt-archive' $target
$source = $path + '.before-xharness-update'
$hash = Save-XHarnessShortcutBackup $source $version
$entry = Get-ChildItem -LiteralPath (Get-XHarnessShortcutBackupRoot) -Filter source.json -Recurse | Where-Object {
    (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).original_path -eq $source
}
$archive = Join-Path $entry.DirectoryName 'shortcut.lnk'
[IO.File]::WriteAllText($archive, 'Corrupt archive fixture')
Move-XHarnessLegacyShortcutBackup $path $target $version
Assert-That ((Get-FileHash -LiteralPath $source).Hash -eq $hash) 'Corrupt destination caused source removal'
Assert-That ((Get-Content -LiteralPath $archive -Raw) -eq 'Corrupt archive fixture') 'Existing archive overwritten'

# Archiving must reject redirection and preserve source on a destination failure.
$redirect = Join-Path $fixture 'redirected-backups'
$outside = Join-Path $fixture 'untouched-directory'
New-Item -ItemType Directory -Path $outside | Out-Null
New-Item -ItemType Junction -Path $redirect -Target $outside | Out-Null
$sourceDirectory = Join-Path $fixture 'source-fixtures'
New-Item -ItemType Directory -Path $sourceDirectory | Out-Null
$path = New-TestShortcutPair 'source-fixtures/redirected-source' $target
$source = $path + '.before-xharness-update'
$hash = (Get-FileHash -LiteralPath $source).Hash
$sourceRedirect = Join-Path $fixture 'redirected-source-directory'
New-Item -ItemType Junction -Path $sourceRedirect -Target $sourceDirectory | Out-Null
Move-XHarnessLegacyShortcutBackup (Join-Path $sourceRedirect 'redirected-source.lnk') $target $version
Assert-That ((Get-FileHash -LiteralPath $source).Hash -eq $hash) 'Redirected source was changed'
$outsideCount = @(Get-ChildItem -LiteralPath $outside -Force).Count
$originalBackupRoot = (Get-Item Function:Get-XHarnessShortcutBackupRoot).ScriptBlock
function Get-XHarnessShortcutBackupRoot { $redirect }
$failed = $false
try { Invoke-XHarnessReconcile $canonical $nextInventory } catch { $failed = $true }
Assert-That $failed 'Redirected backup root accepted'
Assert-That (@(Get-ChildItem -LiteralPath $outside -Force).Count -eq $outsideCount) 'Wrote into redirected backup destination'
Set-Item Function:Get-XHarnessShortcutBackupRoot $originalBackupRoot
Write-Output "Installer logic passed: custom/unknown preservation, shortcut repair, recoverable retirement. Fixtures: $fixture"
