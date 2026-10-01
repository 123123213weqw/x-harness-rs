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
    const enqueueNative = task => {
      const result = nativeQueue.then(task)
      nativeQueue = result.catch(() => {})
      return result
    }
    const invoke = (command, args) => enqueueNative(() => native.core.invoke(command, args))

    function normalizeAddress(raw) {
      const value = raw.trim()
      if (!value) return { error: '请输入网址' }
      if (/\s/.test(value)) return { error: '请输入完整网址，暂不支持搜索词' }
      try {
        const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `${/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`)
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Error('unsupported URL')
        return { url: url.href }
      } catch { return { error: '仅支持有效的 http/https 网址' } }
    }
    const currentAddress = item => item.entries?.[item.position] ?? ''
    const browserHistoryKey = 'xharness:browser-spaces-v1'
    function recentAddresses(item) {
      let spaces = {}
      try { spaces = JSON.parse(localStorage.getItem(browserHistoryKey) || '{}') } catch { /* Private storage may be unavailable. */ }
      const items = [item, ...Object.values(spaces).flatMap(space => Array.isArray(space?.items) ? space.items : [])]
      const seen = new Set()
      const result = []
      for (const tab of items) {
        for (const raw of [...(Array.isArray(tab?.entries) ? tab.entries : [])].reverse()) {
          try {
            const url = new URL(raw)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue
            seen.add(url.href)
            result.push({ url: url.href, host: url.hostname, path: url.pathname === '/' ? '' : url.pathname })
            if (result.length === 8) return result
          } catch { /* Ignore stale or malformed history entries. */ }
        }
      }
      return result
    }
    const glyph = (name, size = 16) => {
      const paths = {
        globe: [h('circle', { cx: 12, cy: 12, r: 9, key: 1 }), h('path', { d: 'M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18', key: 2 })],
        left: [h('path', { d: 'm14 5-7 7 7 7', key: 1 })],
        right: [h('path', { d: 'm10 5 7 7-7 7', key: 1 })],
        reload: [h('path', { d: 'M20 11a8 8 0 1 0-2.5 6', key: 1 }), h('path', { d: 'M20 4v7h-7', key: 2 })],
        annotate: [h('path', { d: 'M5 18h5M7 14l8-8 3 3-8 8-4 1 1-4ZM14 7l3 3', key: 1 })],
        chat: [h('path', { d: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 2v-5.5a7.5 7.5 0 1 1 16-4Z', key: 1 })],
        download: [h('path', { d: 'M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3', key: 1 })],
        more: [h('circle', { cx: 5, cy: 12, r: 1, key: 1 }), h('circle', { cx: 12, cy: 12, r: 1, key: 2 }), h('circle', { cx: 19, cy: 12, r: 1, key: 3 })],
        external: [h('path', { d: 'M13 5h6v6M19 5l-9 9M19 14v5H5V5h5', key: 1 })],
        shield: [h('path', { d: 'M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6l-8-3Z', key: 1 })],
        down: [h('path', { d: 'm6 9 6 6 6-6', key: 1 })],
        up: [h('path', { d: 'm6 15 6-6 6 6', key: 1 })],
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
    const accessText = (zh, en) => document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en
    const pageOrigin = address => {
      try { const url = new URL(address); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : '' } catch { return '' }
    }
    // The view never grants optimistically or persists a lease. Native owns consent.
    function useBrowserAccess({ tabId, sessionId, address, open, blocked, syncRef }) {
      const origin = pageOrigin(address)
      const key = JSON.stringify([tabId, sessionId, address, open, blocked])
      const current = useRef(key); current.current = key
      const serial = useRef(0)
      const inFlightGrant = useRef(null)
      const [receipt, setReceipt] = useState(null)
      const [known, setKnown] = useState(false)
      const [pending, setPending] = useState(null)
      const [failure, setFailure] = useState('')
      const eligible = Boolean(native && sessionId && origin && open && !blocked)
      const request = async (mode = null) => {
        if (!eligible || inFlightGrant.current !== null) return
        const sequence = ++serial.current
        const valid = () => current.current === key && sequence === serial.current
        if (mode !== null) { inFlightGrant.current = sequence; setPending(key); setFailure('') }
        try {
          const ready = await syncRef.current?.()
          if (!valid()) return
          if (!ready) throw Error(accessText('网页不可见或正在切换，请稍后再确认。', 'The page is hidden or switching. Review access again.'))
          const result = await enqueueNative(async () => {
            if (!valid()) return null
            const result = await native.core.invoke(mode === null ? 'desktop_browser_access' : 'desktop_browser_delegate', {
              tabId, owner: mode === 'revoke' ? null : sessionId,
              ...(mode === null ? {} : { allowActions: mode === 'interactive', expectedOrigin: origin }),
            })
            // Cancellation after native dispatch must also undo a late grant.
            const validGrant = result?.origin === origin && result.grant?.owner === sessionId
              && result.grant?.allowActions === (mode === 'interactive')
              && Number.isFinite(result.grant?.remainingMs) && result.grant.remainingMs > 0 && result.grant.remainingMs <= 600000
            if (mode !== null && mode !== 'revoke' && (!valid() || !validGrant)) {
              await native.core.invoke('desktop_browser_delegate', { tabId, owner: null, allowActions: false, expectedOrigin: null })
              if (valid() && !validGrant) throw Error(accessText('授权状态不可用，已尝试撤销。', 'Access status unavailable; revocation was attempted.'))
            }
            if (mode === 'revoke' && result?.grant !== null) throw Error(accessText('撤销状态无法确认，请重试。', 'Revocation could not be confirmed. Retry.'))
            return result
          })
          if (!valid()) return
          if (!result || result.origin !== origin || !Object.hasOwn(result, 'grant')) throw Error(accessText('授权状态不可用；请检查桌面版本或网页是否已改变。', 'Access status unavailable; check the desktop version or changed page.'))
          const grant = result.grant
          if (grant && (grant.owner !== sessionId || typeof grant.allowActions !== 'boolean' || !Number.isFinite(grant.remainingMs) || grant.remainingMs <= 0 || grant.remainingMs > 600000)) throw Error(accessText('无效的原生授权状态', 'Invalid native access status'))
          setReceipt(grant ? { key, grant, deadline: performance.now() + grant.remainingMs } : null)
          setKnown(true); setFailure('')
        } catch (error) {
          if (valid()) { setReceipt(null); setKnown(false); setFailure(String(error)) }
        } finally {
          if (inFlightGrant.current === sequence) inFlightGrant.current = null
          if (valid() && mode !== null) setPending(null)
        }
      }
      useEffect(() => {
        setReceipt(null); setKnown(false); setPending(null); setFailure('')
        if (!eligible) return
        let alive = true, timer
        const poll = async () => {
          await request()
          if (alive) timer = setTimeout(poll, 2000)
        }
        void poll()
        return () => { alive = false; clearTimeout(timer); serial.current++ }
      }, [key])
      useEffect(() => {
        if (!receipt || receipt.key !== key) return
        const timer = setTimeout(() => setReceipt(null), Math.max(0, receipt.deadline - performance.now()))
        return () => clearTimeout(timer)
      }, [receipt, key])
      return { origin, eligible, grant: receipt?.key === key ? receipt.grant : null,
        busy: pending === key, known, failure, request }
    }
    function BrowserAccess({ access, sessionId, expanded, setExpanded, mode, setMode }) {
      const t = accessText
      const grant = access.grant
      return h(React.Fragment, null,
        h('div', { className: 'xhbrowser-access-bar' },
          h('button', { type: 'button', 'aria-expanded': expanded, 'aria-controls': 'xhbrowser-access-panel',
            onClick: () => setExpanded(value => !value), className: 'xhbrowser-access-trigger' },
            glyph('shield', 14), t('Agent 访问', 'Agent access'), h('span', null, '·'),
            grant ? t(grant.allowActions ? '交互' : '只读', grant.allowActions ? 'Interactive' : 'Read-only') :
              native && !access.known ? t('状态未确认', 'Unconfirmed') : t('未授权', 'Not granted'),
            glyph(expanded ? 'up' : 'down', 12)),
          (grant || (native && access.failure)) && h('button', { type: 'button', className: 'xhbrowser-access-revoke', disabled: !access.eligible || access.busy,
            onClick: () => access.request('revoke') }, t('撤销', 'Revoke'))),
        expanded && h('section', { id: 'xhbrowser-access-panel', className: 'xhbrowser-access-panel', 'aria-label': t('浏览器 Agent 访问', 'Browser Agent access') },
          h('dl', null,
            h('dt', null, t('当前会话', 'Current session')), h('dd', { title: sessionId || '' }, sessionId || t('未选择会话', 'No session selected')),
            h('dt', null, t('网页范围', 'Page scope')), h('dd', { title: access.origin }, access.origin || t('请先打开网页', 'Open a page first'))),
          h('div', { className: 'xhbrowser-access-modes', role: 'radiogroup', 'aria-label': t('访问权限', 'Access permission') },
            [['read-only', t('只读', 'Read-only'), t('读取文字和控件', 'Read text and controls')], ['interactive', t('交互', 'Interactive'), t('点击、填写、选择、滚动', 'Click, fill, select and scroll')]].map(([value, label, description]) =>
              h('label', { key: value }, h('input', { type: 'radio', name: 'browser-access-mode', value, checked: mode === value, disabled: access.busy,
                onChange: () => setMode(value) }), h('span', null, h('strong', null, label), h('small', null, description))))),
          h('p', null, !native ? t('这是 Web 界面预览，不能授予原生网页访问。请在新版桌面软件使用。', 'Web UI preview only. Native page access requires the updated desktop app.') :
            t('仅此会话和域名，有效 10 分钟。隐藏、关闭或跨域后撤销；子 Agent 不继承。', 'This session and origin only, for 10 minutes. Hide, close or cross-origin navigation revokes access; subagents do not inherit it.')),
          mode === 'interactive' && h('p', { className: 'xhbrowser-access-caution' }, t('点击可能触发页面提交；授权不会自动启动任务。', 'Clicks may submit page forms. Granting access does not start a task.')),
          access.failure && h('p', { role: 'status', className: 'xhbrowser-access-caution' }, access.failure),
          h('button', { type: 'button', className: 'xhbrowser-access-grant', disabled: !access.eligible || access.busy,
            onClick: () => access.request(mode) }, access.busy ? t('确认中…', 'Confirming…') : t(mode === 'interactive' ? '授予交互访问' : '授予只读访问', mode === 'interactive' ? 'Grant interactive access' : 'Grant read-only access'))))
    }
    function BrowserPane({ item, sessionId = null, open = false, onUpdate, onClose, onNewBrowser }) {
      const [draft, setDraft] = useState(() => currentAddress(item))
      const [error, setError] = useState('')
      const [status, setStatus] = useState('idle')
      const [menuOpen, setMenuOpen] = useState(false)
      const [downloadsOpen, setDownloadsOpen] = useState(false)
      const [downloads, setDownloads] = useState([])
      const [accessOpen, setAccessOpen] = useState(false)
      const [accessMode, setAccessMode] = useState('read-only')
      const inputRef = useRef(null)
      const contentRef = useRef(null)
      const itemRef = useRef(item)
      itemRef.current = item
      const address = currentAddress(item)
      const recent = recentAddresses(item).filter(site => site.url !== address)
      // One coordinator owns activation, including pending navigation and overlays.
      const presentationRef = useRef(null)
      presentationRef.current = { open, blocked: menuOpen || downloadsOpen }
      const nativeSyncRef = useRef(null)
      const navigationRef = useRef(null)
      const access = useBrowserAccess({ tabId: item.id, sessionId, address, open, blocked: menuOpen || downloadsOpen, syncRef: nativeSyncRef })
      useEffect(() => { setAccessOpen(false); setAccessMode('read-only') }, [item.id, sessionId])
      useEffect(() => { setDraft(address); setError('') }, [address])
      useEffect(() => {
        if (!native || !open) return
        let disposed = false
        let generation = 0
        let lastGeometry = ''
        const send = (command, args) => native.core.invoke(command, args)
        const visible = () => {
          if (disposed || itemRef.current.id !== item.id || !presentationRef.current.open || presentationRef.current.blocked || !currentAddress(itemRef.current)) return false
          const rect = contentRef.current?.getBoundingClientRect()
          if (!rect || rect.width < 1 || rect.height < 1) return false
          return ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].some(element =>
            element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
        }
        const hide = async () => {
          await send('desktop_browser_activate', { tabId: null })
          lastGeometry = 'hidden'
        }
        const syncBounds = () => {
          const requested = ++generation
          return enqueueNative(async () => {
            if (disposed || requested !== generation) return false
            const current = () => requested === generation && visible()
            if (!current()) {
              if (lastGeometry !== 'hidden') await hide()
              return false
            }
            const rect = contentRef.current.getBoundingClientRect()
            const url = currentAddress(itemRef.current)
            const pending = navigationRef.current?.tabId === item.id ? navigationRef.current : null
            const geometry = [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value * 2) / 2).join(',') + `:${url}`
            if (geometry === lastGeometry && !pending) return true
            await send('desktop_browser_bounds', { bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
            if (!current()) { await hide(); return false }
            const exists = await send('desktop_browser_activate', { tabId: item.id })
            if (!current()) { await hide(); return false }
            if (!exists || pending) {
              await send('desktop_browser_navigate', { tabId: item.id, url: pending?.url ?? url })
              if (navigationRef.current === pending) navigationRef.current = null
              if (!current()) { await hide(); return false }
            }
            lastGeometry = geometry
            return true
          }).catch(error => {
            if (!disposed && requested === generation) { setStatus('failed'); setError(String(error)) }
            return false
          })
        }
        nativeSyncRef.current = syncBounds
        const observer = new ResizeObserver(syncBounds)
        observer.observe(contentRef.current)
        const overlay = document.querySelector('[data-shell-overlay="true"]')
        const overlayObserver = new MutationObserver(syncBounds)
        if (overlay) overlayObserver.observe(overlay, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'role', 'aria-modal', 'aria-hidden'] })
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
          else if (payload.kind.startsWith('download-')) {
            setStatus(payload.kind)
            setDownloads(previous => [{ kind: payload.kind, name: String(payload.value || '').split(/[/\\]/).pop() || '下载文件' }, ...previous].slice(0, 5))
            if (payload.kind === 'download-error') setError(payload.value || '下载失败')
          }
          else if (payload.kind === 'blocked-url') setError(`已阻止非网页链接：${payload.value}`)
        }).then(fn => { if (disposed) fn(); else unlisten = fn }).catch(error => { if (!disposed) setError(String(error)) })
        return () => {
          disposed = true; generation++; observer.disconnect(); overlayObserver.disconnect(); window.removeEventListener('resize', syncBounds); unlisten?.()
          if (nativeSyncRef.current === syncBounds) nativeSyncRef.current = null
          void invoke('desktop_browser_activate', { tabId: null }).catch(() => {})
        }
      }, [item.id, open, sessionId])
      useEffect(() => { nativeSyncRef.current?.() }, [menuOpen, downloadsOpen, accessOpen, address, item.id, open, sessionId])
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
      const navigateTo = raw => {
        const result = normalizeAddress(raw)
        if (result.error) { setError(result.error); return }
        const entries = [...(item.entries ?? []).slice(0, item.position + 1), result.url]
        itemRef.current = { ...itemRef.current, entries, position: entries.length - 1 }
        onUpdate({ entries, position: entries.length - 1, title: new URL(result.url).hostname })
        setDraft(result.url); setError('')
        if (native) {
          setStatus('loading')
          navigationRef.current = { tabId: item.id, url: result.url }
          nativeSyncRef.current?.()
        }
      }
      const navigate = event => { event.preventDefault(); navigateTo(draft) }
      const composerTarget = () => [...document.querySelectorAll('[data-composer-seat] textarea, [data-composer-card] textarea')]
        .find(element => !element.disabled && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      const focusChat = () => {
        if (!composerTarget()) { setError('当前页面没有可用的聊天输入框'); return }
        setError('')
        if (document.querySelector('[data-xhworkspace-drawer]')) onClose()
        requestAnimationFrame(() => composerTarget()?.focus())
      }
      const openTerminal = () => {
        const terminal = [...document.querySelectorAll('[data-xh-terminal-trigger]')]
          .find(element => !element.disabled && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
        if (!terminal) { setError('当前页面没有可用的终端'); return }
        setError('')
        if (terminal.getAttribute('data-xh-terminal-open') !== 'true') terminal.click()
      }
      const copyAddress = async () => {
        if (!address) return
        try { await navigator.clipboard.writeText(address); setMenuOpen(false) }
        catch { setError('复制地址失败') }
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
          h('div', { className: 'xhbrowser-nav', 'aria-label': '网页导航' },
            button('后退', 'left', () => move(-1), !canBack),
            button('前进', 'right', () => move(1), !canForward),
            h('span', { className: 'xhbrowser-nav-divider', 'aria-hidden': true }),
            button('刷新', 'reload', () => { if (native) void invoke('desktop_browser_action', { tabId: item.id, action: 'reload' }).catch(error => setError(String(error))) }, !native || !address)),
          h('button', { type: 'button', className: 'xhbrowser-annotate', disabled: true, title: '网页标注尚未接入', 'aria-label': '标注（尚未接入）' },
            glyph('annotate', 16), h('span', null, '标注')),
          h('form', { className: 'xhbrowser-address-form', onSubmit: navigate },
            h('input', { ref: inputRef, type: 'text', value: draft,
              onChange: event => { setDraft(event.target.value); setError('') }, 'aria-label': '网址',
              placeholder: '搜索或输入网址', autoComplete: 'url', spellCheck: false })),
          h('div', { className: 'xhbrowser-actions', 'aria-label': '浏览器工具' },
            button('回到聊天', 'chat', focusChat),
            h('button', { type: 'button', className: 'xhbrowser-icon xhbrowser-download', 'aria-label': '下载记录',
              'aria-expanded': downloadsOpen, title: '下载记录', onClick: () => { setDownloadsOpen(value => !value); setMenuOpen(false) } }, glyph('download'))),
          h('button', { type: 'button', className: 'xhbrowser-more', 'aria-label': '更多浏览器操作', 'aria-expanded': menuOpen,
            onClick: () => { setMenuOpen(value => !value); setDownloadsOpen(false) } }, glyph('more'))),
        downloadsOpen && h('div', { className: 'xhbrowser-downloads', role: 'region', 'aria-label': '下载记录' },
          h('strong', null, '下载记录'),
          downloads.length ? downloads.map((entry, index) => h('div', { key: `${index}:${entry.name}` },
            h('span', null, entry.name), h('small', null, { 'download-start': '下载中', 'download-complete': '已完成', 'download-error': '失败' }[entry.kind])))
            : h('p', null, native ? '本次会话还没有下载。' : '网页版没有内置下载记录。')),
        menuOpen && h('div', { className: 'xhbrowser-menu' },
          h('button', { type: 'button', onClick: () => { onNewBrowser(); setMenuOpen(false) } }, '新建标签页'),
          h('button', { type: 'button', disabled: !address, onClick: copyAddress }, '复制当前网址'),
          address && h('a', { href: address, target: '_blank', rel: 'noopener noreferrer', onClick: () => setMenuOpen(false) }, '在系统浏览器打开')),
        h(BrowserAccess, { access, sessionId, expanded: accessOpen, setExpanded: setAccessOpen, mode: accessMode, setMode: setAccessMode }),
        error && h('div', { className: 'xhbrowser-error', role: 'alert' }, error),
        h('div', { className: `xhbrowser-content${address ? '' : ' xhbrowser-content-home'}`, ref: contentRef },
          !address ? h('div', { className: 'xhbrowser-home' },
            h('section', { className: 'xhbrowser-home-section' },
              h('h2', null, '工具'),
              h('div', { className: 'xhbrowser-tools' },
                h('button', { type: 'button', onClick: focusChat }, '回到聊天'),
                h('button', { type: 'button', onClick: openTerminal }, '打开终端'))),
            recent.length > 0 && h('section', { className: 'xhbrowser-home-section' },
              h('h2', null, '最近访问'),
              h('div', { className: 'xhbrowser-recents' }, recent.map(site => h('button', {
                type: 'button', key: site.url, onClick: () => navigateTo(site.url), title: site.url,
              }, h('span', { className: 'xhbrowser-site-mark', 'aria-hidden': true }, glyph('globe', 16)),
              h('span', { className: 'xhbrowser-site-label' }, h('strong', null, site.host), site.path && h('small', null, site.path)))))),
            recent.length === 0 && h('p', { className: 'xhbrowser-home-hint' }, '在上方输入网址，访问过的网页会出现在这里。'))
            : !native && h('div', { className: 'xhbrowser-empty' },
              h('div', { className: 'xhbrowser-empty-mark' }, glyph('globe', 31)),
              h('h2', null, '网页已准备好'),
              h('p', null, `网页版不能嵌入 ${new URL(address).hostname}，请在桌面软件打开。`),
              h('a', { className: 'xhbrowser-open-link', href: address, target: '_blank', rel: 'noopener noreferrer' },
                '在系统浏览器打开', glyph('external', 15)))),
        h('div', { className: 'xhbrowser-footer' }, h('span', { className: 'xhbrowser-status-dot' }), native ? `独立网页引擎 · ${{ loading: '正在加载', failed: '加载失败', 'download-start': '正在下载', 'download-complete': '下载完成', 'download-error': '下载失败' }[status] ?? '就绪'}` : '网页预览 · 内置浏览请使用桌面软件'))
    }
    const CSS = `
.xhbrowser-header-trigger{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer}.xhbrowser-header-trigger:hover,.xhbrowser-header-trigger:focus-visible{color:var(--dsw-alias-label-primary,#ddd);background:var(--dsw-alias-interactive-bg-hover,#303036)}
.xhbrowser-pane{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,#1c1c1e);color:var(--dsw-alias-label-primary,#eee)}
.xhbrowser-icon{display:inline-grid;place-items:center;flex:none;width:29px;height:29px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#aaa);cursor:pointer}.xhbrowser-icon:hover:not(:disabled){color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-hover,#35353a)}.xhbrowser-icon:disabled{opacity:.35;cursor:default}
.xhbrowser-toolbar{display:flex;align-items:center;gap:4px;flex:none;height:49px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#34343a)}.xhbrowser-address-form{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:31px;padding:0 10px;margin-left:3px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#2b2b30);color:var(--dsw-alias-label-tertiary,#aaa)}.xhbrowser-address-form:focus-within{border-color:var(--dsw-alias-label-primary,#eee)}.xhbrowser-address-form input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12px}.xhbrowser-address-form input::placeholder{color:var(--dsw-alias-label-tertiary,#888)}.xhbrowser-external{display:grid;place-items:center;flex:none;width:28px;height:28px;color:var(--dsw-alias-label-secondary,#aaa);border-radius:6px}.xhbrowser-external:hover{background:var(--dsw-alias-interactive-bg-hover,#35353a)}
.xhbrowser-content{flex:1;min-height:0;overflow:auto;display:grid;place-items:center;background:var(--dsw-alias-bg-base,#1c1c1e)}.xhbrowser-empty{text-align:center;max-width:320px;padding:28px}.xhbrowser-empty-mark{display:grid;place-items:center;margin:0 auto 18px;width:66px;height:66px;border:1px solid var(--dsw-alias-border-l2,#404047);border-radius:18px;color:var(--dsw-alias-label-secondary,#bbb);background:var(--dsw-alias-bg-layer-2,#252529)}.xhbrowser-empty h2{margin:0 0 8px;font-size:15px;font-weight:600}.xhbrowser-empty p{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:1.7;overflow-wrap:anywhere}.xhbrowser-open-link{display:inline-flex;align-items:center;gap:6px;margin-top:20px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:7px;color:var(--dsw-alias-label-primary,#eee);font-size:12px;text-decoration:none}.xhbrowser-open-link:hover{background:var(--dsw-alias-interactive-bg-hover,#35353a)}.xhbrowser-footer{display:flex;align-items:center;gap:7px;height:32px;flex:none;padding:0 15px;border-top:1px solid var(--dsw-alias-border-l1,#34343a);color:var(--dsw-alias-label-tertiary,#888);font-size:10px}.xhbrowser-status-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d39b42)}.xhbrowser-error{padding:7px 16px;color:var(--dsw-alias-state-error-primary,#e87979);font-size:11px}
.xhbrowser-access-bar{display:flex;align-items:center;justify-content:space-between;flex:none;min-height:32px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#34343a)}
.xhbrowser-access-trigger,.xhbrowser-access-revoke{display:flex;align-items:center;gap:6px;padding:5px 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#aaa);font:inherit;font-size:11px;cursor:pointer}.xhbrowser-access-trigger:hover,.xhbrowser-access-revoke:hover{color:var(--dsw-alias-label-primary,#eee)}
.xhbrowser-access-panel{box-sizing:border-box;flex:none;max-height:50%;overflow:auto;padding:10px 12px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#34343a);background:var(--dsw-alias-bg-layer-2,#29292e);font-size:11px}
.xhbrowser-access-panel dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;margin:0 0 10px}.xhbrowser-access-panel dt{color:var(--dsw-alias-label-tertiary,#999)}.xhbrowser-access-panel dd{margin:0;overflow-wrap:anywhere}
.xhbrowser-access-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.xhbrowser-access-modes label{display:flex;gap:6px;align-items:flex-start;padding:9px 7px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:8px;cursor:pointer}.xhbrowser-access-modes input{margin:2px 0;accent-color:var(--dsw-alias-label-primary,#eee)}.xhbrowser-access-modes span{min-width:0}.xhbrowser-access-modes strong{display:block;font-weight:500}.xhbrowser-access-modes small{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary,#999);font-size:10px;line-height:1.4}
.xhbrowser-access-panel p{margin:8px 0;color:var(--dsw-alias-label-tertiary,#999);line-height:1.6;overflow-wrap:anywhere}.xhbrowser-access-panel .xhbrowser-access-caution{color:var(--dsw-alias-label-secondary,#bbb)}
.xhbrowser-access-grant{display:block;width:100%;min-height:30px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:7px;background:var(--dsw-alias-label-primary,#eee);color:var(--dsw-alias-bg-base,#1c1c1e);font:inherit;font-size:11px;cursor:pointer}.xhbrowser-access-grant:disabled,.xhbrowser-access-revoke:disabled{opacity:.4;cursor:default}
.xhbrowser-pane{position:relative}
.xhbrowser-toolbar{gap:8px;height:54px;padding:0 12px}
.xhbrowser-nav{display:flex;align-items:center;gap:1px;flex:none;padding:2px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:11px;background:var(--dsw-alias-bg-layer-2,#29292e)}
.xhbrowser-nav .xhbrowser-icon{width:27px;height:27px}
.xhbrowser-address-form{height:34px;margin:0;border-radius:11px;padding:0 12px}
.xhbrowser-address-form input{text-align:left;font-size:12px}
.xhbrowser-more{display:grid;place-items:center;flex:none;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#29292e);color:var(--dsw-alias-label-secondary,#aaa);font-size:16px;line-height:1;cursor:pointer}
.xhbrowser-more:hover,.xhbrowser-more[aria-expanded=true]{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-interactive-bg-hover,#35353a)}
.xhbrowser-menu{position:absolute;right:12px;top:49px;z-index:30;display:flex;flex-direction:column;min-width:164px;padding:5px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#29292e);box-shadow:0 12px 30px #0003}
.xhbrowser-menu button,.xhbrowser-menu a{display:block;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12px;text-align:left;text-decoration:none;cursor:pointer}
.xhbrowser-menu button:hover:not(:disabled),.xhbrowser-menu a:hover{background:var(--dsw-alias-interactive-bg-hover,#35353a)}.xhbrowser-menu button:disabled{opacity:.42;cursor:default}
.xhbrowser-content-home{display:block}
.xhbrowser-home{box-sizing:border-box;max-width:560px;margin:0 auto;padding:26px 22px 40px}
.xhbrowser-home-section{margin:0 0 29px}.xhbrowser-home-section h2{margin:0 0 12px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#eee)}
.xhbrowser-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.xhbrowser-tools button{min-height:46px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#29292e);color:var(--dsw-alias-label-primary,#eee);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.xhbrowser-tools button:hover,.xhbrowser-recents button:hover{background:var(--dsw-alias-interactive-bg-hover,#35353a)}
.xhbrowser-recents{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:11px;overflow:hidden}
.xhbrowser-recents button{display:flex;align-items:center;gap:10px;min-width:0;min-height:47px;padding:7px 10px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;text-align:left;cursor:pointer}
.xhbrowser-recents button:last-child{border-bottom:0}.xhbrowser-site-mark{display:grid;place-items:center;flex:none;width:29px;height:29px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#29292e);color:var(--dsw-alias-label-tertiary,#999)}
.xhbrowser-site-label{display:flex;flex-direction:column;min-width:0;gap:1px}.xhbrowser-site-label strong,.xhbrowser-site-label small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhbrowser-site-label strong{font-size:12px;font-weight:500}.xhbrowser-site-label small{font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}
.xhbrowser-home-hint{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:1.6}
.xhbrowser-pane :is(button,input,a):focus-visible{outline:2px solid var(--dsw-alias-label-primary,#eee);outline-offset:2px}
.xhbrowser-pane{container-type:inline-size}
.xhbrowser-toolbar{height:58px;gap:6px;padding:0 10px}
.xhbrowser-nav,.xhbrowser-actions{display:flex;align-items:center;flex:none;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:999px;background:var(--dsw-alias-bg-layer-2,#29292e)}
.xhbrowser-nav{gap:0;padding:2px 3px}.xhbrowser-actions{gap:0;padding:2px 3px}
.xhbrowser-nav-divider{width:1px;height:17px;margin:0 2px;background:var(--dsw-alias-border-l2,#444)}
.xhbrowser-nav .xhbrowser-icon,.xhbrowser-actions .xhbrowser-icon{width:26px;height:27px;border-radius:999px}
.xhbrowser-annotate{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:999px;background:var(--dsw-alias-bg-layer-2,#29292e);color:var(--dsw-alias-label-secondary,#aaa);font:inherit;font-size:12px}
.xhbrowser-annotate:disabled{cursor:not-allowed;opacity:.58}
.xhbrowser-address-form{height:34px;border-radius:999px;padding:0 8px;min-width:0}
.xhbrowser-address-form input{text-align:center;text-overflow:ellipsis;font-size:12px}
.xhbrowser-address-form:focus-within input{text-align:left;text-overflow:clip}
.xhbrowser-download{color:#3b83e8}.xhbrowser-download:hover:not(:disabled){color:#2266d4}
.xhbrowser-more{width:33px;height:33px;border-radius:999px}
.xhbrowser-menu,.xhbrowser-downloads{top:54px}
.xhbrowser-downloads{position:absolute;right:46px;z-index:30;box-sizing:border-box;width:min(280px,calc(100% - 28px));padding:12px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#29292e);box-shadow:0 12px 30px #0003;font-size:12px}
.xhbrowser-downloads>strong{display:block;margin-bottom:9px}.xhbrowser-downloads>div{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l2,#444)}.xhbrowser-downloads>div span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhbrowser-downloads small{flex:none;color:var(--dsw-alias-label-tertiary,#999)}.xhbrowser-downloads p{margin:0;color:var(--dsw-alias-label-tertiary,#999)}
@container(max-width:420px){.xhbrowser-annotate{width:33px;padding:0}.xhbrowser-annotate span{display:none}}
@container(max-width:390px){.xhbrowser-toolbar{gap:4px;padding:0 7px}.xhbrowser-nav .xhbrowser-icon,.xhbrowser-actions .xhbrowser-icon{width:23px}.xhbrowser-more,.xhbrowser-annotate{width:29px}.xhbrowser-home{padding:22px 16px}.xhbrowser-tools{grid-template-columns:1fr}}
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
