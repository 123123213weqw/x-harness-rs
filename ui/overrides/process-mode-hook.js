// Shared presentation preference used by both the Tool and Conversation
// bundles.  The settings plugin emits this event after persistence; no Host
// event or session log is modified by a display-only choice.
function xhUseProcessMode() {
  const read = () => typeof document === 'undefined' ? 'standard' : document.documentElement.dataset.xhProcessMode || 'standard'
  const [mode, setMode] = react.useState(read)
  react.useEffect(() => {
    const update = () => setMode(read())
    window.addEventListener('xh-process-mode', update)
    update()
    return () => window.removeEventListener('xh-process-mode', update)
  }, [])
  return mode
}
