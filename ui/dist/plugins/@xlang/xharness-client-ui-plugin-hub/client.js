// User-selected plugin catalog. Third-party code is never imported into the
// browser; every mutation goes through the native Host's verified installer.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-plugin-hub',
  factory: require => {
    const exports = {}
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const NS = 'xharness.pluginHub'
    const zh = {
      title: '插件', search: '搜索插件', installed: '已安装', public: '公开', personal: '个人',
      noInstalled: '还没有安装用户插件', noMatch: '没有匹配的插件', noCatalog: '尚未导入插件目录',
      noPersonal: '还没有个人插件', add: '添加目录', install: '安装', enable: '启用', disable: '停用',
      uninstall: '卸载', update: '更新', refresh: '刷新', working: '处理中…', unsupported: '当前支持 Skill 与本地 MCP',
      inspect: '来源和能力', source: '来源', digest: 'SHA-256', capabilities: '声明能力',
      skills: '技能', failed: '操作失败', imported: '目录已导入', confirmInstall: '确认安装此插件？将先校验 SHA-256，安装后默认停用。',
      confirmUninstall: '卸载此插件？', noSkills: '无可运行 Skill', allowMcp: '允许 MCP', stopMcp: '停用 MCP',
      confirmMcp: '允许此插件在本机启动以下 MCP 程序？只有调用时才启动。环境变量仅显示名称，不显示值。',
    }
    const en = {
      title: 'Plugins', search: 'Search plugins', installed: 'Installed', public: 'Public', personal: 'Personal',
      noInstalled: 'No user plugins installed', noMatch: 'No matching plugins', noCatalog: 'No plugin catalog imported',
      noPersonal: 'No personal plugins yet', add: 'Import catalog', install: 'Install', enable: 'Enable', disable: 'Disable',
      uninstall: 'Uninstall', update: 'Update', refresh: 'Refresh', working: 'Working…', unsupported: 'Skills and local MCP are supported',
      inspect: 'Source and capabilities', source: 'Source', digest: 'SHA-256', capabilities: 'Declared capabilities',
      skills: 'Skills', failed: 'Operation failed', imported: 'Catalog imported', confirmInstall: 'Install this plugin? Its SHA-256 will be verified and it will remain disabled by default.',
      confirmUninstall: 'Uninstall this plugin?', noSkills: 'No runnable Skills', allowMcp: 'Allow MCP', stopMcp: 'Disable MCP',
      confirmMcp: 'Allow this plugin to launch these local MCP programs? They start only when called. Environment variable names are shown, not values.',
    }
    const CSS = `
.xhph{max-width:1260px;margin:0 auto;color:var(--dsw-alias-label-primary);font:inherit}
.xhph-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px}.xhph h1{font-size:30px;letter-spacing:-.045em;line-height:1.15;margin:0;font-weight:650}.xhph-actions{display:flex;gap:8px}.xhph-button{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:8px 12px;cursor:pointer}.xhph-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.xhph-button:disabled{opacity:.5;cursor:default}
.xhph-search{display:block;box-sizing:border-box;width:100%;height:48px;padding:0 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;outline:none}.xhph-search::placeholder{color:var(--dsw-alias-label-tertiary)}.xhph-search:focus{border-color:var(--dsw-alias-label-secondary)}
.xhph-installed{margin-top:38px}.xhph-section-title{font-size:19px;font-weight:620;letter-spacing:-.02em;margin:0;padding:0 0 13px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhph-installed-empty{display:flex;align-items:center;gap:15px;min-height:82px;color:var(--dsw-alias-label-secondary);font-size:13px}.xhph-symbol{display:flex;align-items:center;justify-content:center;flex:none;width:46px;height:46px;border-radius:11px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.xhph-tabs{display:flex;gap:7px;margin:28px 0 37px;transform:translateX(-15px)}.xhph-tab{border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;font-weight:580;padding:8px 15px;cursor:pointer}.xhph-tab:hover{color:var(--dsw-alias-label-primary)}.xhph-tab[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.xhph-catalog-empty{display:flex;align-items:center;min-height:100px;color:var(--dsw-alias-label-secondary);font-size:13px}
.xhph-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 28px;padding-top:15px}.xhph-item{display:flex;align-items:center;gap:13px;min-width:0;padding:11px 5px;border-bottom:1px solid var(--dsw-alias-border-l1)}.xhph-icon{width:42px;height:42px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--dsw-alias-interactive-bg-hover);font-weight:650;color:var(--dsw-alias-label-secondary)}.xhph-copy{min-width:0;flex:1}.xhph-name{font-size:14px;font-weight:620}.xhph-desc{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.xhph-item button{flex:none}.xhph-status{min-height:22px;margin:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}.xhph-error{color:#c54545}.xhph-detail{margin:5px 0 18px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow-wrap:anywhere;font-size:12px}.xhph-detail p{margin:7px 0}.xhph-detail code{font-size:11px}
@media(max-width:700px){.xhph-grid{grid-template-columns:1fr}.xhph h1{font-size:25px}.xhph-head{align-items:flex-start}.xhph-installed{margin-top:30px}.xhph-tabs{margin:24px 0 30px}}
`
    function PluginIcon() {
      return h('span', { className: 'xhph-symbol', 'aria-hidden': true },
        h('svg', { width: 30, height: 30, viewBox: '0 0 16 16', fill: 'none' },
          h('path', { d: 'M2.4 2.5h3.05c-.15.64.26 1.18.9 1.18s1.05-.54.9-1.18h3.65v3.05c.64-.15 1.18.26 1.18.9s-.54 1.05-1.18.9v3.65H7.85c.15.64-.26 1.18-.9 1.18s-1.05-.54-.9-1.18H2.4V7.85c-.64.15-1.18-.26-1.18-.9s.54-1.05 1.18-.9V2.5Z', transform: 'translate(0 -0.75) scale(1.2)', stroke: 'currentColor', strokeWidth: .9, strokeLinecap: 'round', strokeLinejoin: 'round' })))
    }
    function PluginHub({ t, call }) {
      const [tab, setTab] = useState('public')
      const [query, setQuery] = useState('')
      const [catalog, setCatalog] = useState([])
      const [installed, setInstalled] = useState([])
      const [updates, setUpdates] = useState([])
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [status, setStatus] = useState('')
      const [detail, setDetail] = useState(null)
      const input = useRef(null)
      async function reload() {
        const [a, b, c] = await Promise.all([call('plugins/catalog'), call('plugins/installed'), call('plugins/updates')])
        setCatalog(a.plugins ?? []); setInstalled(b.plugins ?? []); setUpdates(c.updates ?? [])
      }
      useEffect(() => { let active = true; Promise.all([call('plugins/catalog'), call('plugins/installed'), call('plugins/updates')])
        .then(([a, b, c]) => { if (active) { setCatalog(a.plugins ?? []); setInstalled(b.plugins ?? []); setUpdates(c.updates ?? []) } })
        .catch(e => { if (active) setError(String(e.message ?? e)) })
        return () => { active = false }
      }, [call])
      async function run(key, action) {
        setBusy(key); setError(''); setStatus('')
        try { await action(); await reload() } catch (e) { setError(`${t('failed')}: ${e.message ?? e}`) }
        finally { setBusy('') }
      }
      async function importFile(event) {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        if (file.size > 2 * 1024 * 1024) { setError('Catalog exceeds 2 MiB'); return }
        await run('import', async () => { await call('plugins/importCatalog', { content: await file.text(), scope: tab }); setStatus(t('imported')) })
      }
      async function toggleMcp(item) {
        if (!item.mcpEnabled) {
          const preview = await call('plugins/mcpPreview', { name: item.name })
          const summary = (preview.servers ?? []).map(server => `${server.server}: ${server.command} ${(server.args ?? []).join(' ')}\nENV: ${(server.envKeys ?? []).join(', ')}`).join('\n')
          if (!window.confirm(`${t('confirmMcp')}\n${summary}`)) return
        }
        await call(`plugins/${item.mcpEnabled ? 'mcpDisable' : 'mcpEnable'}`, { name: item.name })
      }
      const options = ['public', 'personal']
      const selectedCatalog = catalog.find(item => item.name === detail)
      const selectedInstalled = installed.find(item => item.name === detail)
      const selected = selectedCatalog || selectedInstalled ? { ...selectedCatalog, ...selectedInstalled, source: selectedCatalog?.source } : null
      const filtered = list => list.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
      function itemCard(item, isInstalled, updateAvailable = false) {
        const mcpOnly = isInstalled && !item.skills?.length && item.capabilities?.includes('mcp')
        const label = updateAvailable ? 'update' : isInstalled ? (mcpOnly ? (item.mcpEnabled ? 'stopMcp' : 'allowMcp') : (item.enabled ? 'disable' : 'enable')) : 'install'
        return h('div', { className: 'xhph-item', key: item.name },
          h('div', { className: 'xhph-icon', 'aria-hidden': true }, item.name.slice(0, 1).toUpperCase()),
          h('div', { className: 'xhph-copy', onClick: () => setDetail(item.name), role: 'button', tabIndex: 0,
            onKeyDown: e => { if (e.key === 'Enter') setDetail(item.name) } },
            h('div', { className: 'xhph-name' }, item.name),
            h('div', { className: 'xhph-desc' }, item.description || item.version)),
          h('button', { className: 'xhph-button', disabled: !!busy, onClick: () => run(item.name, async () => {
            if ((!isInstalled || updateAvailable) && !window.confirm(`${t('confirmInstall')}\n${item.source?.url ?? ''}\nSHA-256: ${item.source?.sha256 ?? ''}`)) return
            if (mcpOnly && !updateAvailable) { await toggleMcp(item); return }
            await call(`plugins/${updateAvailable ? 'install' : label}`, { name: item.name })
          }) }, busy === item.name ? t('working') : t(label)))
      }
      return h('section', { className: 'xhph', 'data-xharness-plugin-hub': true },
        h('header', { className: 'xhph-head' }, h('h1', null, t('title')),
          h('div', { className: 'xhph-actions' },
            h('button', { className: 'xhph-button', type: 'button', disabled: !!busy, onClick: () => run('refresh', reload) }, t('refresh')),
            h('button', { className: 'xhph-button', type: 'button', disabled: !!busy, onClick: () => input.current?.click() }, t('add')),
            h('input', { ref: input, type: 'file', accept: '.json,application/json', hidden: true, onChange: importFile }))),
        h('input', { className: 'xhph-search', type: 'search', value: query, onChange: event => setQuery(event.target.value), placeholder: t('search'), 'aria-label': t('search') }),
        h('div', { className: `xhph-status${error ? ' xhph-error' : ''}`, role: error ? 'alert' : 'status' }, error || status),
        h('section', { className: 'xhph-installed', 'aria-labelledby': 'xhph-installed-title' },
          h('h2', { id: 'xhph-installed-title', className: 'xhph-section-title' }, t('installed')),
          filtered(installed).length ? h('div', { className: 'xhph-grid' }, filtered(installed).map(item => itemCard(item, true))) :
            h('div', { className: 'xhph-installed-empty' }, h(PluginIcon), h('span', null, t(query ? 'noMatch' : 'noInstalled')))),
        h('div', { role: 'tablist', 'aria-label': t('title'), className: 'xhph-tabs' }, options.map((key, index) => h('button', {
          key, type: 'button', role: 'tab', id: `xhph-tab-${key}`, 'aria-selected': tab === key,
          'aria-controls': `xhph-panel-${key}`, tabIndex: tab === key ? 0 : -1, className: 'xhph-tab', onClick: () => setTab(key),
          onKeyDown: event => { const next = event.key === 'ArrowRight' ? (index + 1) % options.length : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1; if (next >= 0) { event.preventDefault(); setTab(options[next]); document.getElementById(`xhph-tab-${options[next]}`)?.focus() } },
        }, t(key)))),
        h('section', { id: `xhph-panel-${tab}`, role: 'tabpanel', 'aria-labelledby': `xhph-tab-${tab}` },
          h('h2', { className: 'xhph-section-title' }, t(tab)),
          filtered(catalog.filter(item => (item.scope ?? 'public') === tab)).length ? h('div', { className: 'xhph-grid' }, filtered(catalog.filter(item => (item.scope ?? 'public') === tab)).map(item => {
            const saved = installed.find(p => p.name === item.name)
            return itemCard(saved ? { ...item, ...saved, source: item.source } : item, !!saved,
              updates.some(update => update.name === item.name))
          })) :
            h('div', { className: 'xhph-catalog-empty' }, t(query ? 'noMatch' : tab === 'public' ? 'noCatalog' : 'noPersonal'))),
        selected && h('aside', { className: 'xhph-detail' },
          h('strong', null, `${t('inspect')}: ${selected.name}`),
          h('p', null, selected.description || ''),
          h('p', null, `${t('source')}: ${selected.source?.url ?? 'installed'}`),
          h('p', null, `${t('digest')}: `, h('code', null, selected.source?.sha256 ?? selected.digest ?? '')),
          h('p', null, `${t('capabilities')}: ${(selected.capabilities ?? []).join(', ') || t('noSkills')}`),
          selectedInstalled?.capabilities?.includes('mcp') && h('button', { className: 'xhph-button', type: 'button', disabled: !!busy,
            onClick: () => run(selected.name, () => toggleMcp(selectedInstalled)) }, t(selectedInstalled.mcpEnabled ? 'stopMcp' : 'allowMcp')),
          h('p', null, t('unsupported')),
          installed.some(p => p.name === selected.name) && h('button', { className: 'xhph-button', disabled: !!busy,
            onClick: () => run(selected.name, async () => { if (window.confirm(t('confirmUninstall'))) await call('plugins/uninstall', { name: selected.name }) }) }, t('uninstall'))))
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-plugin-hub: locale')
      ctx.effect(() => { if (document.getElementById('xharness-plugin-hub-style')) return () => {}; const style = document.createElement('style'); style.id = 'xharness-plugin-hub-style'; style.textContent = CSS; document.head.append(style); return () => style.remove() }, 'xharness-plugin-hub: styles')
      const connection = ctx.get('connection')
      const call = async (endpoint, args = {}) => {
        const result = await connection.rpc.call('/api', endpoint, { args })
        if (!result.ok) throw new Error(result.error?.message ?? endpoint)
        return result.value ?? {}
      }
      ctx.slots.inject('plugins.center', () => ctx.slots.register({ name: 'plugins.center', id: 'plugin-hub', order: 0, locale: NS,
        inject: () => ({ call }), }, PluginHub))
    }
    exports.apply = apply
    exports.inject = ['slots', 'locale', 'connection']
    return exports
  },
})
