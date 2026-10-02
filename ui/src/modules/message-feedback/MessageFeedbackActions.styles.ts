import cssSource from './MessageFeedbackActions.css'
import { installStyles } from '../views-types'
installStyles("@xharness/dsh-client-ui-message-feedback/MessageFeedbackActions.module.css", "@xharness/dsh-client-ui-message-feedback", cssSource)
const styles = {
  "action": "fp-x2q_action",
  "failure": "fp-x2q_failure",
  "noteActions": "fp-x2q_noteActions",
  "noteCancel": "fp-x2q_noteCancel",
  "noteInput": "fp-x2q_noteInput",
  "noteOpen": "fp-x2q_noteOpen",
  "notePanel": "fp-x2q_notePanel",
  "noteSave": "fp-x2q_noteSave"
} as const
export default styles
