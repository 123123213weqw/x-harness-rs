# Opt-in read-only geometry test in the authorized disposable V100 clone.
# No installation, Host, model, UAC/account changes or application replacement.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$uuid=(Get-CimInstance Win32_ComputerSystemProduct).UUID
if ($uuid -ne '66B64058-BDCC-43E9-85EE-55A79FE2E875') { throw 'Wrong disposable Windows VM' }
$base='http://10.0.2.2:18125'
$root=Join-Path $env:TEMP ('XHarness-Browser-Bounds-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
function Report($value) {
    $value.attempt_id=[IO.Path]::GetFileName($root)
    $json=$value|ConvertTo-Json -Depth 24 -Compress
    [IO.File]::AppendAllText((Join-Path $root 'evidence.jsonl'),$json+"`n",[Text.UTF8Encoding]::new($false))
    Invoke-WebRequest -UseBasicParsing -Uri ($base+'/result') -Method POST -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 15 -DisableKeepAlive | Out-Null
}
try {
    $meta=Invoke-RestMethod -Uri ($base+'/provenance.json') -TimeoutSec 20
    if ($meta.schema -ne 1 -or $meta.source_sha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid provenance' }
    Report @{phase='environment';uuid=$uuid;os=(Get-CimInstance Win32_OperatingSystem).Version;source_sha=$meta.source_sha;test_only=$true}
    $results=@{}
    foreach ($kind in @('baseline','candidate')) {
        $name=if ($kind -eq 'baseline') {'browser-bounds-baseline.exe'} else {'browser-inspect-probe.exe'}
        $exe=Join-Path $root $name
        Invoke-WebRequest -UseBasicParsing -Uri ($base+'/'+$name) -OutFile $exe -TimeoutSec 90 -DisableKeepAlive
        $digest=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($digest -ne $meta.$kind) { throw 'Executable digest mismatch' }
        $out=Join-Path $root ($kind+'.stdout.txt');$err=Join-Path $root ($kind+'.stderr.txt')
        $env:XHARNESS_NATIVE_PROBE_BOUNDS_ONLY='1'
        $p=Start-Process -FilePath $exe -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        try {
            # Pin the native process handle before it exits. PowerShell 5.1
            # otherwise can report a null ExitCode after a completed GUI probe.
            $null=$p.Handle
            if (-not $p.WaitForExit(60000)) { throw 'Native geometry fixture timed out' }
            $p.WaitForExit();$p.Refresh()
            $stdout=[IO.File]::ReadAllText($out);$stderr=[IO.File]::ReadAllText($err)
            $cases=@($stdout -split "`r?`n" | Where-Object { $_.StartsWith('BROWSER_BOUNDS_CASE ') } | ForEach-Object { $_.Substring(20)|ConvertFrom-Json })
            $results[$kind]=@{exit_code=$p.ExitCode;cases=$cases;stdout=$stdout;stderr=$stderr;executable_sha256=$digest}
            Report @{phase=$kind;data=$results[$kind];source_sha=$meta.source_sha;uuid=$uuid}
        } finally {
            if (-not $p.HasExited) { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue }
            Remove-Item Env:XHARNESS_NATIVE_PROBE_BOUNDS_ONLY -ErrorAction SilentlyContinue
        }
    }
    $before=$results['baseline'];$after=$results['candidate']
    # GUI runtime shutdown can yield zero even for a negative oracle. Require
    # the precise geometry mismatch and its case evidence, never rc=0 as pass.
    $reproduced=($before.exit_code -in @(0,1)) -and $before.stderr.Contains('native browser bounds mismatch') -and $before.cases.Count -eq 4 -and @($before.cases[0..2]|Where-Object {-not $_.passed}).Count -eq 0 -and $before.cases[3].case -eq 'reselect-hidden-a' -and -not $before.cases[3].passed
    $fixed=$after.exit_code -eq 0 -and $after.cases.Count -eq 7 -and @($after.cases|Where-Object {-not $_.passed -or -not $_.position_asserted}).Count -eq 0
    Report @{phase='acceptance';passed=($reproduced -and $fixed);baseline_reproduced=$reproduced;candidate_passed=$fixed;source_sha=$meta.source_sha;uuid=$uuid;os_dpi_scales=@($after.cases|ForEach-Object {$_.scale_factor}|Select-Object -Unique);multi_monitor_verified=$false;installed_app_verified=$false}
    if (-not ($reproduced -and $fixed)) { throw 'Native A/B acceptance failed (see retained logs)' }
} catch {
    Report @{phase='error';passed=$false;error=$_.Exception.Message;uuid=$uuid}
    throw
}
