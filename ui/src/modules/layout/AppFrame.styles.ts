import cssSource from './AppFrame.css'
import { installStyles } from '../views-types'
installStyles("@xharness/dsh-client-ui-layout/AppFrame.module.css", "@xharness/dsh-client-ui-layout", cssSource)
const styles = {
  "centerCol": "_84hhiq_centerCol",
  "detailsCol": "_84hhiq_detailsCol",
  "frame": "_84hhiq_frame",
  "handle": "_84hhiq_handle",
  "overlayLayer": "_84hhiq_overlayLayer",
  "sidebarCol": "_84hhiq_sidebarCol",
  "workspaceScrim": "_84hhiq_workspaceScrim"
} as const
export default styles
