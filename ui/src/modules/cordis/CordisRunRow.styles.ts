import cssSource from './CordisRunRow.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("@xharness/dsh-client-ui-cordis/CordisRunRow.module.css", '@xharness/dsh-client-ui-cordis', cssSource)
const styles = {
			"business": "KkBbda_business",
			"card": "KkBbda_card",
			"error": "KkBbda_error",
			"icon": "KkBbda_icon",
			"inspect": "KkBbda_inspect",
			"message": "KkBbda_message",
			"output": "KkBbda_output",
			"row": "KkBbda_row",
			"separator": "KkBbda_separator",
			"status": "KkBbda_status",
			"summary": "KkBbda_summary",
			"title": "KkBbda_title"
		} as const
export default styles
