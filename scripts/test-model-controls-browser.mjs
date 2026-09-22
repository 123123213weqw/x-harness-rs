// Run the same approved interaction contract against the committed build.
// Source/legacy runs are separate CI cases; this must not compile source instead.
process.env.UI_TEST_IMPL = 'canonical'
await import('./test-model-selection-source-browser.mjs')
