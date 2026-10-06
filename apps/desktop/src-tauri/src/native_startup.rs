//! Native runtime prerequisites, before Tauri/GTK creates any display.

pub fn prepare() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // Pure Wayland does not need Xlib. On X11, Tao starts a device-event
        // thread and WebKit can create compositor threads. Xlib's global
        // locking must be initialized before the first display is opened.
        if std::env::var_os("DISPLAY").is_some() {
            let xlib = x11_dl::xlib::Xlib::open()
                .map_err(|_| "X11 threading initialization library unavailable")?;
            // SAFETY: called by our executable entry points before Tauri/GTK
            // initialization. No display pointers or handles cross threads.
            if unsafe { (xlib.XInitThreads)() } == 0 {
                return Err("X11 threading initialization failed".into());
            }
        }
    }
    Ok(())
}
