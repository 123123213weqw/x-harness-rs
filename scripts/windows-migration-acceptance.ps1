# Deliberately refuses local/self-hosted execution: changes test-user trust and installs apps.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Native migration acceptance requires a disposable GitHub-hosted Windows runner'
}
$fixtureRoot = Join-Path $env:RUNNER_TEMP 'xharness-migration-tls'
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
# Trust only inside this ephemeral runner. No TLS verification is disabled.
$cert = New-SelfSignedCertificate -DnsName 'github.com' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1)
$password = ConvertTo-SecureString 'disposable-ci-only' -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath "$fixtureRoot/proxy.pfx" -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath "$fixtureRoot/proxy.cer" | Out-Null
$trusted = Import-Certificate -FilePath "$fixtureRoot/proxy.cer" -CertStoreLocation 'Cert:\CurrentUser\Root'
try {
    $env:MIGRATION_TEST_PFX = "$fixtureRoot/proxy.pfx"
    node scripts/windows-migration-acceptance.mjs run
    if ($LASTEXITCODE) { throw 'Native two-hop acceptance failed; do not publish old feed' }
} finally {
    # Exact certificates created above, never a broad certificate-store operation.
    Remove-Item -LiteralPath "Cert:\CurrentUser\Root\$($trusted.Thumbprint)" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
}
exit 0
