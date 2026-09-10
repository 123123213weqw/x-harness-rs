// Visibility only: no animation frames, timers, or React state updates.
(() => {
  const sync = () => document.documentElement.toggleAttribute('data-xh-page-hidden', document.hidden)
  sync()
  document.addEventListener('visibilitychange', sync)
})()
