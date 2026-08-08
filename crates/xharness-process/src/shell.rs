//! Shell discovery and invocation, shared by command tools and interactive terminals.
//! Discovery never executes a user command. A selected invocation is never replayed
//! with another interpreter after it has started.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};
use thiserror::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Sh,
    PowerShellCore,
    WindowsPowerShell,
    Cmd,
}

impl ShellKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Bash => "Bash",
            Self::Zsh => "Zsh",
            Self::Sh => "POSIX sh",
            Self::PowerShellCore => "PowerShell Core",
            Self::WindowsPowerShell => "Windows PowerShell",
            Self::Cmd => "Windows CMD",
        }
    }
    fn from_path(path: &Path) -> Option<Self> {
        match path.file_stem()?.to_str()?.to_ascii_lowercase().as_str() {
            "bash" => Some(Self::Bash),
            "zsh" => Some(Self::Zsh),
            "sh" => Some(Self::Sh),
            "pwsh" => Some(Self::PowerShellCore),
            "powershell" => Some(Self::WindowsPowerShell),
            "cmd" => Some(Self::Cmd),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shell {
    pub kind: ShellKind,
    pub program: PathBuf,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ShellError {
    #[error("configured shell {0:?} is unavailable or unsupported; configure XHARNESS_SHELL with an executable bash, zsh, sh, pwsh, powershell or cmd path")]
    InvalidConfiguration(OsString),
    #[error("no supported shell is available; install a shell or configure XHARNESS_SHELL")]
    Unavailable,
}

impl Shell {
    pub fn discover() -> Result<Self, ShellError> {
        ShellSearch::from_environment().resolve(is_executable)
    }

    /// An explicit selection must exist and have a supported dialect. Never silently
    /// substitute a different language for a pinned but missing interpreter.
    pub fn configured(program: impl Into<OsString>) -> Result<Self, ShellError> {
        let mut search = ShellSearch::from_environment();
        search.configured = Some(program.into());
        search.resolve(is_executable)
    }

    pub fn command_args(&self, command: &str) -> Vec<OsString> {
        let strings: Vec<String> = match self.kind {
            ShellKind::Bash => vec![
                "--noprofile".into(),
                "--norc".into(),
                "-o".into(),
                "pipefail".into(),
                "-c".into(),
                command.into(),
            ],
            ShellKind::Zsh => vec![
                "-f".into(),
                "-o".into(),
                "pipefail".into(),
                "-c".into(),
                command.into(),
            ],
            ShellKind::Sh => vec!["-c".into(), command.into()],
            ShellKind::PowerShellCore | ShellKind::WindowsPowerShell => {
                // Compatible with Windows PowerShell 5.1. Core 7.3+ additionally
                // turns every failing native command into a terminating error.
                // On 5.1, only the last native exit code is automatically propagated;
                // scripts must explicitly check earlier native commands.
                let script = format!("$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; \
                    if ($PSVersionTable.PSVersion -ge [version]'7.3') {{ $PSNativeCommandUseErrorActionPreference=$true }}; \
                    [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); \
                    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; \
                    try {{ . {{\n{command}\n}}; $__xh_ok=$?; $__xh_code=$LASTEXITCODE }} \
                    catch {{ [Console]::Error.WriteLine($_.ToString()); if ($_.Exception.PSObject.Properties['ExitCode']) {{ exit $_.Exception.ExitCode }}; exit 1 }}; \
                    if ($__xh_code -ne 0) {{ exit $__xh_code }}; if (-not $__xh_ok) {{ exit 1 }}");
                vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    script,
                ]
            }
            ShellKind::Cmd => vec!["/D".into(), "/S".into(), "/C".into(), command.into()],
        };
        strings.into_iter().map(OsString::from).collect()
    }

    /// PTYs do not use the batch wrapper or -NonInteractive.
    pub fn interactive_args(&self) -> Vec<OsString> {
        match self.kind {
            ShellKind::PowerShellCore | ShellKind::WindowsPowerShell => {
                vec!["-NoLogo".into(), "-NoProfile".into()]
            }
            ShellKind::Cmd => vec!["/D".into()],
            _ => Vec::new(),
        }
    }

    pub fn syntax_hint(&self) -> &'static str {
        match self.kind {
            ShellKind::WindowsPowerShell => "Use Windows PowerShell 5.1-compatible syntax: no &&/|| or Bash heredocs; use $env:NAME. Check $LASTEXITCODE after each native command when later commands could mask failure. The wrapper propagates the last native exit code.",
            ShellKind::PowerShellCore => "Use PowerShell syntax and $env:NAME, not Bash heredocs. The Core version is not assumed; prefer syntax compatible with 5.1 or inspect $PSVersionTable. Native-command errors terminate on Core 7.3+; otherwise check $LASTEXITCODE after native commands.",
            ShellKind::Cmd => "Use CMD syntax and %NAME%, not PowerShell or Bash syntax. CMD /D disables AutoRun. Use ordinary drive/relative paths, not verbatim \\\\?\\ paths; prefer direct program + args for those. Explicitly propagate failing exit codes in multi-command scripts.",
            ShellKind::Sh => "Use POSIX sh syntax, not Bash-specific arrays or [[. Pipeline exit status follows POSIX sh; pipefail is not assumed.",
            ShellKind::Bash | ShellKind::Zsh => "Pipeline failures propagate because pipefail is enabled. Use the selected shell's syntax. No login/profile startup is loaded for batch commands.",
        }
    }
}

/// Explicit inputs make absence/fallback testable without modifying a user's PATH.
#[derive(Clone, Debug)]
pub struct ShellSearch {
    pub configured: Option<OsString>,
    pub user_shell: Option<OsString>,
    pub paths: Vec<PathBuf>,
    pub windows: bool,
    pub system_root: PathBuf,
    pub program_files: PathBuf,
}

impl ShellSearch {
    pub fn from_environment() -> Self {
        Self {
            configured: std::env::var_os("XHARNESS_SHELL"),
            user_shell: std::env::var_os("SHELL"),
            paths: std::env::split_paths(&executable_search_path()).collect(),
            windows: cfg!(windows),
            system_root: std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows")),
            program_files: std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Program Files")),
        }
    }

    pub fn resolve(&self, available: impl Fn(&Path) -> bool) -> Result<Shell, ShellError> {
        let find = |value: &OsStr| -> Option<Shell> {
            let input = Path::new(value);
            let path = if self.windows && input.extension().is_none() {
                input.with_extension("exe")
            } else {
                input.to_owned()
            };
            let path = path.as_path();
            let kind = ShellKind::from_path(path)?;
            let program = if path.is_absolute() {
                available(path).then(|| path.to_owned())
            } else if path.components().count() == 1 {
                self.paths
                    .iter()
                    .map(|root| root.join(path))
                    .find(|candidate| available(candidate))
            } else {
                None
            }?;
            Some(Shell { kind, program })
        };
        if let Some(configured) = &self.configured {
            return find(configured)
                .ok_or_else(|| ShellError::InvalidConfiguration(configured.clone()));
        }
        if let Some(user) = &self.user_shell {
            if let Some(shell) = find(user) {
                return Ok(shell);
            }
        }
        let candidates = if self.windows {
            vec![
                PathBuf::from("pwsh.exe"),
                self.program_files
                    .join("PowerShell")
                    .join("7")
                    .join("pwsh.exe"),
                PathBuf::from("powershell.exe"),
                self.system_root
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe"),
                self.system_root.join("System32").join("cmd.exe"),
            ]
        } else {
            vec![
                PathBuf::from("bash"),
                PathBuf::from("/bin/bash"),
                PathBuf::from("zsh"),
                PathBuf::from("/bin/zsh"),
                PathBuf::from("sh"),
                PathBuf::from("/bin/sh"),
            ]
        };
        candidates
            .iter()
            .find_map(|path| find(path.as_os_str()))
            .ok_or(ShellError::Unavailable)
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Package helpers and common GUI-launch search paths, without changing global PATH.
pub fn executable_search_path() -> OsString {
    let mut paths = Vec::<PathBuf>::new();
    let mut push = |path: PathBuf| {
        if !path.as_os_str().is_empty() && !paths.contains(&path) {
            paths.push(path);
        }
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push(parent.to_owned());
        }
    }
    if let Some(inherited) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&inherited) {
            push(path);
        }
    }
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            push(home.join(".local/bin"));
            push(home.join(".cargo/bin"));
        }
        for path in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            push(PathBuf::from(path));
        }
    }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        push(root.join("System32"));
        push(root);
    }
    std::env::join_paths(paths).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        std::env::temp_dir().join("xharness-shell-discovery-fixture")
    }
    fn search() -> ShellSearch {
        ShellSearch {
            configured: None,
            user_shell: None,
            paths: vec![root().join("helpers")],
            windows: true,
            system_root: root().join("windows"),
            program_files: root().join("programs"),
        }
    }
    #[test]
    fn windows_without_ps7_uses_builtin_powershell_then_cmd() {
        let search = search();
        let ps = search
            .system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let cmd = search.system_root.join("System32").join("cmd.exe");
        assert_eq!(search.resolve(|p| p == ps || p == cmd).unwrap().program, ps);
        assert_eq!(search.resolve(|p| p == cmd).unwrap().kind, ShellKind::Cmd);
        assert_eq!(search.resolve(|_| false), Err(ShellError::Unavailable));
    }
    #[test]
    fn configured_selection_is_pinned_not_silently_replaced() {
        let mut search = search();
        search.configured = Some(root().join("missing").join("pwsh.exe").into_os_string());
        assert!(matches!(
            search.resolve(|_| true),
            Ok(Shell {
                kind: ShellKind::PowerShellCore,
                ..
            })
        ));
        assert!(matches!(
            search.resolve(|p| p.ends_with("powershell.exe")),
            Err(ShellError::InvalidConfiguration(_))
        ));
        search.configured = Some(root().join("helpers").join("python.exe").into_os_string());
        assert!(search.resolve(|_| true).is_err());
        search.configured = Some("pwsh".into());
        assert_eq!(
            search.resolve(|p| p.ends_with("pwsh.exe")).unwrap().kind,
            ShellKind::PowerShellCore
        );
    }
    #[test]
    fn path_and_installed_ps7_precede_51() {
        let search = search();
        assert_eq!(
            search
                .resolve(|p| p.ends_with("pwsh.exe") || p.ends_with("powershell.exe"))
                .unwrap()
                .program,
            root().join("helpers").join("pwsh.exe")
        );
        assert_eq!(
            search
                .resolve(|p| p.is_absolute() && !p.starts_with(root().join("helpers")))
                .unwrap()
                .kind,
            ShellKind::PowerShellCore
        );
    }
    #[test]
    fn stale_user_shell_does_not_disable_posix_fallback() {
        let mut search = search();
        search.windows = false;
        search.user_shell = Some(root().join("missing").join("zsh").into_os_string());
        assert_eq!(
            search
                .resolve(|p| p == root().join("helpers").join("sh"))
                .unwrap()
                .kind,
            ShellKind::Sh
        );
        assert_eq!(
            search
                .resolve(|p| p == root().join("missing").join("zsh"))
                .unwrap()
                .kind,
            ShellKind::Zsh
        );
    }
    #[test]
    fn batch_and_interactive_arguments_are_distinct_and_command_is_not_requoted() {
        let command = "printf '%s' 'hello world; literal'";
        let shell = Shell {
            kind: ShellKind::Bash,
            program: "/bin/bash".into(),
        };
        assert_eq!(shell.command_args(command).last().unwrap(), command);
        let shell = Shell {
            kind: ShellKind::WindowsPowerShell,
            program: "powershell.exe".into(),
        };
        assert!(!shell
            .interactive_args()
            .iter()
            .any(|a| a == "-NonInteractive"));
        let args = shell.command_args("Write-Output '中文'; exit 7");
        assert!(args
            .last()
            .unwrap()
            .to_string_lossy()
            .contains("Write-Output '中文'; exit 7"));
        assert!(shell.syntax_hint().contains("5.1"));
    }
}
