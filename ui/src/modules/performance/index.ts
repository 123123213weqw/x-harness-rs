import type {} from '../conversation/index'
import type { ClientContext } from '../conversation/types/runtime'
import { PerformanceView } from './PerformanceView'
import { en, zh, NS } from './locales'
import { CSS } from './styles'
export const inject = ['slots','locale']
export function apply(ctx: Pick<ClientContext,'slots'|'locale'|'effect'>): void {
  ctx.effect(()=>ctx.locale.register(NS,{en,zh}),'performance: dictionaries')
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='@xlang/xharness-client-ui-performance';style.textContent=CSS;document.head.append(style);return()=>style.remove()},'performance: styles')
  const t=ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'performance',order:31,label:()=>t('title'),inject:()=>({t})},PerformanceView))
}
