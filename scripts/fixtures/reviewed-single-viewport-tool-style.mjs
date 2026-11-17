// Reviewed single-scroll-viewport deltas for the tool sheets: the frozen UI
// reference is never rewritten; these exact forward patches reproduce the
// in-place token removals (bounded-height inner scrollers are gone — the
// conversation transcript is the only scrollport).
const reviewedToolDeltas = {
  '@xharness/dsh-client-ui-tool/ToolRow.module.css': [
    ['.Dh215a_bodyScroll{max-height:260px;overflow-y:auto}', '.Dh215a_bodyScroll{}'],
    ['column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}', 'column-gap:14px;padding:12px 16px;display:grid}'],
  ],
  '@xharness/dsh-client-ui-tool/bash-sample.module.css': [
    ['column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}', 'column-gap:14px;padding:12px 16px;display:grid}'],
  ],
}

const reviewDiffDelta = [
  ['.xh-review-pane{min-width:0;max-height:400px;overflow:auto;scrollbar-gutter:stable;', '.xh-review-pane{min-width:0;'],
]

export function applyReviewedSingleViewportStyle(stylesheetId, text) {
  let deltas = reviewedToolDeltas[stylesheetId]
  if (deltas === undefined && (stylesheetId === undefined || stylesheetId === '') && text.includes('.xh-review-pane{')) {
    deltas = reviewDiffDelta
  }
  if (deltas === undefined) return text
  let out = text
  for (const [oldToken, newToken] of deltas) {
    const at = out.indexOf(oldToken)
    if (at < 0 || out.indexOf(oldToken, at + 1) >= 0) {
      throw Error('reviewed single-viewport delta anchor must appear exactly once: ' + oldToken.slice(0, 48))
    }
    out = out.slice(0, at) + newToken + out.slice(at + oldToken.length)
  }
  return out
}
