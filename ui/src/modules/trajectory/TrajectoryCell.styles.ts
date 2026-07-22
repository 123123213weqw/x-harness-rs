import cssText from './TrajectoryCell.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("xharness-trajectory-TrajectoryCell", '@xharness/dsh-client-ui-trajectory', cssText)
const classes = {
  "root": "xharness-trajectory-TrajectoryCell-root",
  "selected": "xharness-trajectory-TrajectoryCell-selected",
  "index": "xharness-trajectory-TrajectoryCell-index",
  "tagSlot": "xharness-trajectory-TrajectoryCell-tagSlot",
  "tag": "xharness-trajectory-TrajectoryCell-tag",
  "tagSystem": "xharness-trajectory-TrajectoryCell-tagSystem",
  "tagUser": "xharness-trajectory-TrajectoryCell-tagUser",
  "tagContext": "xharness-trajectory-TrajectoryCell-tagContext",
  "tagMessage": "xharness-trajectory-TrajectoryCell-tagMessage",
  "tagTool": "xharness-trajectory-TrajectoryCell-tagTool",
  "tagSubtool": "xharness-trajectory-TrajectoryCell-tagSubtool",
  "text": "xharness-trajectory-TrajectoryCell-text",
  "trailing": "xharness-trajectory-TrajectoryCell-trailing",
  "metric": "xharness-trajectory-TrajectoryCell-metric",
  "time": "xharness-trajectory-TrajectoryCell-time"
} as const
const styles: {[Key in keyof typeof classes]: string} = classes
export default styles
