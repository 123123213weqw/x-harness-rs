// launchDate is legitimately nil for apps started without LaunchServices.
// Query only the foreground PID here; Rust binds it to a kernel start time.
ObjC.import('AppKit');
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({pid:Number(app.processIdentifier)});
}
