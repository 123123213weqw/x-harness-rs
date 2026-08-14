import * as React from 'react'
import type { NativeInvoke } from '../shared/tauri'
const h = React.createElement
export type Status = { noticeRequired: boolean; enabled: boolean; configured: boolean; pendingReports: number; deletionPending: boolean; droppedEvents: number; error: string | null }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function decodeStatus(value: unknown): Status {
  if (!isRecord(value)) throw new Error('Invalid statistics status')
  const s = value
  if ((s.noticeRequired !== undefined && typeof s.noticeRequired !== 'boolean') || typeof s.enabled !== 'boolean' || typeof s.configured !== 'boolean' || typeof s.deletionPending !== 'boolean'
    || typeof s.pendingReports !== 'number' || !Number.isSafeInteger(s.pendingReports) || s.pendingReports < 0 || s.pendingReports > 64
    || typeof s.droppedEvents !== 'number' || !Number.isSafeInteger(s.droppedEvents) || s.droppedEvents < 0
    || (s.error !== null && typeof s.error !== 'string')) throw new Error('Invalid statistics status')
  return { noticeRequired: s.noticeRequired === true, enabled: s.enabled, configured: s.configured, deletionPending: s.deletionPending, pendingReports: s.pendingReports, droppedEvents: s.droppedEvents, error: s.error }
}
export const statisticsLabels = {
  zh: { nav: '安装统计与隐私', title: '安装统计与隐私', intro: '自愿帮助我们了解安装量、版本分布和更新成功率。默认关闭，不影响 AI 和更新功能。',
    privacy: '仅发送随机安装 ID、版本、系统、架构、通道和启动 / 更新结果。不发送对话、图片、密钥、文件路径或硬件标识。',
    retention: '原始事件保存 90 天；连续 365 天未上报的安装移除。关闭后清除本机待发事件并申请删除服务端设备记录；离线时延后删除，期间不再上报。',
    enabled: '安装统计已开启', disabled: '安装统计已关闭', enable: '开启统计', disable: '关闭并删除记录', pending: '条记录待补发', deletion: '删除请求待联网完成。完成前不能重新开启。',
    web: '此设置仅用于桌面软件；普通 Web 页面不会登记为一次安装。', unavailable: '此构建未配置统计服务，无法开启。', error: '统计暂时不可用，不影响任务；没有发送日志或错误正文。', loading: '读取设置中…', busy: '正在保存…', retrySave: '重试保存关闭设置', unsavedOff: '统计已停止，但关闭设置尚未保存。请修复存储后重试；重启可能恢复旧设置。' },
  en: { nav: 'Installation statistics & privacy', title: 'Installation statistics & privacy', intro: 'Optionally help us understand installs, versions and successful updates. Off by default; AI and updates work independently.',
    privacy: 'Sends only a random installation ID, version, OS, architecture, channel and startup / update outcomes. Never conversations, images, keys, paths or hardware identifiers.',
    retention: 'Raw events expire after 90 days; devices inactive for 365 days are removed. Opting out clears queued events and requests server deletion. Offline deletion waits for connectivity; reporting stops immediately.',
    enabled: 'Installation statistics enabled', disabled: 'Installation statistics disabled', enable: 'Enable statistics', disable: 'Disable & delete records', pending: 'reports queued', deletion: 'Deletion awaits connectivity. Re-enabling requires deletion to finish.',
    web: 'Desktop only. Ordinary Web pages are not registered as installations.', unavailable: 'This build has no configured statistics service.', error: 'Statistics unavailable; tasks are unaffected. Logs and error bodies are not reported.', loading: 'Reading settings…', busy: 'Saving…', retrySave: 'Retry saving opt-out', unsavedOff: 'Reporting stopped, but opt-out could not be saved. Fix storage and retry; a restart may restore the old preference.' },
}
export function InstallationStatistics({ t }: { t: (key: string) => string }) {
  const invoke: NativeInvoke | undefined = window.__TAURI__?.core?.invoke
  const [status, setStatus] = React.useState<Status | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(false)
  const epoch = React.useRef(0)
  const pending = React.useRef(false)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    if (!invoke) return
    let active = true
    mounted.current = true
    const refresh = async () => { if (pending.current) return; const id = ++epoch.current; try { const next = decodeStatus(await invoke('desktop_installation_status')); if (active && id === epoch.current) { setStatus(next); setError(false) } } catch { if (active && id === epoch.current) setError(true) } }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => { active = false; mounted.current = false; ++epoch.current; window.clearInterval(timer) }
  }, [invoke])
  async function toggle() {
    if (!invoke || !status || pending.current || busy) return
    const id = ++epoch.current; pending.current = true
    setBusy(true); setError(false)
    try { const next = decodeStatus(await invoke('desktop_set_installation_statistics', { enabled: status.error === 'statistics_optout_not_persisted' ? false : !status.enabled })); if (mounted.current && id === epoch.current) setStatus(next) }
    catch { if (mounted.current && id === epoch.current) { setError(true); try { const next = decodeStatus(await invoke('desktop_installation_status')); if (mounted.current && id === epoch.current) setStatus(next) } catch { /* retain visible error */ } } }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return h('div', { className: 'xhe-root' }, [
    h('header', { key: 'header' }, [h('h2', { key: 'title' }, t('title')), h('p', { key: 'intro' }, t('intro'))]),
    h('section', { key: 'settings' }, [h('p', { key: 'privacy' }, t('privacy')), h('p', { key: 'retention' }, t('retention')),
      !invoke ? h('p', { key: 'web', role: 'status' }, t('web')) : status ? h(React.Fragment, { key: 'status' }, [
        h('h3', { key: 'label' }, t(status.enabled ? 'enabled' : 'disabled')),
        !status.configured && h('p', { key: 'unconfigured' }, t('unavailable')),
        status.deletionPending && h('p', { key: 'deletion', role: 'status' }, t('deletion')),
        status.pendingReports > 0 && h('p', { key: 'pending' }, `${status.pendingReports} ${t('pending')}`),
        h('button', { key: 'toggle', className: 'xhe-reset', type: 'button', disabled: busy || (!status.enabled && status.error !== 'statistics_optout_not_persisted' && (!status.configured || status.deletionPending)), onClick: toggle }, t(busy ? 'busy' : status.error === 'statistics_optout_not_persisted' ? 'retrySave' : status.enabled ? 'disable' : 'enable')),
      ]) : !error && h('p', { key: 'loading' }, t('loading')),
      (error || status?.error) && h('p', { key: 'error', role: 'alert', className: 'xhe-note' }, t(status?.error === 'statistics_optout_not_persisted' ? 'unsavedOff' : 'error')),
    ]),
  ])
}
