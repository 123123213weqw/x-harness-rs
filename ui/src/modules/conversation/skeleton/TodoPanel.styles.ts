import css from './TodoPanel.css'
export default {
			"body": "Xe4JHW_body",
			"chevron": "Xe4JHW_chevron",
			"content": "Xe4JHW_content",
			"glyph": "Xe4JHW_glyph",
			"glyphCompleted": "Xe4JHW_glyphCompleted",
			"glyphPending": "Xe4JHW_glyphPending",
			"glyphProgress": "Xe4JHW_glyphProgress",
			"header": "Xe4JHW_header",
			"item": "Xe4JHW_item",
			"lead": "Xe4JHW_lead",
			"list": "Xe4JHW_list",
			"progress": "Xe4JHW_progress",
			"root": "Xe4JHW_root",
			"title": "Xe4JHW_title",
			"todo-progress-spin": "Xe4JHW_todo-progress-spin"
		}
const tagId = '@xharness/dsh-client-ui-conversation/TodoPanel.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
