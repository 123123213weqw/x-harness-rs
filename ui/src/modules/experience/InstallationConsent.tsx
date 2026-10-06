import * as React from 'react'
import { Modal } from '@xharness/dsh-client-ui-primitives'
import type { NativeInvoke } from '../shared/tauri'
import { decodeStatus, type Status } from './InstallationStatistics'

export const consentLabels = {
  zh: {
    title: '帮助改善 XHarness', intro: '分享可选统计，帮助改善体验。',
    privacy: '不收集对话、图片、密钥或硬件标识。', control: '你可以随时在设置中关闭。',
    later: '暂不开启', agree: '同意并开启', saving: '正在保存…', details: '了解更多', notice: '隐私说明',
    detailsText: '仅发送随机安装 ID、软件版本、系统、架构、发布通道，以及启动和更新结果。安装数不代表用户人数。',
    noticeText: '用于统计安装与更新情况。原始事件保存 90 天；连续 365 天未上报的安装记录移除。关闭后停止上报并申请删除，断网时延后处理；服务端保留 90 天不可逆撤销凭据，防止迟到请求恢复记录。',
    error: '暂时无法确认选择已保存，请重试。', local: '你的选择保存在本机，不影响正常使用。',
  },
  en: {
    title: 'Help improve XHarness', intro: 'Share optional statistics to improve your experience.',
    privacy: 'We never collect conversations, images, keys or hardware identifiers.', control: 'You can turn this off anytime in Settings.',
    later: 'Not now', agree: 'Agree & enable', saving: 'Saving…', details: 'Learn more', notice: 'Privacy notice',
    detailsText: 'Only a random installation ID, app version, OS, architecture, release channel and startup / update outcomes. Installation counts are not unique-user counts.',
    noticeText: 'Used to understand installations and updates. Raw events expire after 90 days; installations inactive for 365 days are removed. Disabling stops reporting and requests deletion when connected. An irreversible denial receipt remains for 90 days to prevent late requests restoring a deleted record.',
    error: 'We could not confirm that your choice was saved. Please retry.', local: 'Your choice stays on this device. Normal use is unaffected.',
  },
}
export type ConsentCopy = typeof consentLabels.en
export function shouldOfferConsent(status: Status): boolean {
  return status.configured && status.noticeRequired && !status.enabled && !status.deletionPending && status.error === null
}
/** Same content is used by the actual desktop modal and the explicitly marked Web preview. */
export function ConsentCard({ copy, busy = false, error = false, onChoose }: {
  copy: ConsentCopy; busy?: boolean; error?: boolean; onChoose: (enabled: boolean) => void
}) {
  const [expanded, setExpanded] = React.useState(false)
  return <section className="xhi-card" aria-labelledby="xhi-title">
    <h2 id="xhi-title">{copy.title}</h2>
    <p className="xhi-intro">{copy.intro}</p>
    <div className="xhi-links">
      <button type="button" aria-expanded={expanded} aria-controls="xhi-disclosure" onClick={() => setExpanded(v => !v)}>{copy.details}</button>
    </div>
    {expanded && <div id="xhi-disclosure" className="xhi-disclosure">
      <p>{copy.detailsText}</p><p>{copy.privacy} {copy.control}</p><p>{copy.noticeText}</p><p>{copy.local}</p>
    </div>}
    {error && <p className="xhi-error" role="alert">{copy.error}</p>}
    <div className="xhi-actions" aria-busy={busy}>
      <button type="button" disabled={busy} onClick={() => onChoose(false)}>{copy.later}</button>
      <button type="button" className="xhi-primary" disabled={busy} onClick={() => onChoose(true)}>{busy ? copy.saving : copy.agree}</button>
    </div>
  </section>
}
/** The existing onboarding coordinator owns order; no extra root, polling or Host service. */
export function InstallationConsent({ t, complete }: { t: (key: string) => string; complete: () => void }) {
  const invoke: NativeInvoke | undefined = window.__TAURI__?.core?.invoke
  const [visible, setVisible] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(false)
  const mounted = React.useRef(false)
  const pending = React.useRef(false)
  const done = React.useRef(complete); done.current = complete
  React.useEffect(() => {
    mounted.current = true
    if (!invoke) { done.current(); return () => { mounted.current = false } }
    let active = true
    void invoke('desktop_installation_status').then(value => {
      if (!active) return
      if (shouldOfferConsent(decodeStatus(value))) setVisible(true)
      else done.current()
    }).catch(() => { if (active) done.current() })
    return () => { active = false; mounted.current = false }
  }, [invoke])
  async function choose(enabled: boolean) {
    if (!invoke || pending.current) return
    pending.current = true; setBusy(true); setError(false)
    try {
      const status = decodeStatus(await invoke('desktop_set_installation_statistics', { enabled }))
      if (status.enabled !== enabled || status.noticeRequired) throw new Error('Choice not saved')
      if (mounted.current) { setVisible(false); done.current() }
    } catch { if (mounted.current) setError(true) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const copy: ConsentCopy = {
    title: t('title'), intro: t('intro'), privacy: t('privacy'), control: t('control'), later: t('later'), agree: t('agree'), saving: t('saving'),
    details: t('details'), notice: t('notice'), detailsText: t('detailsText'), noticeText: t('noticeText'), error: t('error'), local: t('local'),
  }
  return <Modal open={visible} headless title={copy.title} className="xhi-dialog" onClose={() => { void choose(false) }}>
    <ConsentCard copy={copy} busy={busy} error={error} onChoose={enabled => { void choose(enabled) }} />
  </Modal>
}
