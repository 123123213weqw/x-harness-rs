import cssText from './TrajectoryToolbar.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("@xharness/dsh-client-ui-trajectory/TrajectoryToolbar.module.css", '@xharness/dsh-client-ui-trajectory', cssText)
const classes = {
			"action": "D65Vfa_action",
			"actionIcon": "D65Vfa_actionIcon",
			"actions": "D65Vfa_actions",
			"control": "D65Vfa_control",
			"controlThumb": "D65Vfa_controlThumb",
			"controlTrack": "D65Vfa_controlTrack",
			"inner": "D65Vfa_inner",
			"root": "D65Vfa_root",
			"search": "D65Vfa_search",
			"searchIcon": "D65Vfa_searchIcon",
			"searchInput": "D65Vfa_searchInput",
			"toggle": "D65Vfa_toggle",
			"toggleIcon": "D65Vfa_toggleIcon"
		} as const
const styles: {[Key in keyof typeof classes]: string} = classes
export default styles
