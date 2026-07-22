import cssText from './TrajectoryTurn.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("xharness-trajectory-TrajectoryTurn", '@xharness/dsh-client-ui-trajectory', cssText)
const classes = {
  "root": "xharness-trajectory-TrajectoryTurn-root",
  "body": "xharness-trajectory-TrajectoryTurn-body"
} as const
const styles: {[Key in keyof typeof classes]: string} = classes
export default styles
