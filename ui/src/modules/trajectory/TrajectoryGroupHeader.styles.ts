import cssText from './TrajectoryGroupHeader.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("xharness-trajectory-TrajectoryGroupHeader", '@xharness/dsh-client-ui-trajectory', cssText)
const classes = {
  "root": "xharness-trajectory-TrajectoryGroupHeader-root",
  "title": "xharness-trajectory-TrajectoryGroupHeader-title",
  "description": "xharness-trajectory-TrajectoryGroupHeader-description"
} as const
const styles: {[Key in keyof typeof classes]: string} = classes
export default styles
