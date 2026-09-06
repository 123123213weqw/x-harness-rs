param(
    [ValidateSet('Preflight', 'Reconcile')][string]$Mode,
    [string]$InstallDirectory,
    [string]$InventoryPath
)
$ErrorActionPreference = 'Stop'

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

function Get-XHarnessLinks {
    $shell = New-Object -ComObject WScript.Shell
    $roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
    foreach ($root in $roots) {
        foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
            $link = $shell.CreateShortcut($file.FullName)
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

function Invoke-XHarnessReconcile([string]$Directory, [string]$Inventory) {
    $canonical = Get-XHarnessDirectory $Directory
    if (@(Get-XHarnessProcesses).Count) { throw 'An XHarness process started during installation; close it and retry' }
    $records = @(Get-Content -LiteralPath $Inventory -Raw | ConvertFrom-Json)
    $shell = New-Object -ComObject WScript.Shell
    $target = Join-Path $canonical 'xharness-desktop.exe'
    foreach ($record in $records) {
        if ($record.Custom) { continue }
        if (-not (Test-Path -LiteralPath $record.Link -PathType Leaf)) { continue }
        $link = $shell.CreateShortcut($record.Link)
        if ($link.Arguments -or [IO.Path]::GetFileName($link.TargetPath) -ine 'xharness-desktop.exe') { continue }
        # Only the previously observed target or the target NSIS just wrote.
        $observed = Join-Path $record.Directory 'xharness-desktop.exe'
        if ($link.TargetPath -ine $observed -and $link.TargetPath -ine $target) { continue }
        $backup = $record.Link + '.before-xharness-update'
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $record.Link -Destination $backup }
        $link.TargetPath = $target
        $link.WorkingDirectory = $canonical
        $link.IconLocation = $target + ',0'
        $link.Save()
    }
    # Deliberately retain unknown files/data and old directories. Only known
    # legacy distribution locations can be retired automatically, recoverably.
    $legacyLocations = @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'XHarness'),
        (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\XHarness-Friends')
    )
    foreach ($legacy in @($records | ForEach-Object Directory | Select-Object -Unique)) {
        if ($legacy -ieq $canonical -or $legacyLocations -inotcontains $legacy) { continue }
        if (@($records | Where-Object { $_.Directory -ieq $legacy -and $_.Custom }).Count) { continue }
        $verified = Get-XHarnessDirectory $legacy
        $oldVersion = [version](Get-Item -LiteralPath (Join-Path $verified 'xharness-desktop.exe')).VersionInfo.FileVersion
        $newVersion = [version](Get-Item -LiteralPath $target).VersionInfo.FileVersion
        if ($oldVersion -gt $newVersion) { continue }
        foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe')) {
            $binary = Join-Path $verified $name
            $backup = $binary + '.before-xharness-update'
            if (Test-Path -LiteralPath $backup) { throw "Refuse to overwrite recovery file: $backup" }
        }
        $moved = @()
        try {
            if (@(Get-XHarnessProcesses).Count) { throw 'XHarness restarted during migration' }
            foreach ($name in @('xharness-desktop.exe', 'xharness-host.exe')) {
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
        $redirect = $shell.CreateShortcut((Join-Path $verified 'XHarness.lnk'))
        $redirect.TargetPath = $target
        $redirect.WorkingDirectory = $canonical
        $redirect.Save()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if (-not $InventoryPath -or -not $Mode) { throw 'Mode and InventoryPath are required' }
        if ($Mode -eq 'Preflight') { Invoke-XHarnessPreflight $InventoryPath }
        else { Invoke-XHarnessReconcile $InstallDirectory $InventoryPath }
    } catch { Write-Error $_; exit 1 }
}
