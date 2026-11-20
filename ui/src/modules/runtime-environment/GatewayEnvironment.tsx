import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Menu, IconChevronDownOutline14, IconFollowsystemOutline16, IconGlobeOutline14 } from '@xharness/dsh-client-ui-primitives'
import type { EnvironmentCatalogueClient, HostDescriptionSource } from '../client-connection/install'
import type { RuntimeEnvironmentOwnerProps } from '../conversation/contract/slots'
import { EnvironmentPicker } from './EnvironmentPicker'
import { openNewTaskEnvironment, parseCatalogue, type EnvironmentCatalogue } from './gateway'
import type { EnvironmentKey } from './locales'

type Translate = (key: EnvironmentKey) => string
interface CatalogueProps { catalogueClient: EnvironmentCatalogueClient | undefined }
interface GatewayProps extends CatalogueProps { description: HostDescriptionSource }
function useCatalogue(client: EnvironmentCatalogueClient | undefined): EnvironmentCatalogue | undefined {
  const [catalogue, setCatalogue] = useState<EnvironmentCatalogue>()
  useEffect(() => {
    if (client === undefined) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const raw = await client.read(controller.signal)
        const parsed = parseCatalogue(raw, location.origin)
        if (!controller.signal.aborted && parsed !== undefined) setCatalogue(previous => previous ?? parsed)
      } catch { /* Discovery is optional. Retain this page's immutable validated identity; live connectivity is owned by ConnectionController. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, 30_000)
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [client])
  return catalogue
}
export function GatewayCreationPicker({ catalogue, t, sessionId, appearance }: { catalogue: EnvironmentCatalogue; t: Translate; sessionId: RuntimeEnvironmentOwnerProps['sessionId']; appearance?: RuntimeEnvironmentOwnerProps['appearance'] }) {
  const [open, setOpen] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const eligible = useRef(sessionId === undefined)
  eligible.current = sessionId === undefined
  useEffect(() => {
    eligible.current = sessionId === undefined
    setOpen(false); setBlocked(false)
    return () => { eligible.current = false }
  }, [sessionId])
  const current = catalogue.entries.find(e => e.id === catalogue.current)
  const Icon = current?.kind === 'cloud' ? IconGlobeOutline14 : IconFollowsystemOutline16
  if (sessionId !== undefined) return <EnvironmentLabel catalogue={catalogue} t={t} />
  return <span data-xh-environment-create-picker="" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', flexWrap: 'wrap' }}>
    <Menu open={open} portal side="bottom" selectedId={catalogue.current} onClose={() => { setOpen(false) }}
      onSelect={id => {
        if (!eligible.current) return
        setOpen(false)
        if (id === catalogue.current) return
        setBlocked(!openNewTaskEnvironment(catalogue, eligible.current, id, href => { const page = window.open('about:blank', '_blank'); if (page !== null) { page.opener = null; page.location.replace(href) }; return page }))
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
function EnvironmentLabel({ catalogue, t }: { catalogue: EnvironmentCatalogue; t: Translate }) {
  const current = catalogue.entries.find(e => e.id === catalogue.current)
  if (current === undefined) return null
  const Icon = current.kind === 'cloud' ? IconGlobeOutline14 : IconFollowsystemOutline16
  return <span data-xh-environment-bound="" title={t('bound')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
    <Icon size={14} aria-hidden="true" /><span>{current.label}</span>
  </span>
}
/** Existing chats show their immutable environment, never a switch control. */
export function GatewayHeader({ t, catalogueClient }: CatalogueProps & { t: Translate }) {
  const catalogue = useCatalogue(catalogueClient)
  return catalogue === undefined ? null : <EnvironmentLabel catalogue={catalogue} t={t} />
}
export function GatewayHero({ t, catalogueClient, ...owner }: RuntimeEnvironmentOwnerProps & CatalogueProps & { t: Translate }) {
  const catalogue = useCatalogue(catalogueClient)
  return catalogue === undefined ? <EnvironmentPicker {...owner} t={t} /> : <GatewayCreationPicker catalogue={catalogue} t={t} sessionId={owner.sessionId} appearance={owner.appearance} />
}
/** No “takeover” or “synced” claim: v1 only provides real isolated connections. */
export function GatewayCloudStatus({ t, description, catalogueClient }: GatewayProps & { t: Translate }) {
  const catalogue = useCatalogue(catalogueClient)
  const connected = useSyncExternalStore(description.subscribe, description.getSnapshot, () => undefined) !== undefined
  const current = catalogue?.entries.find(e => e.id === catalogue.current)
  if (current?.kind !== 'cloud') return null
  return <div data-xh-cloud-status="" role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, padding: '7px 10px', border: '1px solid currentColor', borderRadius: 8, opacity: 0.8 }}>
    <IconGlobeOutline14 size={14} aria-hidden="true" /><strong>{current.label}</strong>
    <span>{connected ? t('connected') : t('disconnected')}</span>
    <span>{t('notSynced')}</span>
  </div>
}
