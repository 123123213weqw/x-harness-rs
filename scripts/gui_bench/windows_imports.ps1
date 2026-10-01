param([Parameter(Mandatory=$true)][string]$Binary, [Parameter(Mandatory=$true)][string]$EvidenceDir)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$vs = & "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe" -latest -property installationPath
$dumpbin = Get-ChildItem "$vs/VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $dumpbin) { throw 'dumpbin unavailable for native loader diagnostics' }
$imports = & $dumpbin.FullName /imports $Binary
if ($LASTEXITCODE) { throw 'native import inspection failed' }
$imports | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'imports.txt')
# Inspect the executable's own activation manifest, not the PowerShell
# process's ComCtl32 export table (PowerShell can legitimately use v5).
$mt = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/mt.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $mt) { throw 'manifest inspection tool unavailable' }
$output = Join-Path $EvidenceDir 'embedded-manifest.xml'
& $mt.FullName "-inputresource:$Binary;#1" "-out:$output"
if ($LASTEXITCODE) { throw 'Windows probe has no embedded activation manifest' }
[xml]$manifest = Get-Content -Raw $output
$common = $manifest.SelectSingleNode("//*[local-name()='dependentAssembly']/*[local-name()='assemblyIdentity'][@name='Microsoft.Windows.Common-Controls']")
if (-not $common -or $common.version -ne '6.0.0.0') { throw 'Windows native probe requires Common Controls v6' }
