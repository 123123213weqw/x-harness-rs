// Reviewed registry, independent of the candidate manifest. Optional features
// are required whenever their owned source is shipped; arbitrary modules and
// missing registrations still fail. The frozen parity baseline stays immutable.
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
const optional = new Set(["@xlang/xharness-client-ui-memory", "@xlang/xharness-client-ui-session-import"])
const rows = [
  {
    "id": "@xharness/dsh-client-ui-settings-remote-control",
    "kind": "source-module",
    "source": "src/modules/settings-remote-control/index.ts",
    "inject": ["@xharness/dsh-client-runtime", "@xharness/dsh-client-ui-settings", "@xharness/dsh-client-locale", "@xharness/dsh-client-connection"]
  },
  {
    "id": "@xlang/xharness-client-ui-runtime",
    "kind": "source-module",
    "source": "src/modules/runtime-environment/index.ts",
    "inject": [
      "@xharness/dsh-client-ui-conversation",
      "@xharness/dsh-client-locale"
    ]
  },
  {
    "id": "@xlang/xharness-client-ui-performance",
    "kind": "source-module",
    "source": "src/modules/performance/index.ts",
    "inject": [
      "@xharness/dsh-client-ui-conversation",
      "@xharness/dsh-client-runtime",
      "@xharness/dsh-client-locale"
    ]
  },
  {
    "id": "@xlang/xharness-client-ui-memory",
    "kind": "source-module",
    "source": "src/modules/memory/index.tsx",
    "inject": [
      "@xharness/dsh-client-runtime",
      "@xharness/dsh-client-locale",
      "@xharness/dsh-client-ui-settings-general"
    ]
  },
  {
    "id": "@xlang/xharness-client-plugin-api",
    "kind": "plugin-api-ts",
    "source": "src/plugin-api/client.ts",
    "inject": []
  },
  {
    "id": "@xlang/xharness-client-ui-assistant",
    "kind": "source-module",
    "source": "src/modules/assistant/index.tsx",
    "inject": [
      "@xharness/dsh-client-runtime",
      "@xharness/dsh-client-ui-primitives",
      "@xharness/dsh-client-ui-layout",
      "@xharness/dsh-client-ui-sidebar",
      "@xharness/dsh-client-ui-conversation"
    ]
  },
  {
    "id": "@xlang/xharness-client-ui-code-review",
    "kind": "source-module",
    "source": "src/modules/code-review/index.tsx",
    "inject": [
      "@xharness/dsh-client-ui-layout",
      "@xharness/dsh-client-ui-sidebar",
      "@xharness/dsh-client-locale",
      "@xharness/dsh-client-connection",
      "@xharness/dsh-client-runtime",
      "@xlang/xharness-client-ui-assistant"
    ]
  },
  {
    "id": "@xlang/xharness-client-ui-session-import",
    "kind": "source-module",
    "source": "src/modules/session-import/index.ts",
    "inject": [
      "@xharness/dsh-client-ui-settings-general",
      "@xharness/dsh-client-runtime",
      "@xharness/dsh-client-connection",
      "@xharness/dsh-client-locale"
    ]
  },
  {
    "id": "@xlang/xharness-client-ui-swarm",
    "kind": "source-module",
    "source": "src/modules/swarm/index.tsx",
    "inject": [
      "@xharness/dsh-client-ui-layout",
      "@xharness/dsh-client-ui-primitives",
      "@xharness/dsh-client-runtime",
      "@xharness/dsh-client-connection",
      "@xharness/dsh-client-ui-commands"
    ]
  }
]
export function reviewedUiAdditions() {
  return rows.filter(row => !optional.has(row.id) || existsSync(resolve('ui', row.source)))
}
