// The desktop shell must not allocate a console when launched from Explorer.
// Keep development consoles; the reusable Host remains a CLI binary and is
// launched headlessly by tauri-plugin-shell (CREATE_NO_WINDOW, piped output).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    xharness_desktop::run();
}
