param(
    [ValidateSet('Preflight', 'Reconcile')][string]$Mode,
    [string]$InstallDirectory,
    [string]$InventoryPath
)
$ErrorActionPreference = 'Stop'
$shortcutSource = Join-Path $(if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $env:XHARNESS_INSTALL_SCRIPT }) 'install-shortcuts.cs'
if (-not ('XHarnessInstaller.Shortcuts' -as [type])) { Add-Type -Path $shortcutSource }

function Assert-XHarnessNoRedirect($Item) {
    if (-not ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    # OneDrive placeholders are reparse points too, but do not redirect names.
    # Permit only Microsoft's cloud family; reject junctions/symlinks/unknown tags.
    $reply = & "$env:SystemRoot\System32\fsutil.exe" reparsepoint query $Item.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect reparse-point target' }
    $match = [regex]::Match(($reply -join "`n"), '0x[0-9a-fA-F]{8}')
    if (-not $match.Success) { throw 'Missing reparse-point tag' }
    $tag = [Convert]::ToUInt32($match.Value.Substring(2), 16)
    if (($tag -band [Convert]::ToUInt32('FFFF0FFF', 16)) -ne [Convert]::ToUInt32('9000001A', 16)) {
        throw 'Refuse redirecting or unknown reparse-point installation'
    }
}

function Get-XHarnessDirectory([string]$Directory) {
    $item = Get-Item -LiteralPath $Directory -Force
    if (-not $item.PSIsContainer -or -not $item.Parent) { throw 'Invalid installation directory' }
    $cursor = $item
    while ($cursor) {
        Assert-XHarnessNoRedirect $cursor
        $cursor = $cursor.Parent
    }
    foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe')) {
        $file = Get-Item -LiteralPath (Join-Path $item.FullName $name)
        if ($file.PSIsContainer) { throw 'Invalid application binary' }
        Assert-XHarnessNoRedirect $file
    }
    if ((Get-Item -LiteralPath (Join-Path $item.FullName 'xharness-desktop.exe')).VersionInfo.ProductName -ne 'XHarness') {
        throw 'Directory does not contain an XHarness desktop installation'
    }
    return $item.FullName
}

function Get-XHarnessProcesses {
    # Only inspect this user's processes; never kill by name, PID or wildcard.
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='xharness-desktop.exe' OR Name='xharness-host.exe'")) {
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0) { throw 'Cannot determine XHarness process ownership' }
        if ($owner.Sid -eq $userSid) { $process }
    }
}

function Get-XHarnessLinks([string[]]$Roots) {
    if (-not $Roots) { $Roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }
    foreach ($root in $Roots) {
        if (-not $root) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
            try {
                Assert-XHarnessNoRedirect $file
                $parent = $file.Directory
                while ($parent) { Assert-XHarnessNoRedirect $parent; $parent = $parent.Parent }
                $link = [XHarnessInstaller.Shortcuts]::Read($file.FullName)
            } catch { continue } # Unrelated/corrupt/redirected shortcuts are not ours to change.
            if ([IO.Path]::GetFileName($link.TargetPath) -ine 'xharness-desktop.exe') { continue }
            # A custom launch command is not ours to rewrite or retire.
            try { $directory = Get-XHarnessDirectory ([IO.Path]::GetDirectoryName($link.TargetPath)) }
            catch { continue }
            [pscustomobject]@{ Link = $file.FullName; Directory = $directory; Custom = [bool]$link.Arguments }
        }
    }
}

function Invoke-XHarnessPreflight([string]$Inventory) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $live = @(Get-XHarnessProcesses)
        if ($live.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($live.Count) {
        throw ('Close all XHarness windows and Hosts before installing. Live PIDs: ' + (($live | ForEach-Object ProcessId) -join ', '))
    }
    # Capture old targets BEFORE NSIS replaces its normal shortcuts.
    ConvertTo-Json -InputObject @(Get-XHarnessLinks) | Set-Content -LiteralPath $Inventory -Encoding UTF8
}

function Get-XHarnessLegacyLocations {
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'XHarness')
    (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\XHarness-Friends')
}

function Get-XHarnessShortcutBackupRoot {
    Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'XHarness\installer-backups'
}

function Assert-XHarnessRecoveryPath([string]$Path) {
    # Inspect existing ancestors before creating anything, including the leaf.
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            Assert-XHarnessNoRedirect (Get-Item -LiteralPath $cursor -Force)
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}

function Save-XHarnessShortcutBackup([string]$Path, [version]$Version) {
    $source = [IO.Path]::GetFullPath($Path)
    Assert-XHarnessRecoveryPath $source
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $digest = [Security.Cryptography.SHA256]::Create()
    try {
        $identity = [Text.Encoding]::UTF8.GetBytes($source.ToUpperInvariant() + "`n" + $hash)
        $key = [BitConverter]::ToString($digest.ComputeHash($identity)).Replace('-', '').ToLowerInvariant()
    } finally { $digest.Dispose() }
    $directory = Join-Path (Join-Path (Get-XHarnessShortcutBackupRoot) $Version.ToString()) $key
    Assert-XHarnessRecoveryPath $directory
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    Assert-XHarnessRecoveryPath $directory
    $copy = Join-Path $directory 'shortcut.lnk'
    $metadata = Join-Path $directory 'source.json'
    Assert-XHarnessRecoveryPath $copy
    Assert-XHarnessRecoveryPath $metadata
    if (-not (Test-Path -LiteralPath $copy)) { [IO.File]::Copy($source, $copy, $false) }
    if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ne $hash) { throw 'Shortcut recovery copy does not match; original retained' }
    if (-not (Test-Path -LiteralPath $metadata)) {
        $json = [pscustomobject]@{ original_path = $source; sha256 = $hash; destination_version = $Version.ToString() } | ConvertTo-Json
        # Never overwrite existing recovery metadata, even on a racing retry.
        $stream = [IO.File]::Open($metadata, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes($json)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
    }
    $saved = Get-Content -LiteralPath $metadata -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($saved.original_path -ine $source -or $saved.sha256 -ne $hash) { throw 'Shortcut recovery metadata does not match; original retained' }
    return $hash
}

function Move-XHarnessLegacyShortcutBackup([string]$Link, [string]$Target, [version]$Version) {
    $legacy = [IO.Path]::GetFullPath($Link + '.before-xharness-update')
    if (-not (Test-Path -LiteralPath $legacy -PathType Leaf)) { return }
    try {
        Assert-XHarnessRecoveryPath $Link
        Assert-XHarnessRecoveryPath $legacy
        $current = [XHarnessInstaller.Shortcuts]::Read($Link)
        if ($current.Arguments -or $current.TargetPath -ine $Target) { return }
        $backup = [XHarnessInstaller.Shortcuts]::Read($legacy)
        if ($backup.Arguments -or [IO.Path]::GetFileName($backup.TargetPath) -ine 'xharness-desktop.exe') { return }
        $oldDirectory = [IO.Path]::GetDirectoryName($backup.TargetPath)
        try { $null = Get-XHarnessDirectory $oldDirectory }
        catch {
            # An earlier installer may have retired the old binary already.
            # Only recognize its exact retained executable in a known legacy location.
            if (@(Get-XHarnessLegacyLocations) -inotcontains $oldDirectory) { return }
            $retired = $backup.TargetPath + '.before-xharness-update'
            Assert-XHarnessRecoveryPath $retired
            $file = Get-Item -LiteralPath $retired -Force
            if ($file.PSIsContainer -or $file.VersionInfo.ProductName -ne 'XHarness') { return }
        }
        $hash = Save-XHarnessShortcutBackup $legacy $Version
        Assert-XHarnessRecoveryPath $legacy
        if ((Get-FileHash -LiteralPath $legacy -Algorithm SHA256).Hash -ne $hash) { throw 'Legacy shortcut changed during backup; original retained' }
        # The only deletion here: one validated shortcut backup, after verified archival.
        # Never recurse, use a wildcard, or remove program/user data.
        Remove-Item -LiteralPath $legacy -ErrorAction Stop
    } catch {
        Write-Warning ('Legacy shortcut backup retained: ' + $legacy + '. ' + $_.Exception.Message)
    }
}

function Invoke-XHarnessReconcile([string]$Directory, [string]$Inventory) {
    $canonical = Get-XHarnessDirectory $Directory
    if (@(Get-XHarnessProcesses).Count) { throw 'An XHarness process started during installation; close it and retry' }
    # Windows PowerShell 5.1 can wrap an empty JSON array as one pipeline item
    # inside @(...). Keep the parsed array itself, so a first install has no links.
    $records = Get-Content -LiteralPath $Inventory -Raw | ConvertFrom-Json
    $target = Join-Path $canonical 'xharness-desktop.exe'
    $version = [version](Get-Item -LiteralPath $target).VersionInfo.FileVersion
    foreach ($record in $records) {
        if ($record.Custom) { continue }
        if (-not (Test-Path -LiteralPath $record.Link -PathType Leaf)) { continue }
        $link = [XHarnessInstaller.Shortcuts]::Read($record.Link)
        if ($link.Arguments -or [IO.Path]::GetFileName($link.TargetPath) -ine 'xharness-desktop.exe') { continue }
        # Only the previously observed target or the target NSIS just wrote.
        $observed = Join-Path $record.Directory 'xharness-desktop.exe'
        if ($link.TargetPath -ine $observed -and $link.TargetPath -ine $target) { continue }
        $null = Save-XHarnessShortcutBackup $record.Link $version
        [XHarnessInstaller.Shortcuts]::Update($record.Link, $target, $canonical)
        Move-XHarnessLegacyShortcutBackup $record.Link $target $version
    }
    # Deliberately retain unknown files/data and old directories. Only known
    # legacy distribution locations can be retired automatically, recoverably.
    $legacyLocations = @(Get-XHarnessLegacyLocations)
    foreach ($legacy in @($records | ForEach-Object Directory | Select-Object -Unique)) {
        if ($legacy -ieq $canonical -or $legacyLocations -inotcontains $legacy) { continue }
        if (@($records | Where-Object { $_.Directory -ieq $legacy -and $_.Custom }).Count) { continue }
        $verified = Get-XHarnessDirectory $legacy
        $oldVersion = [version](Get-Item -LiteralPath (Join-Path $verified 'xharness-desktop.exe')).VersionInfo.FileVersion
        $newVersion = [version](Get-Item -LiteralPath $target).VersionInfo.FileVersion
        if ($oldVersion -gt $newVersion) { continue }
        $retireNames = @('xharness-desktop.exe', 'xharness-host.exe')
        $uninstaller = Join-Path $verified 'uninstall.exe'
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            Assert-XHarnessNoRedirect (Get-Item -LiteralPath $uninstaller)
            # An old uninstaller shares the new install's registry identity.
            # Leaving it active could unregister the retained installation.
            $retireNames += 'uninstall.exe'
        }
        foreach ($name in $retireNames) {
            $binary = Join-Path $verified $name
            $backup = $binary + '.before-xharness-update'
            if (Test-Path -LiteralPath $backup) { throw "Refuse to overwrite recovery file: $backup" }
        }
        $moved = @()
        try {
            if (@(Get-XHarnessProcesses).Count) { throw 'XHarness restarted during migration' }
            foreach ($name in $retireNames) {
                $binary = Join-Path $verified $name
                Move-Item -LiteralPath $binary -Destination ($binary + '.before-xharness-update')
                $moved += $binary
            }
        } catch {
            foreach ($binary in $moved) {
                if (-not (Test-Path -LiteralPath $binary)) {
                    Move-Item -LiteralPath ($binary + '.before-xharness-update') -Destination $binary
                }
            }
            throw
        }
        [XHarnessInstaller.Shortcuts]::Update((Join-Path $verified 'XHarness.lnk'), $target, $canonical)
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if (-not $InventoryPath -or -not $Mode) { throw 'Mode and InventoryPath are required' }
        if ($Mode -eq 'Preflight') { Invoke-XHarnessPreflight $InventoryPath }
        else { Invoke-XHarnessReconcile $InstallDirectory $InventoryPath }
    } catch { Write-Error $_; exit 1 }
}
