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
    if args.get(1).is_some_and(|v| v == "--freshness-acceptance") {
        return xharness_computer_windows::run_freshness_acceptance().await;
    }
    #[cfg(feature = "native-acceptance")]
    if args
        .get(1)
        .is_some_and(|v| v == "--target-guard-acceptance")
    {
        return xharness_computer_windows::run_target_guard_acceptance().await;
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
    use std::sync::Arc;
    use std::{
        path::PathBuf,
        time::{Duration, Instant},
    };
    use xharness_computer::ComputerTool;
    use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};
    if std::env::var("XHARNESS_DISPOSABLE_COMPUTER_VM").as_deref()
        != Ok("66b64058-bdcc-43e9-85ee-55a79fe2e875")
    {
        return Err("browser acceptance requires the disposable VM guard".into());
    }
    let directory = PathBuf::from(directory);
    std::fs::create_dir_all(&directory)?;
    let driver = Arc::new(xharness_computer_windows::WindowsComputer::new()?);
    let registry = Arc::new(ToolRegistry::new());
    // Lab-only media transport. This is not installed Host attachment/history
    // acceptance; it preserves binary PNGs through the registered tool.
    let sink = Arc::new(LabMedia {
        directory: directory.clone(),
        sequence: std::sync::atomic::AtomicU64::new(0),
    });
    registry
        .register(ComputerTool::new(driver).with_media_sink(sink).spec())
        .await?;
    let executor = ToolExecutor::new(registry);
    std::fs::write(
        directory.join("tool-definition.json"),
        serde_json::to_vec(&xharness_computer::definition())?,
    )?;
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
        let request = ToolRequest::new(
            "computer",
            std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))?,
        )
        .with_execution_id(format!("shopping-native-{index}"))?;
        let result = executor.execute(request).await;
        let content = result
            .output
            .as_ref()
            .map(|o| o.content.as_str())
            .unwrap_or("");
        let payload =
            serde_json::from_str::<serde_json::Value>(content).unwrap_or(serde_json::Value::Null);
        let value = serde_json::json!({"id":index,"ok":result.is_ok(),"elapsed_ms":started.elapsed().as_millis(),"result":payload,"failure":result.failure,"media":result.output.as_ref().and_then(|output|output.metadata.as_ref()).and_then(|metadata|metadata.get("labScreenshot"))});
        let temporary = directory.join(format!("result-{index}.tmp"));
        std::fs::write(&temporary, serde_json::to_vec(&value)?)?;
        std::fs::rename(temporary, directory.join(format!("result-{index}.json")))?;
    }
    Ok(())
}

/// PNG projection is acceptance-only and writes into the authorized run root.
/// No provider credential, model output or operating-system input is handled.
#[cfg(all(windows, feature = "native-acceptance"))]
struct LabMedia {
    directory: std::path::PathBuf,
    sequence: std::sync::atomic::AtomicU64,
}
#[cfg(all(windows, feature = "native-acceptance"))]
#[async_trait::async_trait]
impl xharness_computer::ComputerMediaSink for LabMedia {
    async fn supports_images(&self) -> bool {
        true // Controller must independently verify its selected model can see images.
    }
    async fn project_png(
        &self,
        summary: String,
        screenshot: xharness_computer::Screenshot,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<xharness_tools::ToolOutput, xharness_tools::ToolHandlerError> {
        if cancellation.is_cancelled() {
            return Err(xharness_tools::ToolHandlerError::new(
                "lab capture cancelled",
            ));
        }
        if screenshot.png.len() > 8 * 1024 * 1024 {
            return Err(xharness_tools::ToolHandlerError::new(
                "lab image exceeds binary budget",
            ));
        }
        let image = image::load_from_memory_with_format(&screenshot.png, image::ImageFormat::Png)
            .map_err(|_| xharness_tools::ToolHandlerError::new("lab PNG invalid"))?;
        let id = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if id >= 80 {
            return Err(xharness_tools::ToolHandlerError::new(
                "lab image count exceeded",
            ));
        }
        let name = format!("screenshot-{id}.png");
        std::fs::write(self.directory.join(&name), &screenshot.png)
            .map_err(|_| xharness_tools::ToolHandlerError::new("lab PNG persistence failed"))?;
        Ok(xharness_tools::ToolOutput {
            content: summary,
            metadata: Some(
                serde_json::json!({"labScreenshot":{"file":name,"width":image.width(),"height":image.height(),"png_bytes":screenshot.png.len()}}),
            ),
            command_failure: None,
        })
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("native computer probe requires Windows");
}
