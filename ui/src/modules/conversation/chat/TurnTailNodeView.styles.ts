import css from './TurnTailNodeView.css'
export default {
			"actions": "Aov_lG_actions",
			"summary": "Aov_lG_summary",
			"root": "Aov_lG_root"
		}
const tagId = '@xharness/dsh-client-ui-conversation/TurnTailNodeView.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
