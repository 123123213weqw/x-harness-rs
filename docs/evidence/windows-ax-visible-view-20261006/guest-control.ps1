$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$uuid=(Get-CimInstance Win32_ComputerSystemProduct).UUID
if ($uuid -ne '66B64058-BDCC-43E9-85EE-55A79FE2E875'){throw 'Wrong disposable VM'}
# Retire only previous disposable browser probes from this test namespace.
Get-ChildItem $env:TEMP -Directory -Filter 'XHarness-Shopping-Lab-*'|ForEach-Object {if(Test-Path (Join-Path $_.FullName 'tool-definition.json')){New-Item (Join-Path $_.FullName 'stop') -ItemType File -Force|Out-Null}}
Start-Sleep -Seconds 1
$root=Join-Path $env:TEMP ('XHarness-Shopping-Lab-'+(Get-Date -Format yyyyMMddHHmmss))
New-Item -ItemType Directory -Force $root|Out-Null
foreach($name in @('computer-probe.exe','computer-provenance.json')){Invoke-WebRequest -UseBasicParsing ('http://10.0.2.2:18086/'+$name) -OutFile (Join-Path $root $name) -TimeoutSec 90 -DisableKeepAlive}
$p=Get-Content -Raw (Join-Path $root 'computer-provenance.json')|ConvertFrom-Json
$exe=Join-Path $root 'computer-probe.exe'
if((Get-FileHash $exe -Algorithm SHA256).Hash -ne $p.executable_sha256){throw 'Checksum mismatch'}
$env:XHARNESS_DISPOSABLE_COMPUTER_VM=$uuid.ToLower()
Remove-Item Env:XHARNESS_UIA_VISIBLE_EXPERIMENT -ErrorAction SilentlyContinue
# Candidate native regression is independently checked before the read-only browser phase.
$ErrorActionPreference='Continue'
$records=@(& $exe --native-acceptance 2>&1)
$nativeExit=$LASTEXITCODE
$ErrorActionPreference='Stop'
$receipt=@{phase='candidate-native-fixture';view_mode='control';source_sha=$p.source_sha;uuid=$uuid;exit_code=$nativeExit;output=($records -join "`n")}
Invoke-WebRequest -UseBasicParsing 'http://10.0.2.2:18086/browser-result' -Method POST -Body ($receipt|ConvertTo-Json -Depth 8 -Compress) -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 -DisableKeepAlive|Out-Null
$records|Out-Host
if($nativeExit -ne 0){
 Remove-Item Env:XHARNESS_UIA_VISIBLE_EXPERIMENT -ErrorAction SilentlyContinue
 Remove-Item Env:XHARNESS_DISPOSABLE_COMPUTER_VM -ErrorAction SilentlyContinue
 throw 'Candidate native regression failed'
}
$probe=Start-Process -FilePath $exe -ArgumentList @('--browser-acceptance',$root) -PassThru -RedirectStandardOutput (Join-Path $root 'stdout.log') -RedirectStandardError (Join-Path $root 'stderr.log')
function SampleResources {
 $edge=@(Get-Process msedge -ErrorAction SilentlyContinue);$native=@(Get-Process computer-probe -ErrorAction SilentlyContinue)
 return @{utc=(Get-Date -Format o);edge_rss_bytes=($edge|Measure-Object WorkingSet64 -Sum).Sum;edge_private_bytes=($edge|Measure-Object PrivateMemorySize64 -Sum).Sum;edge_processes=$edge.Count;native_rss_bytes=($native|Measure-Object WorkingSet64 -Sum).Sum;native_private_bytes=($native|Measure-Object PrivateMemorySize64 -Sum).Sum;native_processes=$native.Count}
}
function Report($value){Invoke-WebRequest -UseBasicParsing 'http://10.0.2.2:18086/browser-result' -Method POST -Body ($value|ConvertTo-Json -Depth 40 -Compress) -ContentType 'application/json; charset=utf-8' -TimeoutSec 20 -DisableKeepAlive|Out-Null}
try {
$until=(Get-Date).AddMinutes(20)
while(!(Test-Path (Join-Path $root 'tool-definition.json')) -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 200;if(!(Get-Process -Id $probe.Id -ErrorAction SilentlyContinue)){throw 'Probe startup failed'}}
$definition=Get-Content -Raw (Join-Path $root 'tool-definition.json')|ConvertFrom-Json
Report @{phase='ready';pid=$probe.Id;source_sha=$p.source_sha;definition=$definition;uuid=$uuid}
$id=0
while((Get-Date) -lt $until -and (Get-Process -Id $probe.Id -ErrorAction SilentlyContinue)){
 $job=(Invoke-WebRequest -UseBasicParsing 'http://10.0.2.2:18086/browser-next' -TimeoutSec 10 -DisableKeepAlive).Content|ConvertFrom-Json
 if($job.stop){New-Item (Join-Path $root 'stop') -ItemType File -Force|Out-Null;break}
 if($null -eq $job.id -or $job.id -ne $id){Start-Sleep -Milliseconds 250;continue}
 $temp=Join-Path $root ('request-'+$id+'.tmp')
 $job.request|ConvertTo-Json -Depth 30 -Compress|Set-Content -Encoding UTF8 $temp
 Move-Item $temp (Join-Path $root ('request-'+$id+'.json'))
 $response=Join-Path $root ('result-'+$id+'.json')
 $wait=(Get-Date).AddSeconds(60)
 $samples=@(SampleResources)
 while(!(Test-Path $response) -and (Get-Date) -lt $wait){if($samples.Count -lt 600){$samples+=SampleResources};Start-Sleep -Milliseconds 100}
 if(!(Test-Path $response)){throw 'Native operation exceeded bounded limit'}
 $value=Get-Content -Raw $response -Encoding UTF8|ConvertFrom-Json
 $resources=@(Get-Process msedge,computer-probe -ErrorAction SilentlyContinue|Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,CPU,HandleCount)
 $value|Add-Member -NotePropertyName resource_samples -NotePropertyValue $samples
 $value|Add-Member -NotePropertyName resources -NotePropertyValue $resources
 $value|Add-Member -NotePropertyName source_sha -NotePropertyValue $p.source_sha
 Report $value
 $id++
}
New-Item (Join-Path $root 'stop') -ItemType File -Force|Out-Null
Start-Sleep -Seconds 1
Report @{phase='finished';source_sha=$p.source_sha;operations=$id;probe_alive=[bool](Get-Process -Id $probe.Id -ErrorAction SilentlyContinue);stderr=(Get-Content -Raw (Join-Path $root 'stderr.log') -ErrorAction SilentlyContinue)}
Remove-Item Env:XHARNESS_DISPOSABLE_COMPUTER_VM
Write-Host "SHOPPING_LAB_FINISHED operations=$id"

} finally {
 New-Item (Join-Path $root 'stop') -ItemType File -Force|Out-Null
 if(!$probe.WaitForExit(5000)){Stop-Process -Id $probe.Id -ErrorAction SilentlyContinue}
 Remove-Item Env:XHARNESS_DISPOSABLE_COMPUTER_VM -ErrorAction SilentlyContinue
 Remove-Item Env:XHARNESS_UIA_VISIBLE_EXPERIMENT -ErrorAction SilentlyContinue
}
