import cssSource from './AccountEntry.css'
import { installStyles } from '../views-types'
installStyles('@xharness/dsh-client-ui-settings-general/AccountEntry.module.css', '@xharness/dsh-client-ui-settings-general', cssSource)
const styles = {
  root: 'xhAccount_root', menuAnchor: 'xhAccount_anchor', trigger: 'xhAccount_trigger',
  rail: 'xhAccount_rail', avatar: 'xhAccount_avatar', identity: 'xhAccount_identity',
  name: 'xhAccount_name', caption: 'xhAccount_caption', chevron: 'xhAccount_chevron',
  menuLabel: 'xhAccount_menuLabel',
} as const
export default styles
