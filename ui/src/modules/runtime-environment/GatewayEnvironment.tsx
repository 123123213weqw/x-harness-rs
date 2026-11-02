import { useEffect, useState, useSyncExternalStore } from 'react'
import { Menu, IconChevronDownOutline14, IconFollowsystemOutline16, IconGlobeOutline14 } from '@xharness/dsh-client-ui-primitives'
import type { HostDescriptionSource } from '../client-connection/install'
import type { RuntimeEnvironmentOwnerProps } from '../conversation/contract/slots'
import { EnvironmentPicker } from './EnvironmentPicker'
import { openEnvironment, parseCatalogue, type EnvironmentCatalogue } from './gateway'
import type { EnvironmentKey } from './locales'

type Translate = (key: EnvironmentKey) => string
interface GatewayProps { description: HostDescriptionSource }
function useCatalogue(): EnvironmentCatalogue | undefined {
  const [catalogue, setCatalogue] = useState<EnvironmentCatalogue>()
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch('/api/environments', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
        if (controller.signal.aborted) return
        if (response.ok) {
          const raw: unknown = await response.json()
          const parsed = parseCatalogue(raw, location.origin)
          if (!controller.signal.aborted && parsed !== undefined) setCatalogue(previous => previous ?? parsed)
        } // A missing optional endpoint is normal on an ordinary local Host.
      } catch { /* Discovery is optional. Retain this page's immutable validated identity; live connectivity is owned by ConnectionController. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, 30_000)
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])
  return catalogue
}
function Picker({ catalogue, t, appearance }: { catalogue: EnvironmentCatalogue; t: Translate; appearance?: RuntimeEnvironmentOwnerProps['appearance'] }) {
  const [open, setOpen] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const current = catalogue.entries.find(e => e.id === catalogue.current)
  const Icon = current?.kind === 'cloud' ? IconGlobeOutline14 : IconFollowsystemOutline16
  return <span data-xh-environment-switcher="" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', flexWrap: 'wrap' }}>
    <Menu open={open} portal side="bottom" selectedId={catalogue.current} onClose={() => { setOpen(false) }}
      onSelect={id => {
        setOpen(false)
        if (id === catalogue.current) return
        setBlocked(!openEnvironment(catalogue, id, href => { const page = window.open('about:blank', '_blank'); if (page !== null) { page.opener = null; page.location.replace(href) }; return page }))
      }}
      items={catalogue.entries.map(e => ({ id: e.id, label: e.label, disabled: e.id === catalogue.current,
        icon: e.kind === 'cloud' ? <IconGlobeOutline14 size={16} aria-hidden="true" /> : <IconFollowsystemOutline16 size={16} aria-hidden="true" /> }))}
      anchor={<button type="button" className={appearance?.trigger} aria-label={t('choose')} aria-haspopup="menu" aria-expanded={open}
        title={t('separate')} onClick={() => { setOpen(value => !value) }} style={appearance ? undefined : { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid currentColor', borderRadius: 8, padding: '5px 9px', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
        <Icon size={16} className={appearance?.icon} aria-hidden="true" /><span className={appearance?.label}>{current?.label}</span><IconChevronDownOutline14 size={12} className={appearance?.chevron} aria-hidden="true" />
      </button>} />
    {blocked && <span role="alert">{t('popupBlocked')}</span>}
  </span>
}
/** Header selector exists for real configured Gateways only. Local stays quiet. */
export function GatewayHeader({ t }: { t: Translate }) {
  const catalogue = useCatalogue()
  return catalogue === undefined ? null : <Picker catalogue={catalogue} t={t} />
}
export function GatewayHero({ t, ...owner }: RuntimeEnvironmentOwnerProps & { t: Translate }) {
  const catalogue = useCatalogue()
  return catalogue === undefined ? <EnvironmentPicker {...owner} t={t} /> : <Picker catalogue={catalogue} t={t} appearance={owner.appearance} />
}
/** No “takeover” or “synced” claim: v1 only provides real isolated connections. */
export function GatewayCloudStatus({ t, description }: GatewayProps & { t: Translate }) {
  const catalogue = useCatalogue()
  const connected = useSyncExternalStore(description.subscribe, description.getSnapshot, () => undefined) !== undefined
  const current = catalogue?.entries.find(e => e.id === catalogue.current)
  if (current?.kind !== 'cloud') return null
  return <div data-xh-cloud-status="" role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, padding: '7px 10px', border: '1px solid currentColor', borderRadius: 8, opacity: 0.8 }}>
    <IconGlobeOutline14 size={14} aria-hidden="true" /><strong>{current.label}</strong>
    <span>{connected ? t('connected') : t('disconnected')}</span>
    <span>{t('notSynced')}</span>
  </div>
}
