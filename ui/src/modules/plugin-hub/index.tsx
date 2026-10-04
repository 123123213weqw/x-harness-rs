/// <reference path="../shared/assets.d.ts" />
import CSS from './PluginHub.css'
import type { PluginHubProps, PluginHubContext, PluginCard, DescriptionItem } from '../../../types/plugin-runtime'
import type { CatalogScope, CatalogEntry, InstalledPlugin, PluginUpdate } from '../../plugin-api/contracts'

import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPluginClient, errorMessage } from '@xlang/xharness-client-plugin-api'
import { Modal, Button } from '@xharness/dsh-client-ui-primitives'
interface Confirmation {
  key: string
  title: string
  message: string
  label: string
  action: () => Promise<unknown>
}
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
  cancel: '取消', close: '关闭',
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
  cancel: 'Cancel', close: 'Close',
}

function PluginIcon() {
  return h('span', { className: 'xhph-symbol', 'aria-hidden': true },
    h('svg', { width: 30, height: 30, viewBox: '0 0 16 16', fill: 'none' },
      h('path', { d: 'M2.4 2.5h3.05c-.15.64.26 1.18.9 1.18s1.05-.54.9-1.18h3.65v3.05c.64-.15 1.18.26 1.18.9s-.54 1.05-1.18.9v3.65H7.85c.15.64-.26 1.18-.9 1.18s-1.05-.54-.9-1.18H2.4V7.85c-.64.15-1.18-.26-1.18-.9s.54-1.05 1.18-.9V2.5Z', transform: 'translate(0 -0.75) scale(1.2)', stroke: 'currentColor', strokeWidth: .9, strokeLinecap: 'round', strokeLinejoin: 'round' })))
}
function CatalogIcon({ name, icon }: { name: string; icon: string | null | undefined }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  let url: string | null = null
  if (icon && icon.length <= 4096) {
    try {
      const parsed = new URL(icon, window.location.href)
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) url = parsed.href
    } catch { /* Invalid metadata uses the same fallback as a missing icon. */ }
  }
  const showImage = url !== null && url !== failedUrl
  return h('div', { className: `xhph-icon${showImage ? ' xhph-icon-artwork' : ''}`, 'aria-hidden': true },
    showImage
      ? h('img', { src: url ?? undefined, alt: '', width: 42, height: 42, loading: 'lazy', decoding: 'async',
        referrerPolicy: 'no-referrer', onError: () => setFailedUrl(url) })
      : name.slice(0, 1).toUpperCase())
}
function PluginHub({ t, call }: PluginHubProps) {
  const [tab, setTab] = useState<CatalogScope>('public')
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [updates, setUpdates] = useState<PluginUpdate[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const pending = useRef<Confirmation | null>(null)
  const life = useRef({ active: true, generation: 0, busy: false })
  const input = useRef<HTMLInputElement>(null)
  const current = (generation: number) => life.current.active && life.current.generation === generation
  async function reload(generation = life.current.generation) {
    const [a, b, c] = await Promise.all([call('plugins/catalog'), call('plugins/installed'), call('plugins/updates')])
    if (current(generation)) { setCatalog(a.plugins ?? []); setInstalled(b.plugins ?? []); setUpdates(c.updates ?? []) }
  }
  useEffect(() => {
    life.current.active = true
    life.current.busy = false
    pending.current = null
    setConfirmation(null); setBusy('')
    return () => { life.current.active = false; life.current.generation++; pending.current = null }
  }, [call])
  useEffect(() => { let active = true; Promise.all([call('plugins/catalog'), call('plugins/installed'), call('plugins/updates')])
    .then(([a, b, c]) => { if (active) { setCatalog(a.plugins ?? []); setInstalled(b.plugins ?? []); setUpdates(c.updates ?? []) } })
    .catch((e: unknown) => { if (active) setError(errorMessage(e)) })
    return () => { active = false }
  }, [call])
  async function run<T>(key: string, action: () => Promise<T>, reloadAfter = true): Promise<T | undefined> {
    if (!life.current.active || life.current.busy || pending.current) return
    const generation = life.current.generation
    life.current.busy = true
    setBusy(key); setError(''); setStatus('')
    try { const result = await action(); if (current(generation) && reloadAfter) await reload(generation); return result }
    catch (e) { if (current(generation)) setError(`${t('failed')}: ${errorMessage(e)}`); return undefined }
    finally { if (current(generation)) { life.current.busy = false; setBusy('') } }
  }
  function requestConfirmation(value: Confirmation) {
    if (!life.current.active || life.current.busy || pending.current) return
    pending.current = value
    setConfirmation(value)
  }
  function cancelConfirmation() { pending.current = null; setConfirmation(null) }
  function acceptConfirmation() {
    const value = pending.current
    if (!value) return
    // Consume the acknowledgement synchronously: rapid clicks cannot enqueue
    // a second mutation before React commits the disabled state.
    pending.current = null; setConfirmation(null)
    void run(value.key, value.action)
  }
  async function importFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setError('Catalog exceeds 2 MiB'); return }
    await run('import', async () => { await call('plugins/importCatalog', { content: await file.text(), scope: tab }); setStatus(t('imported')) })
  }
  async function toggleMcp(item: InstalledPlugin) {
    if (!item.mcpEnabled) {
      const generation = life.current.generation
      const preview = await run(item.name, () => call('plugins/mcpPreview', { name: item.name }), false)
      if (!preview || !current(generation)) return
      const summary = (preview.servers ?? []).map(server => {
        const bindings = Object.entries(server.envSources ?? {}).map(([key, source]) => `${key} ← ${source}`)
        return `${server.server}: ${server.command} ${(server.args ?? []).join(' ')}\nENV: ${bindings.length ? bindings.join(', ') : (server.envKeys ?? []).join(', ')}`
      }).join('\n')
      requestConfirmation({ key: item.name, title: `${t('allowMcp')}: ${item.name}`, message: `${t('confirmMcp')}\n${summary}`,
        label: t('allowMcp'), action: () => call('plugins/mcpEnable', { name: item.name }) })
      return
    }
    await run(item.name, () => call('plugins/mcpDisable', { name: item.name }))
  }
  const options = ['public', 'personal'] as const
  const selectedCatalog = catalog.find(item => item.name === detail)
  const selectedInstalled = installed.find(item => item.name === detail)
  const selected: PluginCard | null = selectedInstalled ? { ...selectedCatalog, ...selectedInstalled, source: selectedCatalog?.source } : selectedCatalog ?? null
  const filtered = <T extends DescriptionItem,>(list: T[]): T[] => list.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  function itemCard(item: PluginCard, saved: InstalledPlugin | undefined, updateAvailable = false) {
    const isInstalled = !!saved
    const mcpOnly = !!saved && !saved.skills.length && saved.capabilities.includes('mcp')
    const label = updateAvailable ? 'update' : isInstalled ? (mcpOnly ? (saved?.mcpEnabled ? 'stopMcp' : 'allowMcp') : (saved?.enabled ? 'disable' : 'enable')) : 'install'
    return h('div', { className: 'xhph-item', key: item.name },
      h(CatalogIcon, { name: item.name, icon: item.icon ?? catalog.find(entry => entry.name === item.name)?.icon }),
      h('div', { className: 'xhph-copy', onClick: () => setDetail(item.name), role: 'button', tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => { if (e.key === 'Enter') setDetail(item.name) } },
        h('div', { className: 'xhph-name' }, item.name),
        h('div', { className: 'xhph-desc' }, item.description || item.version)),
      h('button', { className: 'xhph-button', disabled: !!busy || !!confirmation, onClick: () => {
        if (!isInstalled || updateAvailable) {
          requestConfirmation({ key: item.name, title: `${t(label)}: ${item.name}`, label: t(label),
            message: `${t('confirmInstall')}\n${item.source?.url ?? ''}\nSHA-256: ${item.source?.sha256 ?? ''}`,
            action: () => call('plugins/install', { name: item.name }) })
        } else if (mcpOnly && saved) { void toggleMcp(saved) }
        else if (saved) { void run(item.name, () => call(saved.enabled ? 'plugins/disable' : 'plugins/enable', { name: item.name })) }
      } }, busy === item.name ? t('working') : t(label)))
  }
  return h('section', { className: 'xhph', 'data-xharness-plugin-hub': true },
    h('header', { className: 'xhph-head' }, h('h1', null, t('title')),
      h('div', { className: 'xhph-actions' },
        h('button', { className: 'xhph-button', type: 'button', disabled: !!busy, onClick: () => run('refresh', reload) }, t('refresh')),
        h('button', { className: 'xhph-button', type: 'button', disabled: !!busy, onClick: () => input.current?.click() }, t('add')),
        h('input', { ref: input, type: 'file', accept: '.json,application/json', hidden: true, onChange: importFile }))),
    h('input', { className: 'xhph-search', type: 'search', value: query, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), placeholder: t('search'), 'aria-label': t('search') }),
    h('div', { className: `xhph-status${error ? ' xhph-error' : ''}`, role: error ? 'alert' : 'status' }, error || status),
    h('section', { className: 'xhph-installed', 'aria-labelledby': 'xhph-installed-title' },
      h('h2', { id: 'xhph-installed-title', className: 'xhph-section-title' }, t('installed')),
      filtered(installed).length ? h('div', { className: 'xhph-grid' }, filtered(installed).map(item => itemCard(item, item))) :
        h('div', { className: 'xhph-installed-empty' }, h(PluginIcon), h('span', null, t(query ? 'noMatch' : 'noInstalled')))),
    h('div', { role: 'tablist', 'aria-label': t('title'), className: 'xhph-tabs' }, options.map((key, index) => h('button', {
      key, type: 'button', role: 'tab', id: `xhph-tab-${key}`, 'aria-selected': tab === key,
      'aria-controls': `xhph-panel-${key}`, tabIndex: tab === key ? 0 : -1, className: 'xhph-tab', onClick: () => setTab(key),
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => { const next = event.key === 'ArrowRight' ? (index + 1) % options.length : event.key === 'ArrowLeft' ? (index + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1; const nextTab = options[next]; if (nextTab !== undefined) { event.preventDefault(); setTab(nextTab); document.getElementById(`xhph-tab-${nextTab}`)?.focus() } },
    }, t(key)))),
    h('section', { id: `xhph-panel-${tab}`, role: 'tabpanel', 'aria-labelledby': `xhph-tab-${tab}` },
      h('h2', { className: 'xhph-section-title' }, t(tab)),
      filtered(catalog.filter(item => (item.scope ?? 'public') === tab)).length ? h('div', { className: 'xhph-grid' }, filtered(catalog.filter(item => (item.scope ?? 'public') === tab)).map(item => {
        const saved = installed.find(p => p.name === item.name)
        return itemCard(saved ? { ...item, ...saved, source: item.source } : item, saved,
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
        onClick: () => toggleMcp(selectedInstalled) }, t(selectedInstalled.mcpEnabled ? 'stopMcp' : 'allowMcp')),
      h('p', null, t('unsupported')),
      installed.some(p => p.name === selected.name) && h('button', { className: 'xhph-button', disabled: !!busy,
        onClick: () => requestConfirmation({ key: selected.name, title: `${t('uninstall')}: ${selected.name}`, message: t('confirmUninstall'),
          label: t('uninstall'), action: () => call('plugins/uninstall', { name: selected.name }) }) }, t('uninstall'))),
    h(Modal, { open: !!confirmation, title: confirmation?.title ?? '', closeLabel: t('close'), onClose: cancelConfirmation,
      footer: h('div', { className: 'xhph-confirm-actions' },
        h(Button, { variant: 'outline', onClick: cancelConfirmation }, t('cancel')),
        h(Button, { variant: 'primary', onClick: acceptConfirmation }, confirmation?.label ?? '')) },
      h('div', { className: 'xhph-confirm-message' }, confirmation?.message)))
}
function apply(ctx: PluginHubContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-plugin-hub: locale')
  ctx.effect(() => { if (document.getElementById('xharness-plugin-hub-style')) return () => {}; const style = document.createElement('style'); style.id = 'xharness-plugin-hub-style'; style.textContent = CSS; document.head.append(style); return () => style.remove() }, 'xharness-plugin-hub: styles')
  const connection = ctx.get('connection')
  const call = createPluginClient(connection.rpc)
  ctx.slots.inject('plugins.center', () => ctx.slots.register({ name: 'plugins.center', id: 'plugin-hub', order: 0, locale: NS,
    inject: () => ({ call }), }, PluginHub))
}
const inject = ['slots', 'locale', 'connection']

export { apply, inject }
