import css from './QueueDock.css'
export default {
			"action": "Q8gw3G_action",
			"actions": "Q8gw3G_actions",
			"chevron": "Q8gw3G_chevron",
			"count": "Q8gw3G_count",
			"dock": "Q8gw3G_dock",
			"editor": "Q8gw3G_editor",
			"header": "Q8gw3G_header",
			"lead": "Q8gw3G_lead",
			"list": "Q8gw3G_list",
			"panel": "Q8gw3G_panel",
			"preview": "Q8gw3G_preview",
			"row": "Q8gw3G_row"
		}
const tagId = '@xharness/dsh-client-ui-conversation/QueueDock.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
