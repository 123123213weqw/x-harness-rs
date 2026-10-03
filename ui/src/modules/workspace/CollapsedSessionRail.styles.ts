import cssSource from './CollapsedSessionRail.css'
import { installStyles } from '../shared/foundation-styles'

installStyles('@xharness/dsh-client-ui-workspace/CollapsedSessionRail.css', '@xharness/dsh-client-ui-workspace', cssSource)

const styles = {
  root: 'xh-session-rail',
  item: 'xh-session-rail-item',
  mark: 'xh-session-rail-mark',
  current: 'xh-session-rail-current',
} as const

export default styles
