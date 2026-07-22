import css from './ContextInjectionRow.css'
export default {
			"body": "y2WvVq_body",
			"chevron": "y2WvVq_chevron",
			"root": "y2WvVq_root",
			"sep": "y2WvVq_sep",
			"source": "y2WvVq_source",
			"summary": "y2WvVq_summary"
		}
const tagId = '@xharness/dsh-client-ui-conversation/ContextInjectionRow.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
