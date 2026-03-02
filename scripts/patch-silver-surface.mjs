import {readFileSync} from 'node:fs'
export function patchSilverSurface(source) {
 const start=source.indexOf('\t\tfunction HeroGlow({ className }) {')
 if(start<0)throw Error('HeroGlow signature missing')
 const end=source.indexOf('\n\t\t/**',start)
 if(end<0)throw Error('HeroGlow boundary missing')
 const replacement=readFileSync(new URL('../ui/overrides/hero-glow.js',import.meta.url),'utf8').trimEnd()
 source=source.slice(0,start)+replacement+source.slice(end)
 const anchor='className: clsx(InputBar_module_css_default.card, workspaceTrigger && InputBar_module_css_default.cardWorkspaceTrigger),'
 if(!source.includes('"data-xh-silver-input":')) {
  if(source.split(anchor).length!==2)throw Error('Input card signature changed')
  source=source.replace(anchor,anchor+'\n\t\t\t\t\t\t"data-xh-silver-input": workspaceTrigger ? void 0 : "",')
 }
 return source
}
