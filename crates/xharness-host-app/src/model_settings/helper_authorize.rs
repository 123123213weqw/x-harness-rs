//! One-time, explicit authorization without a Host runtime, RPC or data lease.
//! Only presence counts leave this process; no credential value is printed.
#![forbid(unsafe_code)]
use std::{collections::BTreeSet, ffi::OsString, path::PathBuf};

pub(super) struct Request {
    state: PathBuf,
    references: BTreeSet<(bool, String)>,
}
const ERROR: &str =
    "Expected --state-dir PATH and 1-256 --model-ref REF / --channel-ref REF arguments";

pub(super) fn parse(arguments: &[OsString]) -> Result<Request, String> {
    let mut state = None;
    let mut references = BTreeSet::new();
    for pair in arguments.chunks(2) {
        if pair.len() != 2 {
            return Err(ERROR.into());
        }
        match pair[0].to_str() {
            Some("--state-dir") if state.is_none() => state = Some(PathBuf::from(&pair[1])),
            Some(flag @ ("--model-ref" | "--channel-ref")) => {
                let reference = pair[1]
                    .to_str()
                    .filter(|r| super::valid_credential_reference(r))
                    .ok_or(ERROR)?;
                references.insert((flag == "--channel-ref", reference.to_owned()));
            }
            _ => return Err(ERROR.into()),
        }
        if references.len() > 256 {
            return Err(ERROR.into());
        }
    }
    let state = state
        .filter(|p| p.is_absolute() && p.is_dir())
        .ok_or(ERROR)?;
    if references.is_empty() {
        return Err(ERROR.into());
    }
    Ok(Request { state, references })
}

#[cfg(target_os = "macos")]
pub(super) async fn authorize(arguments: &[OsString]) -> Result<usize, String> {
    use super::{CredentialStore, NativeCredentialStore};
    let request = parse(arguments)?;
    let models = NativeCredentialStore::new(&request.state)?;
    let channels = NativeCredentialStore::for_channels(&request.state)?;
    if models.helper.is_none() || channels.helper.is_none() {
        return Err("Install the pinned local helper before one-time authorization".into());
    }
    let mut count = 0;
    for (channel, reference) in request.references {
        let store = if channel { &channels } else { &models };
        // Return only presence. Values never become a CLI response, file, log,
        // environment override, server route, or persistent plaintext fallback.
        if store.get(&reference).await?.is_some() {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    #[test]
    fn explicit_narrow_arguments_and_no_secret_return_contract() {
        let path = std::env::temp_dir();
        let p = path.to_str().unwrap();
        let request = parse(&args(&[
            "--state-dir",
            p,
            "--model-ref",
            "API_KEY",
            "--channel-ref",
            "BOT_KEY",
            "--model-ref",
            "API_KEY",
        ]))
        .unwrap();
        assert_eq!(request.state, path);
        assert_eq!(request.references.len(), 2);
        for values in [
            vec!["--state-dir", p],
            vec!["--state-dir", p, "--secret", "value"],
            vec!["--state-dir", p, "--model-ref", "../KEY"],
            vec!["--state-dir", p, "--state-dir", p, "--model-ref", "KEY"],
            vec!["--model-ref", "KEY"],
            vec!["--state-dir", p, "--model-ref"],
        ] {
            assert!(parse(&args(&values)).is_err());
        }
    }
}
