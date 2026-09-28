// Product-owned plugin hub. The Host does not expose user-plugin inventory or
// catalog APIs yet, so this view must not invent installed or featured items.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-plugin-hub',
  factory: require => {
    const exports = {}
    const { createElement: h, useState } = require('react')
    const NS = 'xharness.pluginHub'
    const zh = {
      title: '插件', search: '搜索插件', installed: '已安装',
      public: '公开', personal: '个人',
      noInstalled: '还没有安装用户插件', noMatch: '没有匹配的插件',
      noCatalog: '插件目录尚未接入', noPersonal: '还没有个人插件',
    }
    const en = {
      title: 'Plugins', search: 'Search plugins', installed: 'Installed',
      public: 'Public', personal: 'Personal',
      noInstalled: 'No user plugins installed', noMatch: 'No matching plugins',
      noCatalog: 'Plugin catalog is not connected yet', noPersonal: 'No personal plugins yet',
    }
    const CSS = `
.xhph{max-width:1260px;margin:0 auto;color:var(--dsw-alias-label-primary);font:inherit}
.xhph-head{margin-bottom:24px}.xhph h1{font-size:30px;letter-spacing:-.045em;line-height:1.15;margin:0;font-weight:650}
.xhph-search{display:block;box-sizing:border-box;width:100%;height:48px;padding:0 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;outline:none}
.xhph-search::placeholder{color:var(--dsw-alias-label-tertiary)}.xhph-search:focus{border-color:var(--dsw-alias-label-secondary)}
.xhph-installed{margin-top:38px}.xhph-section-title{font-size:19px;font-weight:620;letter-spacing:-.02em;margin:0;padding:0 0 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.xhph-installed-empty{display:flex;align-items:center;gap:15px;min-height:82px;color:var(--dsw-alias-label-secondary);font-size:13px}
.xhph-symbol{display:flex;align-items:center;justify-content:center;flex:none;width:46px;height:46px;border-radius:11px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.xhph-tabs{display:flex;gap:7px;margin:28px 0 37px;transform:translateX(-15px)}.xhph-tab{border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;font-weight:580;padding:8px 15px;cursor:pointer}
.xhph-tab:hover{color:var(--dsw-alias-label-primary)}.xhph-tab[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.xhph-catalog-empty{display:flex;align-items:center;min-height:100px;color:var(--dsw-alias-label-secondary);font-size:13px}
@media(max-width:600px){.xhph h1{font-size:25px}.xhph-installed{margin-top:30px}.xhph-section-title{font-size:17px}.xhph-tabs{margin:24px 0 30px}}
`
    function PluginIcon() {
      return h('span', { className: 'xhph-symbol', 'aria-hidden': true },
        h('svg', { width: 30, height: 30, viewBox: '0 0 16 16', fill: 'none' },
          h('path', {
            d: 'M2.4 2.5h3.05c-.15.64.26 1.18.9 1.18s1.05-.54.9-1.18h3.65v3.05c.64-.15 1.18.26 1.18.9s-.54 1.05-1.18.9v3.65H7.85c.15.64-.26 1.18-.9 1.18s-1.05-.54-.9-1.18H2.4V7.85c-.64.15-1.18-.26-1.18-.9s.54-1.05 1.18-.9V2.5Z',
            transform: 'translate(0 -0.75) scale(1.2)',
            stroke: 'currentColor', strokeWidth: 0.9, strokeLinecap: 'round', strokeLinejoin: 'round',
          })))
    }
    function PluginHub({ t }) {
      const [tab, setTab] = useState('public')
      const [query, setQuery] = useState('')
      const options = ['public', 'personal']
      return h('section', { className: 'xhph', 'data-xharness-plugin-hub': true },
        h('header', { className: 'xhph-head' }, h('h1', null, t('title'))),
        h('input', { className: 'xhph-search', type: 'search', value: query,
          onChange: event => setQuery(event.target.value), placeholder: t('search'), 'aria-label': t('search') }),
        h('section', { className: 'xhph-installed', 'aria-labelledby': 'xhph-installed-title' },
          h('h2', { id: 'xhph-installed-title', className: 'xhph-section-title' }, t('installed')),
          h('div', { className: 'xhph-installed-empty' }, h(PluginIcon),
            h('span', null, t(query ? 'noMatch' : 'noInstalled')))),
        h('div', { role: 'tablist', 'aria-label': t('title'), className: 'xhph-tabs' }, options.map((key, index) => h('button', {
          key, type: 'button', role: 'tab', id: `xhph-tab-${key}`, 'aria-selected': tab === key,
          'aria-controls': `xhph-panel-${key}`, tabIndex: tab === key ? 0 : -1, className: 'xhph-tab',
          onClick: () => setTab(key),
          onKeyDown: event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % options.length : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
            if (next >= 0) { event.preventDefault(); setTab(options[next]); document.getElementById(`xhph-tab-${options[next]}`)?.focus() }
          },
        }, t(key)))),
        h('section', { id: `xhph-panel-${tab}`, role: 'tabpanel', 'aria-labelledby': `xhph-tab-${tab}` },
          h('h2', { className: 'xhph-section-title' }, t(tab)),
          h('div', { className: 'xhph-catalog-empty' }, t(tab === 'public' ? 'noCatalog' : 'noPersonal'))))
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-plugin-hub: locale')
      ctx.effect(() => {
        if (document.getElementById('xharness-plugin-hub-style')) return () => {}
        const style = document.createElement('style')
        style.id = 'xharness-plugin-hub-style'
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      }, 'xharness-plugin-hub: styles')
      ctx.slots.inject('plugins.center', () => ctx.slots.register({
        name: 'plugins.center', id: 'plugin-hub', order: 0, locale: NS,
      }, PluginHub))
    }
    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return exports
  },
})
