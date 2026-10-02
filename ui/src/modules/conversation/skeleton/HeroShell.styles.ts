import css from './HeroShell.css'
export default {
			"body": "_f60Wq_body",
			"chevron": "_f60Wq_chevron",
			"fish": "_f60Wq_fish",
			"fishHitbox": "_f60Wq_fishHitbox",
			"folder": "_f60Wq_folder",
			"headline": "_f60Wq_headline",
			"headlineText": "_f60Wq_headlineText",
			"hero-fish-swim": "_f60Wq_hero-fish-swim",
			"modalAction": "_f60Wq_modalAction",
			"modalError": "_f60Wq_modalError",
			"modalInput": "_f60Wq_modalInput",
			"previewBadge": "_f60Wq_previewBadge",
			"root": "_f60Wq_root",
			"stack": "_f60Wq_stack",
			"workspace": "_f60Wq_workspace",
			"workspaceLabel": "_f60Wq_workspaceLabel",
			"workspaceRow": "_f60Wq_workspaceRow"
		}
const tagId = '@xharness/dsh-client-ui-conversation/HeroShell.module.css'
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement('style'); tag.dataset.plugin = '@xharness/dsh-client-ui-conversation'; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag)
}
