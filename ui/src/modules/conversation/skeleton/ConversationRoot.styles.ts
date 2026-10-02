import css from './ConversationRoot.css'
export default {
			"composerHero": "lvQYKa_composerHero",
			"composerSeat": "lvQYKa_composerSeat",
			"composerStack": "lvQYKa_composerStack",
			"crumb": "lvQYKa_crumb",
			"crumbCurrent": "lvQYKa_crumbCurrent",
			"crumbSeg": "lvQYKa_crumbSeg",
			"crumbSep": "lvQYKa_crumbSep",
			"crumbs": "lvQYKa_crumbs",
			"header": "lvQYKa_header",
			"headerActions": "lvQYKa_headerActions",
			"headerHidden": "lvQYKa_headerHidden",
			"headerUtilities": "lvQYKa_headerUtilities",
			"heroGlow": "lvQYKa_heroGlow",
			"heroWorkspaceRow": "lvQYKa_heroWorkspaceRow",
			"root": "lvQYKa_root",
			"scrollBody": "lvQYKa_scrollBody",
			"tab": "lvQYKa_tab",
			"tabActive": "lvQYKa_tabActive",
			"tabs": "lvQYKa_tabs",
			"titleCluster": "lvQYKa_titleCluster",
			"titleRow": "lvQYKa_titleRow",
			"viewArea": "lvQYKa_viewArea"
		}
const tagId = '@xharness/dsh-client-ui-conversation/ConversationRoot.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
