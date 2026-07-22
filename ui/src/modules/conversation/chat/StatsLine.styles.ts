import css from './StatsLine.css'
export default {
			"root": "PvwIvW_root",
			"sep": "PvwIvW_sep"
		}
const tagId = '@xharness/dsh-client-ui-conversation/StatsLine.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
