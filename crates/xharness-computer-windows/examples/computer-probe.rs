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
    #[cfg(feature = "native-acceptance")]
    if args.get(1).is_some_and(|v| v == "--browser-acceptance") {
        return browser_acceptance(args.get(2).ok_or("missing lab directory")?).await;
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
/// Lab-only, persistent driver bridge. The model and its credentials remain
/// outside the VM; requests are typed ComputerRequests, never shell commands.
#[cfg(all(windows, feature = "native-acceptance"))]
async fn browser_acceptance(directory: &std::ffi::OsStr) -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    use tokio_util::sync::CancellationToken;
    use xharness_computer::{ComputerDriver, ComputerRequest};
    if std::env::var("XHARNESS_DISPOSABLE_COMPUTER_VM").as_deref()
        != Ok("66b64058-bdcc-43e9-85ee-55a79fe2e875")
    {
        return Err("browser acceptance requires the disposable VM guard".into());
    }
    let directory = PathBuf::from(directory);
    std::fs::create_dir_all(&directory)?;
    let driver = xharness_computer_windows::WindowsComputer::new()?;
    let deadline = Instant::now() + Duration::from_secs(1200);
    for index in 0..80 {
        let input = directory.join(format!("request-{index}.json"));
        while !input.exists() {
            if directory.join("stop").exists() || Instant::now() > deadline {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let bytes = std::fs::read(&input)?;
        if bytes.len() > 128 * 1024 {
            return Err("lab request too large".into());
        }
        let started = Instant::now();
        let request: ComputerRequest = serde_json::from_slice(&bytes)?;
        let result = driver.execute(request, CancellationToken::new()).await;
        let value = match result {
            Ok(output) => {
                let screenshot = if let Some(png) = output.screenshot {
                    let name = format!("screenshot-{index}.png");
                    std::fs::write(directory.join(&name), png.png)?;
                    Some(name)
                } else {
                    None
                };
                serde_json::json!({"id":index,"ok":true,"elapsed_ms":started.elapsed().as_millis(),"result":output.value,"screenshot":screenshot})
            }
            Err(error) => {
                serde_json::json!({"id":index,"ok":false,"elapsed_ms":started.elapsed().as_millis(),"error":{"code":error.code,"message":error.message,"retryable":error.retryable}})
            }
        };
        let temporary = directory.join(format!("result-{index}.tmp"));
        std::fs::write(&temporary, serde_json::to_vec(&value)?)?;
        std::fs::rename(temporary, directory.join(format!("result-{index}.json")))?;
    }
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("native computer probe requires Windows");
}
