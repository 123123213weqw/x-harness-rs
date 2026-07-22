import css from './ContextMeter.css'
export default {
			"bar": "S4my2G_bar",
			"colorMessages": "S4my2G_colorMessages",
			"colorSystem": "S4my2G_colorSystem",
			"colorTools": "S4my2G_colorTools",
			"figures": "S4my2G_figures",
			"fill": "S4my2G_fill",
			"header": "S4my2G_header",
			"headline": "S4my2G_headline",
			"panel": "S4my2G_panel",
			"percent": "S4my2G_percent",
			"root": "S4my2G_root",
			"row": "S4my2G_row",
			"rows": "S4my2G_rows",
			"segment": "S4my2G_segment",
			"swatch": "S4my2G_swatch",
			"track": "S4my2G_track",
			"trigger": "S4my2G_trigger"
		}
const tagId = '@xharness/dsh-client-ui-conversation/ContextMeter.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
