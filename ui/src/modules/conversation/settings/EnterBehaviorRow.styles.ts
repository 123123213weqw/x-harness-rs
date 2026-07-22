import css from './EnterBehaviorRow.css'
export default {
			"chevron": "h_7F-q_chevron",
			"desc": "h_7F-q_desc",
			"row": "h_7F-q_row",
			"rowText": "h_7F-q_rowText",
			"selector": "h_7F-q_selector",
			"title": "h_7F-q_title"
		}
const tagId = '@xharness/dsh-client-ui-conversation/EnterBehaviorRow.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
