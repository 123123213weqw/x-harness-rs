import type { ThemeContext as Context } from './contracts'
import base from './base.css'
import designPlatform from './design-platform.css'
import scrollbar from './scrollbar.css'
import gradientShadowText from './gradient-shadow-text.css'
import shiki from './shiki.css'
import typography from './typography.css'

const PLUGIN_ID = '@xharness/dsh-client-ui-theme'

const STYLES = [
  ['base.css', base],
  ['design-platform.css', designPlatform],
  ['scrollbar.css', scrollbar],
  ['gradient-shadow-text.css', gradientShadowText],
  ['typography.css', typography],
  ['shiki.css', shiki],
] as const

/**
 * Mount the global theme sheets for exactly the owning plugin lifetime.
 * @param ctx - Owning plugin context.
 */
export function installThemeStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  for (const [name, css] of STYLES) {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }, `ui-theme: ${name} stylesheet`)
  }
}
