import cssSource from './AgentPresetRow.css'
import { installStyles } from '../shared/foundation-styles'
installStyles("@xharness/dsh-client-ui-agent-preset/AgentPresetRow.module.css", "@xharness/dsh-client-ui-agent-preset", cssSource)
const styles = {
			"chevron": "PfKHXa_chevron",
			"desc": "PfKHXa_desc",
			"row": "PfKHXa_row",
			"rowText": "PfKHXa_rowText",
			"selector": "PfKHXa_selector",
			"title": "PfKHXa_title"
		} as const
export default styles
