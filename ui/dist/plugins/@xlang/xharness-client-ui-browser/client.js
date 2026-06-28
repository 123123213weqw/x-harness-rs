window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-browser',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React
    const STYLE_ID = 'xharness-browser-pane-style'
    const OPEN_EVENT = 'xharness:workspace-open'
    const openBrowser = fresh => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { kind: 'browser', fresh } }))
    const native = window.__TAURI__?.core?.invoke ? window.__TAURI__ : null
    let nativeQueue = Promise.resolve()
    const invoke = (command, args) => {
      const result = nativeQueue.then(() => native.core.invoke(command, args))
      nativeQueue = result.catch(() => {})
      return result
    }

    function normalizeAddress(raw) {
      const value = raw.trim()
      if (!value) return { error: '请输入网址' }
      if (/\s/.test(value)) return { error: '请输入完整网址，暂不支持搜索词' }
      try {
        const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `${/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`)
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Error('unsupported URL')
        return { url: url.href }
      } catch { return { error: '仅支持有效的 http/https 网址' } }
    }
    const currentAddress = item => item.entries?.[item.position] ?? ''
    const glyph = (name, size = 16) => {
      const paths = {
        globe: [h('circle', { cx: 12, cy: 12, r: 9, key: 1 }), h('path', { d: 'M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18', key: 2 })],
        left: [h('path', { d: 'm14 5-7 7 7 7', key: 1 })],
        right: [h('path', { d: 'm10 5 7 7-7 7', key: 1 })],
        external: [h('path', { d: 'M13 5h6v6M19 5l-9 9M19 14v5H5V5h5', key: 1 })],
        sidebar: [h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.6, key: 1 }), h('path', { d: 'M10.5 2.5v11', key: 2 }), h('path', { d: 'm13 6.5-1.5 1.5L13 9.5', key: 3 })],
      }
      return h('svg', { width: size, height: size, viewBox: name === 'sidebar' ? '0 0 16 16' : '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: name === 'sidebar' ? 1.4 : 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, paths[name])
    }
    const button = (label, icon, onClick, disabled = false) => h('button', { type: 'button', className: 'xhbrowser-icon',
      'aria-label': label, title: label, onClick, disabled }, glyph(icon))

    function BrowserToggle() {
      return h('button', { type: 'button', className: 'xhbrowser-header-trigger', 'aria-label': '展开右侧工作区',
        title: '展开右侧工作区', onClick: () => openBrowser(false) }, glyph('sidebar', 14))
    }
    function BrowserPane({ item, open = false, onUpdate, onClose, onNewBrowser }) {
      const [draft, setDraft] = useState(() => currentAddress(item))
      const [error, setError] = useState('')
      const [status, setStatus] = useState('idle')
      const inputRef = useRef(null)
      const contentRef = useRef(null)
      const itemRef = useRef(item)
      itemRef.current = item
      const address = currentAddress(item)
      useEffect(() => { setDraft(address); setError('') }, [address])
      useEffect(() => {
        if (!native || !open) return
        let disposed = false
        let lastGeometry = ''
        const syncBounds = () => {
          if (disposed || !contentRef.current) return
          const rect = contentRef.current.getBoundingClientRect()
          if (rect.width < 1 || rect.height < 1) return
          const modal = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
            .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
          const geometry = [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value * 2) / 2).join(',') + `:${modal}`
          if (geometry === lastGeometry) return
          lastGeometry = geometry
          if (modal) {
            void invoke('desktop_browser_activate', { tabId: null }).catch(() => {})
            return
          }
          void invoke('desktop_browser_bounds', { bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
            .then(() => invoke('desktop_browser_activate', { tabId: item.id }))
            .then(exists => {
              const url = currentAddress(itemRef.current)
              if (url && !exists) return invoke('desktop_browser_navigate', { tabId: item.id, url })
            })
            .catch(error => { if (!disposed) setError(String(error)) })
        }
        const observer = new ResizeObserver(syncBounds)
        observer.observe(contentRef.current)
        const overlay = document.querySelector('[data-shell-overlay="true"]')
        const overlayObserver = new MutationObserver(syncBounds)
        if (overlay) overlayObserver.observe(overlay, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-modal'] })
        window.addEventListener('resize', syncBounds)
        requestAnimationFrame(syncBounds)
        let unlisten = null
        native.event.listen('xharness-browser-event', event => {
          const payload = event.payload
          if (disposed || payload?.tabId !== item.id) return
          if (payload.kind === 'url') {
            const current = itemRef.current
            const entries = current.entries ?? []
            if (entries[current.position] === payload.value) return
            const previous = entries.lastIndexOf(payload.value)
            const patch = previous >= 0
              ? { position: previous, title: new URL(payload.value).hostname }
              : { entries: [...entries.slice(0, current.position + 1), payload.value], position: current.position + 1, title: new URL(payload.value).hostname }
            itemRef.current = { ...current, ...patch }
            onUpdate(patch)
          } else if (payload.kind === 'title') onUpdate({ title: payload.value || item.title })
          else if (payload.kind === 'loading') setStatus('loading')
          else if (payload.kind === 'loaded') setStatus('loaded')
          else if (payload.kind === 'download-start') setStatus('download-start')
          else if (payload.kind === 'download-complete') setStatus('download-complete')
          else if (payload.kind === 'download-error') { setStatus('download-error'); setError(payload.value || '下载失败') }
          else if (payload.kind === 'blocked-url') setError(`已阻止非网页链接：${payload.value}`)
        }).then(fn => { if (disposed) fn(); else unlisten = fn }).catch(error => { if (!disposed) setError(String(error)) })
        return () => {
          disposed = true; observer.disconnect(); overlayObserver.disconnect(); window.removeEventListener('resize', syncBounds); unlisten?.()
          void invoke('desktop_browser_activate', { tabId: null }).catch(() => {})
        }
      }, [item.id, open])
      useEffect(() => {
        if (!open) return
        const onKey = event => {
          if (event.key === 'Escape') { onClose(); return }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
            event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select()
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
            event.preventDefault(); onNewBrowser()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, onClose, onNewBrowser])
      const navigate = event => {
        event.preventDefault()
        const result = normalizeAddress(draft)
        if (result.error) { setError(result.error); return }
        const entries = [...(item.entries ?? []).slice(0, item.position + 1), result.url]
        itemRef.current = { ...itemRef.current, entries, position: entries.length - 1 }
        onUpdate({ entries, position: entries.length - 1, title: new URL(result.url).hostname })
        setDraft(result.url); setError('')
        if (native) {
          setStatus('loading')
          const rect = contentRef.current?.getBoundingClientRect()
          const bounds = rect && { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
          void (bounds ? invoke('desktop_browser_bounds', { bounds }) : Promise.reject(Error('浏览器面板尚未布局')))
            .then(() => invoke('desktop_browser_navigate', { tabId: item.id, url: result.url }))
            .catch(error => { setStatus('failed'); setError(String(error)) })
        }
      }
      const move = offset => {
        if (native) {
          void invoke('desktop_browser_action', { tabId: item.id, action: offset < 0 ? 'back' : 'forward' }).catch(error => setError(String(error)))
          return
        }
        const position = Math.max(0, Math.min(item.entries.length - 1, item.position + offset))
        onUpdate({ position, title: new URL(item.entries[position]).hostname })
      }
      const canBack = item.position > 0
      const canForward = item.position < (item.entries?.length ?? 0) - 1
      return h('section', { className: 'xhbrowser-pane', 'aria-label': '内置浏览器面板' },
        h('div', { className: 'xhbrowser-toolbar' },
          button('后退', 'left', () => move(-1), !canBack),
          button('前进', 'right', () => move(1), !canForward),
          button('刷新', 'globe', () => { if (native) void invoke('desktop_browser_action', { tabId: item.id, action: 'reload' }).catch(error => setError(String(error))) }, !native || !address),
          h('form', { className: 'xhbrowser-address-form', onSubmit: navigate }, glyph('globe', 14),
            h('input', { ref: inputRef, type: 'text', value: draft,
              onChange: event => { setDraft(event.target.value); setError('') }, 'aria-label': '网址',
              placeholder: '输入网址，例如 example.com', autoComplete: 'url', spellCheck: false })),
          address && h('a', { className: 'xhbrowser-external', href: address, target: '_blank', rel: 'noopener noreferrer',
            'aria-label': '在系统浏览器打开', title: '在系统浏览器打开' }, glyph('external'))),
        error && h('div', { className: 'xhbrowser-error', role: 'alert' }, error),
        h('div', { className: 'xhbrowser-content', ref: contentRef }, (!native || !address) && h('div', { className: 'xhbrowser-empty' },
          h('div', { className: 'xhbrowser-empty-mark' }, glyph('globe', 31)),
          h('h2', null, address ? '内置浏览器仅在桌面软件可用' : '在这里浏览网页'),
          h('p', null, address ? `网页版不能嵌入 ${new URL(address).hostname}，请在桌面软件打开。`
            : native ? '输入网址并回车，在独立网页引擎中浏览。' : '输入网址并回车；内置浏览仅在桌面软件可用。'),
          address && h('a', { className: 'xhbrowser-open-link', href: address, target: '_blank', rel: 'noopener noreferrer' },
            '在系统浏览器打开', glyph('external', 15)))),
        h('div', { className: 'xhbrowser-footer' }, h('span', { className: 'xhbrowser-status-dot' }), native ? `独立网页引擎 · ${{ loading: '正在加载', failed: '加载失败', 'download-start': '正在下载', 'download-complete': '下载完成', 'download-error': '下载失败' }[status] ?? '就绪'}` : '网页预览 · 请使用桌面软件'))
    }
    const CSS = `
.xhbrowser-header-trigger{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer}.xhbrowser-header-trigger:hover,.xhbrowser-header-trigger:focus-visible{color:var(--dsw-alias-label-primary,#ddd);background:var(--dsw-alias-interactive-bg-hover,#303036)}
.xhbrowser-pane{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,#1c1c1e);color:var(--dsw-alias-label-primary,#eee)}
.xhbrowser-icon{display:inline-grid;place-items:center;flex:none;width:29px;height:29px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#aaa);cursor:pointer}.xhbrowser-icon:hover:not(:disabled){color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-hover,#35353a)}.xhbrowser-icon:disabled{opacity:.35;cursor:default}
.xhbrowser-toolbar{display:flex;align-items:center;gap:4px;flex:none;height:49px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#34343a)}.xhbrowser-address-form{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:31px;padding:0 10px;margin-left:3px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#2b2b30);color:var(--dsw-alias-label-tertiary,#aaa)}.xhbrowser-address-form:focus-within{border-color:var(--dsw-alias-label-primary,#eee)}.xhbrowser-address-form input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12px}.xhbrowser-address-form input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}.xhbrowser-external{display:grid;place-items:center;flex:none;width:28px;height:28px;color:var(--dsw-alias-label-secondary,#aaa);border-radius:6px}.xhbrowser-external:hover{background:var(--dsw-alias-interactive-bg-hover,#35353a)}
.xhbrowser-content{flex:1;min-height:0;overflow:auto;display:grid;place-items:center;background:var(--dsw-alias-bg-base,#1c1c1e)}.xhbrowser-empty{text-align:center;max-width:320px;padding:28px}.xhbrowser-empty-mark{display:grid;place-items:center;margin:0 auto 18px;width:66px;height:66px;border:1px solid var(--dsw-alias-border-l2,#404047);border-radius:18px;color:var(--dsw-alias-label-secondary,#bbb);background:var(--dsw-alias-bg-layer-2,#252529)}.xhbrowser-empty h2{margin:0 0 8px;font-size:15px;font-weight:600}.xhbrowser-empty p{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.7;overflow-wrap:anywhere}.xhbrowser-open-link{display:inline-flex;align-items:center;gap:6px;margin-top:20px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:7px;color:var(--dsw-alias-label-primary,#eee);font-size:12px;text-decoration:none}.xhbrowser-open-link:hover{background:var(--dsw-alias-interactive-bg-hover,#35353a)}.xhbrowser-footer{display:flex;align-items:center;gap:7px;height:32px;flex:none;padding:0 15px;border-top:1px solid var(--dsw-alias-border-l1,#34343a);color:var(--dsw-alias-label-tertiary,#888);font-size:10px}.xhbrowser-status-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d39b42)}.xhbrowser-error{padding:7px 16px;color:var(--dsw-alias-state-error-primary,#e87979);font-size:11px}
`
    const inject = ['slots']
    function apply(ctx) {
      ctx.effect(() => {
        if (!native) return () => {}
        const onCloseTab = event => {
          const id = event.detail?.id
          if (!id) return
          void invoke('desktop_browser_close', { tabId: id }).catch(() => {})
        }
        window.addEventListener('xharness:browser-close', onCloseTab)
        let unlisten = null
        let disposed = false
        native.event.listen('xharness-browser-event', event => {
          const payload = event.payload
          if (payload?.kind === 'popup') window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { kind: 'browser', fresh: true, url: payload.value } }))
        }).then(fn => { if (disposed) fn(); else unlisten = fn }).catch(() => {})
        return () => { disposed = true; unlisten?.(); window.removeEventListener('xharness:browser-close', onCloseTab) }
      }, 'xharness-ui-browser: close native tabs')
      ctx.effect(() => {
        if (document.getElementById(STYLE_ID)) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID; style.textContent = CSS; document.head.append(style)
        return () => style.remove()
      }, 'xharness-ui-browser: styles')
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'browser-toggle', order: 100,
      }, BrowserToggle))
      ctx.slots.inject('workspace.item', () => ctx.slots.register({
        name: 'workspace.item', id: 'browser-pane', order: 40,
      }, props => props.item?.kind === 'browser' ? h(BrowserPane, props) : null))
    }
    module.exports = { apply, inject, normalizeAddress, BrowserPane, BrowserToggle }
    return module.exports
  },
})
