import cssText from './TrajectoryTimeline.css'
import {installStyles} from '../shared/foundation-styles'
installStyles("@xharness/dsh-client-ui-trajectory/TrajectoryTimeline.module.css", '@xharness/dsh-client-ui-trajectory', cssText)
const classes = {
			"earlierHistory": "YDLR1G_earlierHistory",
			"empty": "YDLR1G_empty",
			"hoverLine": "YDLR1G_hoverLine",
			"labels": "YDLR1G_labels",
			"lanes": "YDLR1G_lanes",
			"plot": "YDLR1G_plot",
			"root": "YDLR1G_root",
			"selection": "YDLR1G_selection",
			"selectionEdges": "YDLR1G_selectionEdges",
			"span": "YDLR1G_span",
			"track": "YDLR1G_track",
			"turnBoundaries": "YDLR1G_turnBoundaries",
			"turnBoundary": "YDLR1G_turnBoundary"
		} as const
const styles: {[Key in keyof typeof classes]: string} = classes
export default styles
