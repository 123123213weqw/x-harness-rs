import css from './PermissionSelect.css'
export default {
			"chevron": "Qgao_G_chevron",
			"chevronOpen": "Qgao_G_chevronOpen",
			"trigger": "Qgao_G_trigger",
			"triggerIcon": "Qgao_G_triggerIcon",
			"triggerLabel": "Qgao_G_triggerLabel"
		}
const tagId = '@xharness/dsh-client-ui-conversation/PermissionSelect.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
