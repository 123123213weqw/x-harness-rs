/** Acceptance only: expose actual emitted unit exports, not a rewritten UI. */
import assert from 'node:assert/strict'
import {compileSourceModules} from '../build-source-modules.mjs'
export function remoteSettingsModule() {
 const id='@xharness/dsh-client-ui-settings-remote-control'
 const row={id,source:'src/modules/settings-remote-control/index.ts'}
 const source=compileSourceModules(new URL('../../ui/',import.meta.url).pathname,[row]).get(id).bytes.toString()
 const marker='return __load("src/modules/settings-remote-control/index.js");'
 assert.ok(source.includes(marker))
 return source.replace(marker,'return Object.assign({},__load("src/modules/settings-remote-control/index.js"),__load("src/modules/settings-remote-control/api.js"),__load("src/modules/settings-remote-control/RemoteSettings.js"),__load("src/modules/settings-remote-control/locales.js"));')
}
