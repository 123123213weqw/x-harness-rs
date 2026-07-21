import css from './ApprovalPanel.css'
export default {
			"actionRow": "rQ88rq_actionRow",
			"body": "rQ88rq_body",
			"card": "rQ88rq_card",
			"command": "rQ88rq_command",
			"dot": "rQ88rq_dot",
			"headline": "rQ88rq_headline",
			"reject": "rQ88rq_reject",
			"root": "rQ88rq_root",
			"strip": "rQ88rq_strip"
		}
const tagId = '@xharness/dsh-client-ui-conversation/ApprovalPanel.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
