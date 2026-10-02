import cssSource from './PermissionRow.css'
import { installStyles } from '../shared/foundation-styles'
installStyles("@xharness/dsh-client-ui-permission-presets/PermissionRow.module.css", "@xharness/dsh-client-ui-permission-presets", cssSource)
const styles = {
			"chevron": "iYmhEW_chevron",
			"desc": "iYmhEW_desc",
			"row": "iYmhEW_row",
			"rowText": "iYmhEW_rowText",
			"selector": "iYmhEW_selector",
			"title": "iYmhEW_title"
		} as const
export default styles
