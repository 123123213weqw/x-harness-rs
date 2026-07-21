import cssText from './TrajectoryTurnHeader.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("xharness-trajectory-TrajectoryTurnHeader", '@xharness/dsh-client-ui-trajectory', cssText)
const classes = {
  "root": "xharness-trajectory-TrajectoryTurnHeader-root",
  "inner": "xharness-trajectory-TrajectoryTurnHeader-inner",
  "title": "xharness-trajectory-TrajectoryTurnHeader-title",
  "columns": "xharness-trajectory-TrajectoryTurnHeader-columns",
  "column": "xharness-trajectory-TrajectoryTurnHeader-column"
} as const
const styles: {[Key in keyof typeof classes]: string} = classes
export default styles
