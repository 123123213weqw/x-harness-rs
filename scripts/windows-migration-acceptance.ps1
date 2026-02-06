# Deliberately refuses local/self-hosted execution: changes test-user trust and installs apps.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Native migration acceptance requires a disposable GitHub-hosted Windows runner'
}
$fixtureRoot = Join-Path $env:RUNNER_TEMP 'xharness-migration-tls'
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
Write-Output 'Creating disposable TLS fixture certificate.'
# Trust only inside this ephemeral runner. No TLS verification is disabled.
$cert = New-SelfSignedCertificate -DnsName 'github.com' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
Write-Output 'Exporting disposable TLS fixture certificate.'
$password = ConvertTo-SecureString 'disposable-ci-only' -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath "$fixtureRoot/proxy.pfx" -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath "$fixtureRoot/proxy.cer" | Out-Null
Write-Output 'Trusting disposable TLS fixture in the ephemeral runner machine store (no user trust dialog).'
$trustStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
$trustStore.Open('ReadWrite')
try { $trustStore.Add($cert) } finally { $trustStore.Close() }
Write-Output 'Starting native migration test.'
# WebView2 150+ ignores environment overrides for elevated hosts. Scope the
# documented machine policy to this test executable on the disposable runner.
$debugPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$debugName = 'xharness-desktop.exe'
if (Get-ItemProperty -LiteralPath $debugPolicy -Name $debugName -ErrorAction SilentlyContinue) {
    throw 'Refuse to overwrite pre-existing WebView2 test policy'
}
New-Item -Path $debugPolicy -Force | Out-Null
New-ItemProperty -LiteralPath $debugPolicy -Name $debugName -PropertyType String -Value '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1' | Out-Null
try {
    $env:MIGRATION_TEST_PFX = "$fixtureRoot/proxy.pfx"
    node scripts/windows-migration-acceptance.mjs run
    if ($LASTEXITCODE) { throw 'Native two-hop acceptance failed; do not publish old feed' }
} finally {
    Remove-ItemProperty -LiteralPath $debugPolicy -Name $debugName -ErrorAction SilentlyContinue
    # Exact certificates created above, never a broad certificate-store operation.
    Remove-Item -LiteralPath "Cert:\LocalMachine\Root\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
}
exit 0
