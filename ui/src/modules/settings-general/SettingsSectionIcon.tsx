import {
  IconAgentPresetOutline16, IconArchiveOutline20, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16, IconUserOutline16,
} from '@xharness/dsh-client-ui-primitives'

type Glyph = 'general' | 'models' | 'account' | 'usage' | 'archive' | 'display' | 'installation' | 'agent' | 'plugins'
function glyphFor(section: string): Glyph {
  switch (section) {
    case 'models': return 'models'
    case 'managed-account': return 'account'
    case 'profile': return 'usage'
    case 'archived-chats': return 'archive'
    case 'experience': return 'display'
    case 'installation-statistics': return 'installation'
    case 'agent-presets': return 'agent'
    case 'plugins': return 'plugins'
    default: return 'general'
  }
}
function GlyphImage({ kind }: { kind: Glyph }) {
  switch (kind) {
    case 'models': return <IconDataOutline16 size={16} />
    case 'account': return <IconUserOutline16 size={16} />
    case 'archive': return <IconArchiveOutline20 size={16} />
    case 'agent': return <IconAgentPresetOutline16 size={16} />
    case 'plugins': return <IconPersonalizationOutline16 size={16} />
    case 'usage': return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 13.5h12" />
        <rect x="3" y="8" width="2" height="5.5" rx=".5" />
        <rect x="7" y="2.5" width="2" height="11" rx=".5" />
        <rect x="11" y="5.5" width="2" height="8" rx=".5" />
      </svg>
    )
    case 'display': return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="2" width="13" height="9" rx="1.5" />
        <path d="M8 11v3M5.5 14h5M4 5h8M4 8h8" />
        <path d="M6 4v2M10 7v2" />
      </svg>
    )
    case 'installation': return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        <path d="m8 1.5 5.5 3.25v6.5L8 14.5l-5.5-3.25v-6.5L8 1.5Z" />
        <path d="m2.5 4.75 5.5 3.25 5.5-3.25M8 8v6.5M5.25 3.125l5.5 3.25v3" />
      </svg>
    )
    default: return <IconSettingsOutline16 size={16} />
  }
}

/** Shell-only, semantic navigation glyphs. Unrecognized extensions keep the gear fallback. */
export function SettingsSectionIcon({ section, className }: { section: string; className: string }) {
  const kind = glyphFor(section)
  return <span className={className} data-xh-settings-icon={kind} aria-hidden="true"><GlyphImage kind={kind} /></span>
}
