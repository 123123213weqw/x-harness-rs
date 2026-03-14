// Product-owned tolerant parser for the Workspace creation timestamp.
//
// The shipped Host sends epoch milliseconds as a plain decimal string
// (`xharness-host/src/state.rs::iso_now` returns `now_ms().to_string()` despite
// its name). Upstream fed that straight into `new Date(...)` / `Date.parse(...)`,
// which is NaN for a bare 13-digit string: the workspace hover card rendered
// "创建于 NaN年NaN月NaN日 NaN:NaN", and `recentWorkspace` silently lost its
// recency fallback because every NaN comparison is false.
//
// Accept both shapes so display and ordering survive a later tightening of the
// wire format to real ISO-8601.
function xhEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  if (text === '') return NaN;
  if (/^-?\d+$/.test(text)) {
    const numeric = Number(text);
    return Number.isSafeInteger(numeric) ? numeric : NaN;
  }
  return Date.parse(text);
}
