#[cfg(not(windows))]
fn main() {
    eprintln!("windows-acl-run: this runner is available only on Windows");
    std::process::exit(127);
}

#[cfg(windows)]
mod windows_runner {
    use std::{
        env,
        ffi::{OsStr, OsString},
        fs,
        path::{Path, PathBuf},
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    use xharness_sandbox::{temp_write_sid, workspace_write_sid};
    use xharness_win32::{
        grant_write, revoke_write, RestrictedChild, RestrictedToken, Sid, TokenMode,
    };

    const SIGNATURE: &str = "windows-acl-run";

    #[derive(Debug)]
    struct Arguments {
        workspace: PathBuf,
        temp_root: PathBuf,
        cwd: PathBuf,
        allowed_cwd_roots: Vec<PathBuf>,
        mode: TokenMode,
        program: OsString,
        args: Vec<OsString>,
    }

    pub fn main() {
        match run() {
            Ok(code) => process::exit(code as i32),
            Err(error) => {
                eprintln!("{SIGNATURE}: {error}");
                process::exit(127);
            }
        }
    }

    fn run() -> Result<u32, String> {
        let args = parse(env::args_os().skip(1).collect())?;
        let workspace = canonical_directory("--workspace", &args.workspace)?;
        let temp_root = canonical_directory("--temp-root", &args.temp_root)?;
        let cwd = canonical_directory("--cwd", &args.cwd)?;
        let allowed = args
            .allowed_cwd_roots
            .iter()
            .map(|path| canonical_directory("--allow-cwd-root", path))
            .collect::<Result<Vec<_>, _>>()?;
        if !path_is_within(&cwd, &workspace)
            && !allowed.iter().any(|root| path_is_within(&cwd, root))
        {
            return Err(format!(
                "working directory {} is outside the workspace and allowed roots",
                cwd.display()
            ));
        }
        if path_is_within(&temp_root, &workspace) {
            return Err("temporary root must be outside the workspace".to_owned());
        }

        let workspace_sid = if args.mode == TokenMode::WorkspaceWrite {
            Some(
                Sid::from_string(OsStr::new(&workspace_write_sid(&workspace)))
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        if let Some(sid) = &workspace_sid {
            grant_write(&workspace, sid).map_err(|error| error.to_string())?;
        }

        let private_temp = if args.mode == TokenMode::WorkspaceWrite {
            Some(create_private_temp(&temp_root)?)
        } else {
            None
        };
        let temp_sid = if let Some(temp) = &private_temp {
            match Sid::from_string(OsStr::new(&temp_write_sid(temp))) {
                Ok(sid) => Some(sid),
                Err(error) => {
                    let _ = fs::remove_dir_all(temp);
                    return Err(error.to_string());
                }
            }
        } else {
            None
        };
        if let (Some(temp), Some(sid)) = (&private_temp, &temp_sid) {
            if let Err(error) = grant_write(temp, sid) {
                let _ = fs::remove_dir_all(temp);
                return Err(error.to_string());
            }
        }
        let capabilities = workspace_sid
            .iter()
            .chain(temp_sid.iter())
            .collect::<Vec<_>>();

        let result = (|| {
            let token = RestrictedToken::new(args.mode, &capabilities)
                .map_err(|error| error.to_string())?;
            if let Some(temp) = &private_temp {
                // SAFETY: the runner is single-threaded before it launches the
                // child; the child intentionally inherits these two values.
                unsafe {
                    env::set_var("TMP", temp);
                    env::set_var("TEMP", temp);
                }
            }
            let child = RestrictedChild::spawn_inherited(&token, &args.program, &args.args, &cwd)
                .map_err(|error| error.to_string())?;
            child.wait().map_err(|error| error.to_string())
        })();

        if let (Some(temp), Some(sid)) = (&private_temp, &temp_sid) {
            if let Err(error) = revoke_write(temp, sid) {
                eprintln!("{SIGNATURE}: cleanup: {error}");
            }
            if let Err(error) = fs::remove_dir_all(temp) {
                eprintln!(
                    "{SIGNATURE}: cleanup: remove private temp {}: {error}",
                    temp.display()
                );
            }
        }
        result
    }

    fn parse(raw: Vec<OsString>) -> Result<Arguments, String> {
        let mut workspace = None;
        let mut temp_root = None;
        let mut cwd = None;
        let mut allowed_cwd_roots = Vec::new();
        let mut mode = None;
        let mut index = 0usize;
        while index < raw.len() {
            if raw[index] == "--" {
                index += 1;
                break;
            }
            let option = raw[index].to_string_lossy();
            index += 1;
            let value = raw
                .get(index)
                .cloned()
                .ok_or_else(|| format!("missing value after {option}"))?;
            index += 1;
            match option.as_ref() {
                "--workspace" => workspace = Some(PathBuf::from(value)),
                "--temp-root" => temp_root = Some(PathBuf::from(value)),
                "--cwd" => cwd = Some(PathBuf::from(value)),
                "--allow-cwd-root" => allowed_cwd_roots.push(PathBuf::from(value)),
                "--mode" => {
                    mode = Some(match value.to_string_lossy().as_ref() {
                        "read-only" => TokenMode::ReadOnly,
                        "workspace-write" => TokenMode::WorkspaceWrite,
                        other => return Err(format!("unknown mode: {other}")),
                    });
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }
        let program = raw
            .get(index)
            .cloned()
            .ok_or_else(|| "missing command after --".to_owned())?;
        if program.is_empty() {
            return Err("command after -- must not be empty".to_owned());
        }
        Ok(Arguments {
            workspace: workspace.ok_or_else(|| "missing --workspace".to_owned())?,
            temp_root: temp_root.ok_or_else(|| "missing --temp-root".to_owned())?,
            cwd: cwd.ok_or_else(|| "missing --cwd".to_owned())?,
            allowed_cwd_roots,
            mode: mode.ok_or_else(|| "missing --mode".to_owned())?,
            program,
            args: raw[index + 1..].to_vec(),
        })
    }

    fn canonical_directory(label: &str, path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("{label} {}: {error}", path.display()))?;
        if canonical.is_dir() {
            Ok(canonical)
        } else {
            Err(format!("{label} is not a directory: {}", path.display()))
        }
    }

    fn path_is_within(path: &Path, root: &Path) -> bool {
        let components = |path: &Path| {
            path.components()
                .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
                .collect::<Vec<_>>()
        };
        components(path).starts_with(&components(root))
    }

    fn create_private_temp(root: &Path) -> Result<PathBuf, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for sequence in 0..128u32 {
            let candidate = root.join(format!("xharness-{}-{nonce}-{sequence}", process::id()));
            match fs::create_dir(&candidate) {
                Ok(()) => return Ok(candidate),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!(
                        "create private temp {}: {error}",
                        candidate.display()
                    ));
                }
            }
        }
        Err("could not allocate a unique private temp directory".to_owned())
    }
}

#[cfg(windows)]
fn main() {
    windows_runner::main();
}
