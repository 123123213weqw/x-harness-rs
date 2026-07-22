import css from './MessageIconActions.css'
export default {
			"action": "AEC1ra_action",
			"actions": "AEC1ra_actions",
			"runTimeDot": "AEC1ra_runTimeDot",
			"timeEnd": "AEC1ra_timeEnd",
			"timeStart": "AEC1ra_timeStart",
			"visuallyHidden": "AEC1ra_visuallyHidden"
		}
const tagId = '@xharness/dsh-client-ui-conversation/MessageIconActions.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
