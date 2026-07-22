import cssSource from './AgentPresetSeat.css'
import { installStyles } from '../shared/foundation-styles'
installStyles("@xharness/dsh-client-ui-agent-preset/AgentPresetSeat.module.css", "@xharness/dsh-client-ui-agent-preset", cssSource)
const styles = {
			"chevron": "l5wGwa_chevron",
			"introChar": "l5wGwa_introChar",
			"introIcon": "l5wGwa_introIcon",
			"introText": "l5wGwa_introText",
			"item": "l5wGwa_item",
			"itemDesc": "l5wGwa_itemDesc",
			"itemName": "l5wGwa_itemName",
			"seat": "l5wGwa_seat",
			"seat-char-in": "l5wGwa_seat-char-in",
			"seat-icon-in": "l5wGwa_seat-icon-in",
			"seatIcon": "l5wGwa_seatIcon"
		} as const
export default styles
