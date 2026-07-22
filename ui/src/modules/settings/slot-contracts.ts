/**
 * Settings slot contract — the canonical home of every settings slot type,
 * owned by the settings domain base rather than by the shell that renders
 * them (ui-settings-general, which occupies `sidebar.settings`). The shell has
 * zero copy of its own: ALL text (trigger label, panel title, header actions,
 * close aria, section content) arrives from registrants. A feature owns its
 * own settings pages — adding a setting never means editing the shell; copy
 * that belongs to no single feature (chrome, the General section) is owned by
 * ui-settings-general too.
 */


/** Owner share of a General preference row (the section supplies nothing). */
export interface SettingsGeneralItemOwnerProps {
  /** Marker field: item owner props are intentionally empty. */
  children?: never
}

/** Owner share of a Plugins tab (the section supplies nothing). */
export interface SettingsPluginsTabOwnerProps {
  /** Marker field: tab owner props are intentionally empty. */
  children?: never
}

/** Owner share of the trigger content seat: the sidebar column state. */
export interface SettingsTriggerOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail, icon only). */
  wide: boolean
}

/** Owner share of the header title seat (the shell supplies nothing). */
export interface SettingsHeaderOwnerProps {
  /** Marker field: header owner props are intentionally empty. */
  children?: never
}

/**
 * Owner share of a settings section entry. The shell owns modal visibility
 * and navigation; a section's data arrives through its own inject faces and
 * stores. `close` is the one shell affordance a section receives, for flows
 * that leave settings altogether (starting a session from a section) — the
 * onboarding coordinator's `openSection`/`complete` precedent, inverted.
 */
export interface SettingsSectionOwnerProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
}

/** Owner share of the currently active settings-backed onboarding step. */
export interface SettingsOnboardingOwnerProps {
  /** Stable id of the step currently selected by the coordinator. */
  stepId: string
  /** Complete or skip this step and transfer ownership to the next entry. */
  complete: () => void
  /** Open the settings panel directly on one registered section. */
  openSection: (id: string) => void
}
