# Real pinned Tauri signer, synthetic data and disposable keys only. No Rust build.
$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('xharness-bridge-signer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$savedSigningEnv = @{}
foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')) {
    $savedSigningEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
}
function Invoke-TestSigner([string[]] $SignerArgs) {
    # Capture signer output: even synthetic private material must not enter CI logs.
    $signerOutput = & npm exec --yes --package '@tauri-apps/cli@2.11.4' -- tauri signer @SignerArgs 2>&1
    if ($LASTEXITCODE) {
        $safeError = ($signerOutput | ForEach-Object { "$_" } | Where-Object { $_ -match '^\s*(error:|Error:|Usage:)' }) -join ' '
        $safeError = $safeError -replace '[A-Za-z0-9+/=]{40,}', '[redacted]'
        throw "Synthetic signer $($SignerArgs[0]) failed: $safeError"
    }
}
function Assert-TestSignature([string] $Package, [string] $Signature, [string] $Key, [bool] $Valid) {
    $null = & node (Join-Path $PSScriptRoot 'verify-updater-package.mjs') $Package $Signature $Key 2>&1
    if (($LASTEXITCODE -eq 0) -ne $Valid) { throw 'Unexpected fixture signature verification result' }
}
try {
    $oldKey = Join-Path $fixtureRoot 'old.key'
    $newKey = Join-Path $fixtureRoot 'new.key'
    foreach ($key in @($oldKey, $newKey)) {
        Invoke-TestSigner -SignerArgs @('generate', '--ci', '--password', 'synthetic-test-only', '--write-keys', $key)
    }
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'synthetic-test-only'
    $bridge = Join-Path $fixtureRoot 'bridge.fixture'
    $next = Join-Path $fixtureRoot 'next.fixture'
    [IO.File]::WriteAllText($bridge, 'Synthetic bridge: upstream endpoint and new public key. Not an installer.')
    [IO.File]::WriteAllText($next, 'Synthetic subsequent upstream update. Not an installer.')
    $before = (Get-FileHash -LiteralPath $bridge -Algorithm SHA256).Hash
    $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($newKey).Trim()
    Invoke-TestSigner -SignerArgs @('sign', $bridge)
    Move-Item -LiteralPath "$bridge.sig" -Destination "$bridge.upstream.sig"
    $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($oldKey).Trim()
    Invoke-TestSigner -SignerArgs @('sign', $bridge)
    $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($newKey).Trim()
    Invoke-TestSigner -SignerArgs @('sign', $next)
    if ((Get-FileHash -LiteralPath $bridge -Algorithm SHA256).Hash -ne $before) { throw 'Signer changed package bytes' }
    Assert-TestSignature $bridge "$bridge.sig" "$oldKey.pub" $true
    Assert-TestSignature $bridge "$bridge.upstream.sig" "$newKey.pub" $true
    Assert-TestSignature $next "$next.sig" "$newKey.pub" $true
    Assert-TestSignature $bridge "$bridge.sig" "$newKey.pub" $false
    Assert-TestSignature $next "$next.sig" "$oldKey.pub" $false
    [IO.File]::AppendAllText($bridge, 'TAMPERED')
    Assert-TestSignature $bridge "$bridge.sig" "$oldKey.pub" $false
    Write-Output 'Real Tauri signer: unchanged bridge, old/new signatures, next hop, wrong keys and tampering passed. Synthetic fixtures only; native installation not tested.'
} finally {
    foreach ($name in $savedSigningEnv.Keys) {
        if ($null -eq $savedSigningEnv[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($name, $savedSigningEnv[$name], 'Process')
        }
    }
}
