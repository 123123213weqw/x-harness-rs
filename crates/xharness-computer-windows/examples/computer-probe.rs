//! Explicit offline acceptance fixture. Never run by ordinary unit tests.
#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|v| v == "--computer-worker")
    {
        return xharness_computer_windows::run_worker();
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(probe_main())
}
#[cfg(windows)]
async fn probe_main() -> Result<(), Box<dyn std::error::Error>> {
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;
    use xharness_computer::{ComputerDriver, ComputerRequest};
    use xharness_computer_windows::WindowsComputer;
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|v| v == "--computer-worker") {
        return xharness_computer_windows::run_worker();
    }
    #[cfg(feature = "native-acceptance")]
    if args.get(1).is_some_and(|v| v == "--native-acceptance") {
        return xharness_computer_windows::run_native_acceptance().await;
    }
    let fixture = args
        .get(1)
        .ok_or("usage: computer-probe <fixture.json> [host.exe]")?;
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(fixture)?)?;
    if value["authorized_disposable_desktop"] != true {
        return Err("explicit disposable desktop authorization is required".into());
    }
    let driver = WindowsComputer::with_worker_executable(
        args.get(2)
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe()?),
    );
    let requests = value["requests"]
        .as_array()
        .ok_or("requests array is required")?;
    let mut frame = None;
    for (index, value) in requests.iter().enumerate() {
        let mut request: ComputerRequest = serde_json::from_value(value.clone())?;
        if request.frame_id.as_deref() == Some("$last") {
            request.frame_id = frame.clone();
        }
        let output = driver.execute(request, CancellationToken::new()).await?;
        frame = output.value["frame_id"].as_str().map(str::to_owned);
        if let Some(screenshot) = output.screenshot {
            std::fs::write(
                PathBuf::from(fixture).with_extension(format!("{index}.png")),
                screenshot.png,
            )?;
        }
        println!(
            "{}",
            serde_json::json!({"step":index,"result":output.value})
        );
    }
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("native computer probe requires Windows");
}
