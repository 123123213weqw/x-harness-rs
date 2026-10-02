import cssText from './views.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("@xharness/dsh-client-ui-trajectory/views.module.css", '@xharness/dsh-client-ui-trajectory', cssText)
const classes = {
			"ledger": "mCzLya_ledger",
			"root": "mCzLya_root"
		} as const
const styles: {[Key in keyof typeof classes]: string} = classes
export default styles
