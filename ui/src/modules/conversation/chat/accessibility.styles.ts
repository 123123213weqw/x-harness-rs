import css from './accessibility.css'
export default { "visuallyHidden": "kbJlva_visuallyHidden" }
const tagId = '@xharness/dsh-client-ui-conversation/accessibility.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
