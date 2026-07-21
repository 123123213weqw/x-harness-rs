/** Composer submission vocabulary shared by the input and settings domains. */

import type { BusyEnterBehavior } from '../submission-settings'

export type { BusyEnterBehavior } from '../submission-settings'

/** Delivery mode requested for one ordinary composer message. */
export type InputSubmitMode = BusyEnterBehavior

/** Keyboard gesture whose delivery mode the submission policy resolves. */
export type ComposerSubmitGesture = 'enter' | 'accelerated'
