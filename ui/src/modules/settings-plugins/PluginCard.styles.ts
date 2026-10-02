import cssSource from './PluginCard.css'
import { installStyles } from '../views-types'
installStyles("@xharness/dsh-client-ui-settings-plugins/PluginCard.module.css", "@xharness/dsh-client-ui-settings-plugins", cssSource)
const styles = {
  "body": "QOwM_q_body",
  "card": "QOwM_q_card",
  "cardOpen": "QOwM_q_cardOpen",
  "chevron": "QOwM_q_chevron",
  "chevronOpen": "QOwM_q_chevronOpen",
  "description": "QOwM_q_description",
  "discard": "QOwM_q_discard",
  "failed": "QOwM_q_failed",
  "footer": "QOwM_q_footer",
  "headText": "QOwM_q_headText",
  "header": "QOwM_q_header",
  "name": "QOwM_q_name",
  "pending": "QOwM_q_pending",
  "readOnly": "QOwM_q_readOnly",
  "save": "QOwM_q_save"
} as const
export default styles
