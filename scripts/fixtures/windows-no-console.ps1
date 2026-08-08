# Synthetic native regression only. No user data or external network access.
$ErrorActionPreference = 'Stop'
# Optional synthetic-test evidence, separate from the streams being asserted.
# A timeout before 'started' means PowerShell never reached the script; a
# timeout between 'started' and 'native-probe-ready' isolates probe setup.
$probeClock = [Diagnostics.Stopwatch]::StartNew()
function Save-ProbeStage([string] $stage) {
    if ($env:XHARNESS_CONSOLE_PROBE_PROGRESS) {
        [IO.File]::AppendAllText($env:XHARNESS_CONSOLE_PROBE_PROGRESS,
            "$stage $($probeClock.ElapsedMilliseconds)ms`n")
    }
}
Save-ProbeStage 'started'
# Emit a P/Invoke stub directly instead of launching the runtime C# compiler.
# Add-Type startup can stall on loaded CI hosts; it is not part of the process
# behavior under test. Keep the real Win32 HWND check and the 30-second gate.
$assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('XHarnessConsoleProbe'),
    [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('ConsoleProbe')
$typeAttributes = [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Sealed -bor [Reflection.TypeAttributes]::Abstract
$probeType = $module.DefineType('XHarnessConsoleProbe', $typeAttributes)
$methodAttributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
$method = $probeType.DefinePInvokeMethod(
    'GetConsoleWindow', 'kernel32.dll', $methodAttributes,
    [Reflection.CallingConventions]::Standard, [IntPtr], [Type[]]@(),
    [Runtime.InteropServices.CallingConvention]::Winapi,
    [Runtime.InteropServices.CharSet]::Auto)
$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
$probe = $probeType.CreateType()
Save-ProbeStage 'native-probe-ready'
$consoleWindow = $probe.GetMethod('GetConsoleWindow').Invoke($null, @())
# A headless PowerShell can retain internal console process membership. That
# does not imply a window; this fixture checks the HWND, not process count.
if ($consoleWindow -ne [IntPtr]::Zero) {
    throw 'Non-interactive child has a console window'
}
Save-ProbeStage 'console-checked'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Out.Write('no-console-stdout-你好')
[Console]::Error.Write('no-console-stderr-错误')
Save-ProbeStage 'streams-written'
exit 17
