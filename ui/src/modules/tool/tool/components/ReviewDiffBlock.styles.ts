import css from './ReviewDiffBlock.css'
if (typeof document !== 'undefined' && !document.getElementById('xh-review-diff-style')) {
  const style = document.createElement('style')
  style.id = 'xh-review-diff-style'
  style.textContent = css
  document.head.appendChild(style)
}
