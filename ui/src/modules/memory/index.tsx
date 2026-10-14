/// <reference path="../shared/assets.d.ts" />
import CSS from './Memory.css'
import {createElement as h, useEffect, useRef, useState} from 'react'
import type {PageContext, Translation} from '../shared/runtime-types'
import {errorText} from '../shared/runtime-types'
import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
import {MemoryClient, type MemoryView, type Mode, type Workspace} from './client'
const NS = 'xharness.memory'
const zh = {
  nav: '工作区记忆', title: '工作区记忆', subtitle: '保存在本机应用数据目录，按工作区共享，不随模型变化，也不写入 Git。',
  workspace: '工作区', none: '暂无工作区', loading: '读取中…', mode: '保存方式', off: '关闭', manual: '仅明确要求时', auto: '自动整理（可选）',
  policy: '手动模式：明确说“记住……”才会保存。自动模式：允许模型在合适的任务节点整理已验证事实，不保证每轮都更新。不保存密钥、完整对话或临时选择。',
  document: 'MEMORY.md', hint: '顶部简短索引会进入下一轮上下文，完整记录由模型按需读取。正在运行的上下文不会被改写。',
  reload: '重新读取', save: '保存', clear: '清空', saved: '已保存', working: '处理中…', unavailable: '此部署未启用工作区记忆。',
  damaged: '文件过大或含无效编码，不能覆盖保存；可备份后清空修复。', clearConfirm: '清空当前工作区记忆？不会删除对话历史或已记录的请求快照。',
  reloadConfirm: '放弃当前未保存修改并重新读取？', autoConfirm: '允许模型自动保存已验证的长期事实？仍使用现有文件工具和审批权限。',
  failure: '操作未确认，请重新读取后重试。你的草稿仍保留。', disabled: '关闭后，新工具调用不能再访问记忆；已进入模型上下文的内容不会被撤回。',
}
const en = {
  nav: 'Workspace memory', title: 'Workspace memory', subtitle: 'Local app data, shared within this workspace across models. Never written to Git.',
  workspace: 'Workspace', none: 'No workspaces yet', loading: 'Loading…', mode: 'Memory mode', off: 'Off', manual: 'Only when asked', auto: 'Auto curate (optional)',
  policy: 'Manual: say “remember…” explicitly. Auto: lets the model curate verified facts at useful milestones, not necessarily every turn. Never store secrets, full conversations or temporary choices.',
  document: 'MEMORY.md', hint: 'A short top index enters the next turn. The model reads details on demand. Running context is not rewritten.',
  reload: 'Reload', save: 'Save', clear: 'Clear memory', saved: 'Saved', working: 'Working…', unavailable: 'Workspace memory is not enabled in this deployment.',
  damaged: 'Oversized or invalid-encoding file: saving is disabled. Back it up before clearing to repair.', clearConfirm: 'Clear this workspace memory? Conversation history and recorded request snapshots remain.',
  reloadConfirm: 'Discard your unsaved draft and reload?', autoConfirm: 'Allow automatic curation of verified long-term facts? Existing file tools and approval permissions still apply.',
  failure: 'Operation not confirmed. Reload before retrying; your draft is preserved.', disabled: 'Off denies new memory tool calls; content already in a running context cannot be retracted.',
}
interface Context extends PageContext {get(name: 'connection'): {rpc: ClientConnectionRpc}}
interface Entry {view?: MemoryView; draft?: string; busy?: boolean; error?: string; notice?: string}
function MemorySettings({client, t}: {client: MemoryClient; t: Translation}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selected, setSelected] = useState('')
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [listError, setListError] = useState('')
  const lifetime = useRef<AbortController>()
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    void client.workspaces(controller.signal).then(rows => {
      if (!controller.signal.aborted) {setWorkspaces(rows); setSelected(rows[0]?.id ?? '')}
    }).catch((e: unknown) => {if (!controller.signal.aborted) setListError(errorText(e))})
    return () => controller.abort()
  }, [client])
  const patch = (id: string, next: Partial<Entry>) => {
    if (!lifetime.current?.signal.aborted) setEntries(old => ({...old, [id]: {...old[id], ...next}}))
  }
  async function load(id: string) {
    const signal = lifetime.current?.signal; if (!signal) return
    patch(id, {busy: true, error: '', notice: ''})
    try {const view = await client.view(id, signal); if (!signal.aborted) patch(id, {view, draft: view.content})}
    catch (e: unknown) {if (!signal.aborted) patch(id, {error: errorText(e)})}
    finally {if (!signal.aborted) patch(id, {busy: false})}
  }
  useEffect(() => {if (selected && !entries[selected]) void load(selected)}, [selected])
  const entry = entries[selected] ?? {}, view = entry.view
  const dirty = view !== undefined && entry.draft !== view.content
  async function change(action: 'save'|'clear'|'configure', mode?: Mode) {
    const signal = lifetime.current?.signal; if (!view || !signal || entry.busy) return
    if (action === 'clear' && !window.confirm(t('clearConfirm'))) return
    if (mode === 'auto' && !window.confirm(t('autoConfirm'))) return
    const id = selected
    patch(id, {busy: true, error: '', notice: ''})
    try {
      const payload = action === 'configure' && mode ? {action: 'configure' as const, mode, settingsVersion: view.settingsVersion} :
        action === 'clear' ? {action: 'clear' as const, version: view.version} : {action: 'save' as const, content: entry.draft ?? '', version: view.version}
      const version = await client.mutate(id, payload, signal)
      if (signal.aborted) return
      const next = action === 'configure' ? {...view, mode: mode ?? view.mode, settingsVersion: version, settingsError: ''} :
        {...view, version, content: action === 'clear' ? '' : entry.draft ?? '', tooLarge: false, invalidUtf8: false}
      patch(id, {view: next, ...(action === 'configure' ? {} : {draft: next.content}), notice: t('saved')})
    } catch (e: unknown) {if (!signal.aborted) patch(id, {error: `${t('failure')} ${errorText(e)}`})}
    finally {if (!signal.aborted) patch(id, {busy: false})}
  }
  return h('section', {className: 'xhm-root'},
    h('h2', null, t('title')), h('p', null, t('subtitle')),
    listError && h('p', {role: 'alert'}, listError),
    h('label', null, t('workspace'), h('select', {'aria-label': t('workspace'), value: selected, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setSelected(event.target.value)},
      workspaces.length ? workspaces.map(w => h('option', {key: w.id, value: w.id}, `${w.title} · ${w.path}`)) : h('option', {value: ''}, t('none')))),
    selected && !view && !entry.error && h('p', {role: 'status'}, t('loading')),
    view && !view.available && h('p', null, t('unavailable')),
    view?.available && h('div', null,
      h('label', null, t('mode'), h('select', {'aria-label': t('mode'), value: view.mode ?? '', disabled: entry.busy,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {const mode = event.target.value; if (mode === 'off' || mode === 'manual' || mode === 'auto') void change('configure', mode)}},
        view.mode === null && h('option', {value: '', disabled: true}, '—'),
        (['off', 'manual', 'auto'] as const).map(mode => h('option', {key: mode, value: mode}, t(mode))))),
      h('p', null, t('policy')), view.mode === 'off' && h('p', null, t('disabled')),
      view.settingsError && h('p', {role: 'alert'}, view.settingsError),
      h('label', null, t('document'), h('textarea', {value: entry.draft ?? '', disabled: entry.busy || view.tooLarge || view.invalidUtf8,
        spellCheck: false, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => patch(selected, {draft: event.target.value, notice: ''})})),
      h('p', null, t('hint'), ` · ${new TextEncoder().encode(entry.draft ?? '').length} / 65536 bytes`),
      (view.tooLarge || view.invalidUtf8) && h('p', {role: 'alert'}, t('damaged')),
      h('div', {className: 'xhm-actions'},
        h('button', {type: 'button', disabled: entry.busy || !dirty || view.tooLarge || view.invalidUtf8 || new TextEncoder().encode(entry.draft ?? '').length > 65536, onClick: () => void change('save')}, t('save')),
        h('button', {type: 'button', disabled: entry.busy || view.version === null, onClick: () => void change('clear')}, t('clear')))),
    selected && h('button', {type: 'button', disabled: entry.busy, onClick: () => {if (!dirty || window.confirm(t('reloadConfirm'))) void load(selected)}}, t('reload')),
    entry.busy && h('p', {role: 'status'}, t('working')),
    entry.error && h('p', {role: 'alert'}, entry.error), entry.notice && h('p', {role: 'status'}, entry.notice))
}
const inject = ['slots', 'locale', 'connection']
function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'workspace-memory: locale')
  ctx.effect(() => {const style = document.createElement('style'); style.textContent = CSS; document.head.append(style); return () => style.remove()}, 'workspace-memory: style')
  const client = new MemoryClient(ctx.get('connection').rpc), t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({name: 'settings.section', id: 'memory', order: 31, label: () => t('nav'), inject: () => ({client, t})}, MemorySettings))
}
export {apply, inject, MemorySettings}
