import css from './GenericCommandCard.css'
export default {
			"body": "_0kRAKq_body",
			"chevron": "_0kRAKq_chevron",
			"dsh-command-row-sweep": "_0kRAKq_dsh-command-row-sweep",
			"leading": "_0kRAKq_leading",
			"root": "_0kRAKq_root",
			"row": "_0kRAKq_row",
			"separator": "_0kRAKq_separator",
			"summary": "_0kRAKq_summary",
			"title": "_0kRAKq_title"
		}
const tagId = '@xharness/dsh-client-ui-conversation/GenericCommandCard.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
