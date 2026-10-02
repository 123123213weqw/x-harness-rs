/** Runs at ModuleLoader factory materialization, never during script registration. */
export function installStyles(tagId: string, plugin: string, css: string): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = plugin
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}
