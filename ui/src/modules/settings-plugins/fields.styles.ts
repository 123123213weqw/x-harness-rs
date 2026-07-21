import cssSource from './fields.css'
import { installStyles } from '../views-types'
installStyles("@xharness/dsh-client-ui-settings-plugins/fields.module.css", "@xharness/dsh-client-ui-settings-plugins", cssSource)
const styles = {
  "badge": "vaLO0G_badge",
  "badgeMuted": "vaLO0G_badgeMuted",
  "badges": "vaLO0G_badges",
  "field": "vaLO0G_field",
  "head": "vaLO0G_head",
  "hint": "vaLO0G_hint",
  "input": "vaLO0G_input",
  "inputInvalid": "vaLO0G_inputInvalid",
  "invalid": "vaLO0G_invalid",
  "label": "vaLO0G_label",
  "reset": "vaLO0G_reset"
} as const
export default styles
