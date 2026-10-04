import cssSource from './MessageRail.css'
import { installStyles } from '../../shared/foundation-styles'

installStyles('@xharness/dsh-client-ui-conversation/MessageRail.css', '@xharness/dsh-client-ui-conversation', cssSource)

const styles = {
  root: 'xh-message-rail',
  item: 'xh-message-rail-item',
  mark: 'xh-message-rail-mark',
} as const

export default styles
