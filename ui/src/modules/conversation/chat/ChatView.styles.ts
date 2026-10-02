import css from './ChatView.css'
export default {
			"callRow": "IxU-fW_callRow",
			"column": "IxU-fW_column",
			"dsh-turn-status-shimmer": "IxU-fW_dsh-turn-status-shimmer",
			"flowItem": "IxU-fW_flowItem",
			"hint": "IxU-fW_hint",
			"modalAction": "IxU-fW_modalAction",
			"older": "IxU-fW_older",
			"openError": "IxU-fW_openError",
			"root": "IxU-fW_root",
			"scroll": "IxU-fW_scroll",
			"toBottom": "IxU-fW_toBottom",
			"toBottomSlot": "IxU-fW_toBottomSlot",
			"turnStatus": "IxU-fW_turnStatus",
			"turnStatusClock": "IxU-fW_turnStatusClock"
		}
const tagId = '@xharness/dsh-client-ui-conversation/ChatView.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
