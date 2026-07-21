import cssSource from './GoalBar.css'
import { installStyles } from '../views-types'
installStyles("@xharness/dsh-client-ui-goal/GoalBar.module.css", "@xharness/dsh-client-ui-goal", cssSource)
const styles = {
  "actions": "bgzwgq_actions",
  "bar": "bgzwgq_bar",
  "dock": "bgzwgq_dock",
  "error": "bgzwgq_error",
  "goalGlyph": "bgzwgq_goalGlyph",
  "iconBtn": "bgzwgq_iconBtn",
  "label": "bgzwgq_label",
  "objective": "bgzwgq_objective",
  "objectiveInput": "bgzwgq_objectiveInput"
} as const
export default styles
