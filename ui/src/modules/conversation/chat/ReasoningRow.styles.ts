import css from './ReasoningRow.css'
export default {
			"chevron": "U8JO7q_chevron",
			"dsh-reasoning-row-sweep": "U8JO7q_dsh-reasoning-row-sweep",
			"leading": "U8JO7q_leading",
			"root": "U8JO7q_root",
			"row": "U8JO7q_row",
			"separator": "U8JO7q_separator",
			"summary": "U8JO7q_summary",
			"thinkBody": "U8JO7q_thinkBody",
			"title": "U8JO7q_title"
		}
const tagId = '@xharness/dsh-client-ui-conversation/ReasoningRow.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
