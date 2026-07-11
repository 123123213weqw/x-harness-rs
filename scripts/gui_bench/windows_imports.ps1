param([Parameter(Mandatory=$true)][string]$Binary, [Parameter(Mandatory=$true)][string]$EvidenceDir)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$vs = & "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe" -latest -property installationPath
$dumpbin = Get-ChildItem "$vs/VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $dumpbin) { throw 'dumpbin unavailable for native loader diagnostics' }
$imports = & $dumpbin.FullName /imports $Binary
if ($LASTEXITCODE) { throw 'native import inspection failed' }
$imports | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'imports.txt')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class XhNativeLoader {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryW(string name);
  [DllImport("kernel32", CharSet=CharSet.Ansi, SetLastError=true)] public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32", CharSet=CharSet.Unicode)] public static extern uint GetModuleFileNameW(IntPtr module, StringBuilder path, uint size);
  [DllImport("kernel32")] public static extern bool FreeLibrary(IntPtr module);
}
'@
$rows = [System.Collections.Generic.List[object]]::new()
$handle = [IntPtr]::Zero
$dll = ''
try {
  foreach ($line in $imports) {
    if ($line -match '^\s+([a-zA-Z0-9._-]+\.dll)\s*$') {
      if ($handle -ne [IntPtr]::Zero) { [XhNativeLoader]::FreeLibrary($handle) | Out-Null }
      $dll = $Matches[1]
      $handle = [XhNativeLoader]::LoadLibraryW($dll)
      $path = [System.Text.StringBuilder]::new(4096)
      if ($handle -ne [IntPtr]::Zero) { [XhNativeLoader]::GetModuleFileNameW($handle, $path, 4096) | Out-Null }
      $rows.Add(@{dll=$dll; loaded=($handle -ne [IntPtr]::Zero); path=$path.ToString()})
    } elseif ($dll -and $line -match '^\s+[0-9a-fA-F]+\s+(\S+)\s*$') {
      $symbol = $Matches[1]
      $found = $handle -ne [IntPtr]::Zero -and [XhNativeLoader]::GetProcAddress($handle, $symbol) -ne [IntPtr]::Zero
      if (-not $found) { $rows.Add(@{dll=$dll; missing_symbol=$symbol}) }
    }
  }
} finally {
  if ($handle -ne [IntPtr]::Zero) { [XhNativeLoader]::FreeLibrary($handle) | Out-Null }
}
$rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'loader-imports.json')
# Diagnostic only: the actual probe exit code remains the acceptance gate.
$rows | Where-Object { $_.missing_symbol -or $_.loaded -eq $false } | ConvertTo-Json -Depth 4
