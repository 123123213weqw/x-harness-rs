# Fast installer-logic fixture; does not compile Rust or run an application.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Fixture compilation is restricted to disposable CI'
}
$fixture = Join-Path $env:RUNNER_TEMP ('xharness-fixture-' + [guid]::NewGuid().ToString('N') + '.exe')
Add-Type -OutputAssembly $fixture -OutputType ConsoleApplication -TypeDefinition @'
[assembly: System.Reflection.AssemblyProduct("XHarness")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]
public static class Fixture { public static void Main() {} }
'@
& "$PSScriptRoot/test-install-ownership-logic.ps1" -DesktopBinary $fixture
if ($LASTEXITCODE) { exit $LASTEXITCODE }
