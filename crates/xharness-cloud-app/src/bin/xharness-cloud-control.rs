//! Trusted local/SSH administrative entrypoint, not a public unauthenticated API.
use serde::Serialize;
use std::{
    io::{self, Read},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use xharness_cloud::*;
use xharness_cloud_app::SqliteCloudTaskStore;

fn invalid() -> CloudError {
    CloudError::new(ErrorCode::InvalidRequest, "invalid cloud control command")
}
fn input() -> CloudResult<Vec<u8>> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 256 * 1024 {
        return Err(invalid());
    }
    Ok(bytes)
}
fn output(value: &impl Serialize) -> CloudResult<()> {
    let data = serde_json::to_string(value).map_err(|_| invalid())?;
    println!("{data}");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        // Static errors only: never echo stdin, resolved credentials or paths.
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> CloudResult<()> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--state-dir") {
        return Err(invalid());
    }
    let directory = PathBuf::from(args.next().ok_or_else(invalid)?);
    let action = args.next().ok_or_else(invalid)?;
    let owner = if action == "register" {
        None
    } else {
        Some(Id::new(args.next().ok_or_else(invalid)?)?)
    };
    let object = if matches!(action.as_str(), "get" | "receipt") {
        Some(Id::new(args.next().ok_or_else(invalid)?)?)
    } else {
        None
    };
    if args.next().is_some()
        || !matches!(
            action.as_str(),
            "register" | "admit" | "list" | "environments" | "get" | "receipt"
        )
    {
        return Err(invalid());
    }
    let store = SqliteCloudTaskStore::open(&directory, AdmissionLimits::default())?;
    match action.as_str() {
        "register" => {
            let environment: RegisteredEnvironment =
                serde_json::from_slice(&input()?).map_err(|_| invalid())?;
            store.register_environment(environment)?;
            output(&serde_json::json!({"registered":true}))
        }
        "admit" => {
            let command = CommandEnvelope::decode(&input()?, &AdmissionLimits::default())?;
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| invalid())?
                .as_millis();
            let now = Counter(u64::try_from(time).map_err(|_| invalid())?);
            output(&store.admit(owner.as_ref().ok_or_else(invalid)?, &command, now)?)
        }
        "environments" => output(&store.environments(owner.as_ref().ok_or_else(invalid)?)?),
        "list" => output(&store.tasks(owner.as_ref().ok_or_else(invalid)?)?),
        "get" => output(&store.get(
            owner.as_ref().ok_or_else(invalid)?,
            object.as_ref().ok_or_else(invalid)?,
        )?),
        "receipt" => output(&store.receipt(
            owner.as_ref().ok_or_else(invalid)?,
            object.as_ref().ok_or_else(invalid)?,
        )?),
        _ => Err(invalid()),
    }
}
