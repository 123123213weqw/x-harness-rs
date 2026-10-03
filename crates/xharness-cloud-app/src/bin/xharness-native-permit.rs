//! Trusted VM-local administration, never expose this CLI as a model tool.
use std::{
    io::{self, Read},
    path::PathBuf,
};
use xharness_cloud::*;
use xharness_cloud_app::*;
fn invalid() -> CloudError {
    CloudError::new(ErrorCode::InvalidRequest, "invalid native permit command")
}
fn input<T: serde::de::DeserializeOwned>() -> CloudResult<T> {
    let mut data = Vec::new();
    io::stdin()
        .take(65537)
        .read_to_end(&mut data)
        .map_err(|_| invalid())?;
    if data.len() > 65536 {
        return Err(invalid());
    }
    serde_json::from_slice(&data).map_err(|_| invalid())
}
fn run() -> CloudResult<serde_json::Value> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--journal-dir") {
        return Err(invalid());
    }
    let directory = PathBuf::from(args.next().ok_or_else(invalid)?);
    let action = args.next().ok_or_else(invalid)?;
    let generation = if action == "launch" {
        Some(
            args.next()
                .ok_or_else(invalid)?
                .parse::<u64>()
                .map_err(|_| invalid())?,
        )
    } else {
        None
    };
    if args.next().is_some()
        || !matches!(
            action.as_str(),
            "initialize" | "get" | "transition" | "launch"
        )
    {
        return Err(invalid());
    }
    let journal = NativePermitJournal::open(&directory)?;
    let value = match action.as_str() {
        "initialize" => serde_json::to_value(journal.initialize(input()?)?),
        "get" => serde_json::to_value(journal.snapshot()?),
        "transition" => serde_json::to_value(journal.transition(&input()?)?),
        "launch" => serde_json::to_value(journal.launch(Counter(generation.ok_or_else(invalid)?))?),
        _ => return Err(invalid()),
    };
    value.map_err(|_| invalid())
}
fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
