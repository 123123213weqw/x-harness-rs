// Explicit reviewed delta only; the frozen reference is never rewritten.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
export const jobStyleId = '@xharness/jobs/RunPanel.css'
export function stripReviewedJobStyle(styles) {
  const additions = styles.filter(style => style.dataset?.pluginCss === jobStyleId)
  assert.equal(additions.length, 1, 'exactly one shared Job stylesheet')
  assert.equal(additions[0].dataset.plugin, '@xharness/jobs')
  assert.equal(createHash('sha256').update(additions[0].textContent).digest('hex'), '2fd2d35ccb298797062f34e930a0080c3c8319472335a754fed82211ea82da92', 'reviewed Job stylesheet bytes only')
  return styles.filter(style => style.dataset?.pluginCss !== jobStyleId)
}
