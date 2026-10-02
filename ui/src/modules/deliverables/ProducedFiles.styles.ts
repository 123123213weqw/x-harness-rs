import cssSource from './ProducedFiles.css'
import { installStyles } from '../views-types'
installStyles("@xharness/dsh-client-ui-deliverables/ProducedFiles.module.css", "@xharness/dsh-client-ui-deliverables", cssSource)
const styles = {
  "file": "iftpVG_file",
  "label": "iftpVG_label",
  "measure": "iftpVG_measure",
  "more": "iftpVG_more",
  "probe": "iftpVG_probe",
  "root": "iftpVG_root",
  "row": "iftpVG_row",
  "showFolder": "iftpVG_showFolder"
} as const
export default styles
