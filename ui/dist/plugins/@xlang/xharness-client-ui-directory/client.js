// Product adapter for the shipped workspace directory-flow ABI. Workspace
// adoption/persistence stays with the upstream owner; paths stay with the host.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-ui-directory',
  factory: require => {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { Modal, Button, IconFolderClose16, IconChevronRightOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives')
    const NS = 'xharness.directory'
    const zh = {
      title: '选择工作区目录', home: '主目录', path: '目录路径', go: '前往',
      locations: '磁盘和位置', chooseLocation: '选择一个磁盘或位置，也可输入完整路径。',
      rememberedUnavailable: '上次浏览的位置暂不可用，请选择其他位置。',
      locationsUnavailable: '磁盘列表暂不可用，已尝试返回主目录；也可输入完整路径。',
      newFolder: '新建文件夹', folderName: '文件夹名称', create: '创建', cancel: '取消',
      open: '打开工作区', loading: '加载中…', retry: '重试', empty: '此目录没有子文件夹',
      hidden: '显示隐藏文件夹', truncated: '文件夹过多，仅显示前面一部分。可输入完整路径打开。',
      createIn: '将在此目录中新建文件夹：', invalid: '请输入单个文件夹名称，不能包含路径分隔符。',
    }
    const en = {
      title: 'Select Workspace Directory', home: 'Home', path: 'Directory path', go: 'Go',
      locations: 'Drives and locations', chooseLocation: 'Choose a drive or location, or enter a full path.',
      rememberedUnavailable: 'The previous location is unavailable. Choose another location.',
      locationsUnavailable: 'The drive list is unavailable. Tried Home instead; you can also enter a full path.',
      newFolder: 'New folder', folderName: 'Folder name', create: 'Create', cancel: 'Cancel',
      open: 'Open workspace', loading: 'Loading…', retry: 'Retry', empty: 'No subfolders in this directory',
      hidden: 'Show hidden folders', truncated: 'Only the first folders are listed. Enter a full path to open another.',
      createIn: 'Create a folder in:', invalid: 'Enter one folder name without path separators.',
    }
    const failureText = error => error?.rpcError?.message ?? error?.message ?? String(error)
    // Per-window and per-origin, shared by sidebar and conversation pickers.
    // Storage may be blocked; remembering a path must never break navigation.
    const MEMORY_KEY = 'xharness.directory.lastPath.v1'
    let lastPath = ''
    let storageAvailable = true
    function rememberedPath() {
      if (storageAvailable) {
        try { return sessionStorage.getItem(MEMORY_KEY) ?? lastPath } catch { storageAvailable = false }
      }
      return lastPath
    }
    function rememberPath(path) {
      lastPath = path
      if (storageAvailable) {
        try { sessionStorage.setItem(MEMORY_KEY, path) } catch { storageAvailable = false }
      }
    }

    function DirectoryFlow(props) {
      // Unmount on close so an earlier read/create cannot affect a new picker.
      return props.open ? h(DirectoryDialog, props) : null
    }

    function DirectoryDialog({ busy, onPicked, onCancel, listDirectory, createDirectory, t }) {
      const [listing, setListing] = useState(null)
      const [draft, setDraft] = useState('')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [places, setPlaces] = useState([])
      const [showHidden, setShowHidden] = useState(false)
      const [folder, setFolder] = useState(null)
      const [creating, setCreating] = useState(false)
      const [createError, setCreateError] = useState(null)
      const life = useRef({ alive: false, generation: 0, controller: null, requested: undefined, mutating: false, picked: false })
      const pathInput = useRef(null)
      const body = useRef(null)
      const folderInput = useRef(null)
      const newFolderButton = useRef(null)

      function invalidate() {
        life.current.generation++
        life.current.controller?.abort()
      }

      async function navigate(path, { recover = false, notice = null } = {}) {
        const state = life.current
        if (!state.alive || state.mutating || state.picked || busy) return
        invalidate()
        const generation = state.generation
        const controller = new AbortController()
        state.controller = controller
        state.requested = path
        setLoading(true)
        setError(null)
        setNotice(notice)
        // Never let Open adopt a stale directory after a failed path change.
        setListing(null)
        if (path !== undefined) setDraft(path)
        try {
          const result = await listDirectory(path, controller.signal)
          if (!state.alive || state.generation !== generation) return
          setListing(result)
          setDraft(result.path)
          rememberPath(result.path)
          if (result.path === '') setPlaces(result.entries)
        } catch (reason) {
          if (!state.alive || state.generation !== generation) return
          // Only startup memory and the virtual overview get a fallback.
          // Explicit filesystem paths keep their own errors and retry action.
          if (path === '') {
            void navigate(undefined, { notice: notice ?? t('locationsUnavailable') })
          } else if (recover && path !== undefined) {
            void navigate('', { notice: t('rememberedUnavailable') })
          } else setError(failureText(reason))
        } finally {
          if (state.alive && state.generation === generation) setLoading(false)
        }
      }

      useEffect(() => {
        life.current.alive = true
        const previousFocus = document.activeElement
        const app = document.getElementById('root')
        const wasInert = app?.inert
        if (app) app.inert = true
        pathInput.current?.focus()
        const initial = rememberedPath()
        const placesController = new AbortController()
        // Loading shortcuts must never overwrite the active directory/draft.
        if (initial !== '') {
          void listDirectory('', placesController.signal).then(result => {
            if (life.current.alive && !placesController.signal.aborted && result.path === '') setPlaces(result.entries)
          }).catch(() => { /* Older hosts can still browse Home/typed paths. */ })
        }
        void navigate(initial, { recover: true })
        return () => {
          life.current.alive = false
          invalidate()
          placesController.abort()
          if (app) app.inert = wasInert
          if (previousFocus?.isConnected) previousFocus.focus()
        }
      }, [])
      useEffect(() => {
        if (folder !== null) folderInput.current?.focus()
      }, [folder !== null])

      const locked = busy || creating
      const pathDirty = listing !== null && draft !== listing.path
      function cancel() {
        if (busy || life.current.mutating || life.current.picked) return
        life.current.alive = false
        invalidate()
        onCancel()
      }
      function closeFolder() {
        if (life.current.mutating) return
        setFolder(null)
        setCreateError(null)
        newFolderButton.current?.focus()
      }
      async function confirmCreate(event) {
        event.preventDefault()
        const state = life.current
        if (locked || state.mutating || state.picked || !listing?.path || folder === null) return
        if (!folder.trim() || folder === '.' || folder === '..' || /[/\\\0]/.test(folder)) {
          setCreateError(t('invalid'))
          return
        }
        state.mutating = true
        setCreating(true)
        setCreateError(null)
        try {
          const path = await createDirectory(listing.path, folder)
          if (!state.alive) return
          setFolder(null)
          state.mutating = false
          // Host returns the actual path; no Windows/POSIX joining in the UI.
          void navigate(path)
          pathInput.current?.focus()
        } catch (reason) {
          if (state.alive) setCreateError(failureText(reason))
        } finally {
          state.mutating = false
          if (state.alive) setCreating(false)
        }
      }
      function pick() {
        if (locked || loading || pathDirty || folder !== null || !listing?.path || life.current.picked) return
        life.current.picked = true
        onPicked(listing.path)
      }
      const entries = listing?.entries.filter(entry => showHidden || !entry.hidden) ?? []
      const button = (label, onClick, disabled, variant = 'outline') => h(Button, { onClick, disabled, variant }, label)
      return h(Modal, {
        open: true, title: t('title'), closeLabel: t('cancel'),
        onClose: () => { if (folder !== null) closeFolder(); else cancel() },
        className: 'xhdir-dialog', headless: true,
      }, h('div', { ref: body, tabIndex: -1, className: 'xhdir-body', onKeyDown: event => {
        // IME Enter confirms composition, never a path or mkdir operation.
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === 'Enter') event.preventDefault()
          event.stopPropagation()
        }
        if (event.key === 'Tab') {
          const targets = [...body.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
            .filter(element => element.getClientRects().length > 0)
          const next = event.shiftKey ? targets.at(-1) : targets[0]
          if (!targets.length || (event.shiftKey && document.activeElement === targets[0])
            || (!event.shiftKey && document.activeElement === targets.at(-1))) {
            event.preventDefault()
            ;(next ?? body.current).focus()
          }
        }
      } },
        h('header', { className: 'xhdir-header' },
          h('h2', null, t('title')),
          h('nav', { className: 'xhdir-places', 'aria-label': t('locations') },
            h('button', { type: 'button', disabled: locked || folder !== null, 'aria-current': listing?.path === '' ? 'location' : undefined,
              onClick: () => { void navigate('') } }, t('locations')),
            h('button', { type: 'button', disabled: locked || folder !== null, onClick: () => { void navigate() } }, t('home')),
            ...places.map(place => h('button', { key: place.path, type: 'button', title: place.path,
              disabled: locked || folder !== null, onClick: () => { void navigate(place.path) } }, place.name))),
          h('form', { className: 'xhdir-path', onSubmit: event => { event.preventDefault(); if (!locked && draft.trim()) void navigate(draft) } },
            h('input', { ref: pathInput, value: draft, 'aria-label': t('path'), disabled: locked || folder !== null,
              placeholder: t('path'), onChange: event => {
                // A typed draft supersedes a pending scan even before Go.
                invalidate()
                setLoading(false)
                setDraft(event.target.value)
              }, spellCheck: false }),
            h(Button, { type: 'submit', variant: 'outline', disabled: locked || folder !== null || !draft.trim() }, t('go'))),
          h('nav', { className: 'xhdir-crumbs', 'aria-label': t('path') },
            ...(listing?.crumbs ?? []).map(crumb => h('button', { key: crumb.path, type: 'button', title: crumb.path,
              disabled: locked || folder !== null, onClick: () => { void navigate(crumb.path) } }, crumb.name || crumb.path)))),
        h('div', { className: 'xhdir-content', 'aria-busy': loading },
          notice && h('p', { role: 'status' }, notice),
          listing?.path === '' && h('p', { role: 'status' }, t('chooseLocation')),
          loading && h('p', { role: 'status' }, t('loading')),
          error && h('div', { className: 'xhdir-error', role: 'alert' }, error, ' ',
            button(t('retry'), () => { void navigate(life.current.requested) }, locked)),
          listing && h('ul', { className: 'xhdir-list' }, ...entries.map(entry => h('li', { key: entry.path },
            h('button', { type: 'button', disabled: locked || folder !== null, title: entry.path, onClick: () => { void navigate(entry.path) } },
              h(IconFolderClose16, { size: 16 }), h('span', null, entry.name), h(IconChevronRightOutline14, { size: 14 }))))),
          listing?.path && entries.length === 0 && h('p', { role: 'status' }, t('empty')),
          listing?.truncated && h('p', { role: 'status' }, t('truncated'))),
        folder !== null && h('form', { className: 'xhdir-create', 'aria-label': t('newFolder'), onSubmit: confirmCreate,
          onKeyDown: event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); closeFolder() } } },
          h('label', null, t('folderName'), h('input', { ref: folderInput, value: folder, disabled: creating,
            onChange: event => setFolder(event.target.value), spellCheck: false })),
          h('p', null, t('createIn'), ' ', h('span', { className: 'xhdir-target' }, listing?.path)),
          createError && h('div', { role: 'alert', className: 'xhdir-error' }, createError),
          h('div', { className: 'xhdir-actions' }, button(t('cancel'), closeFolder, creating),
            h(Button, { type: 'submit', variant: 'primary', disabled: creating || !folder.trim() }, t('create')))),
        h('footer', { className: 'xhdir-footer' },
          h('button', { ref: newFolderButton, type: 'button', className: 'xhdir-new',
            disabled: locked || loading || pathDirty || !listing?.path || folder !== null,
            onClick: () => { setFolder(''); setCreateError(null) } }, '+ ', t('newFolder')),
          h('label', { className: 'xhdir-hidden' }, h('input', { type: 'checkbox', checked: showHidden, disabled: locked,
            onChange: event => setShowHidden(event.target.checked) }), t('hidden')),
          h('div', { className: 'xhdir-actions' }, button(t('cancel'), cancel, locked || folder !== null),
            button(t('open'), pick, locked || loading || pathDirty || !listing?.path || folder !== null, 'primary')))))
    }

    const CSS = `
.xhdir-dialog.xhdir-dialog{width:min(680px,100%);padding:0;gap:0;max-height:calc(100dvh - 32px)}
.xhdir-body{display:flex;flex-direction:column;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.xhdir-header{padding:20px 24px 12px;display:flex;flex-direction:column;gap:12px}.xhdir-header h2{margin:0;font-size:16px;font-weight:600}
.xhdir-places{display:flex;gap:6px;overflow:auto;white-space:nowrap;max-height:68px}.xhdir-places button{flex:none;max-width:180px;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:5px 8px;background:transparent;color:inherit;font:inherit;cursor:pointer}.xhdir-places button:hover,.xhdir-places button[aria-current]{background:var(--dsw-alias-interactive-bg-hover)}
.xhdir-path{display:flex;gap:8px}.xhdir-path input,.xhdir-create input{min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:inherit;padding:8px 10px;font:inherit}.xhdir-path input{flex:1;width:0}.xhdir-path input:focus,.xhdir-create input:focus{outline:2px solid var(--dsw-alias-button-info-fill,#3978f6);outline-offset:1px}
.xhdir-crumbs{display:flex;gap:4px;overflow:auto;white-space:nowrap}.xhdir-crumbs button{flex:none;max-width:180px;overflow:hidden;text-overflow:ellipsis;border:0;border-radius:6px;padding:4px 6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}.xhdir-crumbs button+button:before{content:'›';margin-right:8px;color:var(--dsw-alias-label-tertiary)}
.xhdir-content{min-height:80px;height:240px;overflow:auto;padding:8px 24px;border-block:1px solid var(--dsw-alias-border-l3)}.xhdir-content p{color:var(--dsw-alias-label-secondary)}
.xhdir-list{list-style:none;margin:0;padding:0}.xhdir-list button{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:6px;padding:8px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.xhdir-list span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xhdir-list svg{flex:none}.xhdir-list button:hover,.xhdir-crumbs button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.xhdir-footer{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:16px 24px}.xhdir-actions{display:flex;gap:8px;justify-content:flex-end;margin-left:auto}.xhdir-new{border:0;border-radius:6px;background:transparent;color:inherit;padding:6px 0;font:inherit;cursor:pointer}.xhdir-hidden{display:flex;gap:4px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}.xhdir-hidden input{accent-color:var(--dsw-alias-button-info-fill,#3978f6)}
.xhdir-create{padding:12px 24px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l3);overflow:auto;flex-shrink:0;max-height:40dvh}.xhdir-create label{display:flex;flex-direction:column;gap:6px}.xhdir-create p{margin:0;font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}.xhdir-target{user-select:text}.xhdir-error{color:var(--dsw-alias-state-error-primary,#c33);overflow-wrap:anywhere}.xhdir-body button:disabled{opacity:.45;cursor:default}
@media(max-width:480px){.xhdir-header{padding:16px 16px 8px}.xhdir-content{padding:8px 16px}.xhdir-footer,.xhdir-create{padding:12px 16px}.xhdir-footer>.xhdir-actions{width:100%}}
`
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'xharness-directory: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      }, 'xharness-directory: styles')
      const injected = () => ({
        listDirectory: (path, signal) => ctx.workspaces.listDirectory(path, signal),
        createDirectory: (path, name) => ctx.workspaces.createDirectory(path, name),
        t: ctx.locale.bind(NS),
      })
      for (const name of ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']) {
        ctx.slots.inject(name, () => ctx.slots.register({ name, inject: injected }, DirectoryFlow))
      }
    }
    return { inject: ['slots', 'workspaces', 'locale'], apply }
  },
})
