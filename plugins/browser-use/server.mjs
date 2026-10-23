// Build once with `npm ci && npm run build` in this plugin directory.
// The launcher exposes no arbitrary JS/eval or access to a user's browser profile.
try {
  const { serve } = await import("./dist/protocol.js");
  await serve();
} catch (error) {
  process.stderr.write(`Browser Use startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
