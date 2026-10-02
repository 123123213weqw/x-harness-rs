import css from './DetailsPanel.css'
export default {
			"body": "JXxdLa_body",
			"close": "JXxdLa_close",
			"code": "JXxdLa_code",
			"empty": "JXxdLa_empty",
			"header": "JXxdLa_header",
			"root": "JXxdLa_root",
			"section": "JXxdLa_section",
			"sectionLabel": "JXxdLa_sectionLabel",
			"title": "JXxdLa_title"
		}
const tagId = '@xharness/dsh-client-ui-conversation/DetailsPanel.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
