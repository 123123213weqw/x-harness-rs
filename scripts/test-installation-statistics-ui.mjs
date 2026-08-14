import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(new URL('../ui/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const file = new URL('../ui/src/modules/experience/InstallationStatistics.tsx', import.meta.url)
const output = transformSync(readFileSync(file, 'utf8'), { loader: 'tsx', format: 'cjs' }).code
const module = { exports: {} }
vm.runInNewContext(output, { exports: module.exports, module, require: () => ({ createElement() {} }) })
const valid = { enabled: false, configured: true, pendingReports: 0, deletionPending: false, droppedEvents: 0, error: null }
const exports = module.exports
const decode = exports.decodeStatus
assert.equal(decode(valid).enabled, false)
assert.equal(decode({ ...valid, secret: 'PRIVATE_SENTINEL', installationId: 'private' }).secret, undefined)
for (const v of [null, [], {}, { ...valid, enabled: 'yes' }, { ...valid, pendingReports: 65 }, { ...valid, pendingReports: -1 }, { ...valid, pendingReports: 1.5 }, { ...valid, error: {} }, { ...valid, droppedEvents: Infinity }]) assert.throws(() => decode(v))
assert.match(exports.statisticsLabels.en.privacy, /Never conversations/)
assert.match(exports.statisticsLabels.zh.intro, /默认关闭/)
assert.match(exports.statisticsLabels.en.deletion, /Re-enabling requires deletion/)
console.log('Installation settings: bounded native DTOs, privacy/consent labels, no credential projection passed')
assert.equal(decode({ ...valid, noticeRequired: true }).noticeRequired, true)
assert.equal(decode(valid).noticeRequired, false) // older native builds never trigger first-run consent
assert.throws(() => decode({ ...valid, noticeRequired: 'yes' }))
const cardOutput = transformSync(readFileSync(new URL('../ui/src/modules/experience/InstallationConsent.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code
const cardModule = { exports: {} }
vm.runInNewContext(cardOutput, { exports: cardModule.exports, module: cardModule, require: name => name === './InstallationStatistics' ? exports : { createElement() {} } })
const { shouldOfferConsent, consentLabels } = cardModule.exports
assert.equal(shouldOfferConsent(decode({ ...valid, noticeRequired: true })), true)
for (const override of [{ enabled: true }, { configured: false }, { deletionPending: true }, { error: 'disk' }, { noticeRequired: false }]) assert.equal(shouldOfferConsent(decode({ ...valid, noticeRequired: true, ...override })), false)
assert.deepEqual(Object.keys(consentLabels.zh).sort(), Object.keys(consentLabels.en).sort())
assert.match(consentLabels.zh.later, /暂不开启/)
assert.match(consentLabels.en.agree, /Agree & enable/)
assert.equal(consentLabels.zh.intro, '分享可选统计，帮助改善体验。')
assert.equal(consentLabels.en.intro, 'Share optional statistics to improve your experience.')
assert.match(consentLabels.zh.detailsText, /随机安装 ID/)
assert.match(consentLabels.en.detailsText, /random installation ID/)
assert.match(consentLabels.en.privacy, /never collect conversations/)
assert.match(consentLabels.en.noticeText, /90 days/)
assert.equal(consentLabels.zh.details, '了解更多')
assert.equal(consentLabels.en.details, 'Learn more')
console.log('First-run consent: bilingual copy, native readiness, old-build and opt-out guards passed')

// Controller regressions without a browser/native bridge: deferred persistence,
// double-click suppression, old builds, save failure and late unmount replies.
function controllerFixture(invoke) {
  const cells = []; let cursor = 0; const effects = []; let cleanup; let completed = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useState(initial) { const id = cursor++; if (!(id in cells)) cells[id] = initial; return [cells[id], value => { cells[id] = value }] },
    useRef(initial) { const id = cursor++; if (!(id in cells)) cells[id] = { current: initial }; return cells[id] },
    useEffect(effect) { const id = cursor++; if (!(id in cells)) { cells[id] = true; effects.push(effect) } },
  }
  const m = { exports: {} }
  const sandbox = { exports: m.exports, module: m, window: invoke ? { __TAURI__: { core: { invoke } } } : {},
    require: name => name === 'react' ? react : name === './InstallationStatistics' ? exports : { Modal: 'Modal' } }
  vm.runInNewContext(cardOutput, sandbox)
  function render() { cursor = 0; const tree = m.exports.InstallationConsent({ t: key => consentLabels.en[key], complete: () => { completed++ } }); for (const effect of effects.splice(0)) cleanup = effect(); return tree }
  return { render, completed: () => completed, unmount: () => cleanup?.() }
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const nativeStatus = { ...valid, noticeRequired: true }
const save = defer(); let writes = 0
const fixture = controllerFixture((name, args) => { if (name === 'desktop_installation_status') return Promise.resolve(nativeStatus); writes++; assert.equal(args.enabled, false); return save.promise })
assert.equal(fixture.render().props.open, false)
await tick(); let tree = fixture.render(); assert.equal(tree.props.open, true)
tree.props.children[0].props.onChoose(false); tree.props.children[0].props.onChoose(false)
assert.equal(writes, 1); assert.equal(fixture.completed(), 0)
save.resolve({ ...valid, noticeRequired: false }); await tick()
assert.equal(fixture.render().props.open, false); assert.equal(fixture.completed(), 1)
const failed = controllerFixture(name => name === 'desktop_installation_status' ? Promise.resolve(nativeStatus) : Promise.reject(new Error('disk')))
failed.render(); await tick(); failed.render().props.children[0].props.onChoose(true); await tick()
assert.equal(failed.completed(), 0); assert.equal(failed.render().props.children[0].props.error, true)
const old = controllerFixture(() => Promise.resolve(valid)); old.render(); await tick(); assert.equal(old.completed(), 1)
const web = controllerFixture(undefined); web.render(); assert.equal(web.completed(), 1)
const late = defer(); const unloaded = controllerFixture(() => late.promise); unloaded.render(); unloaded.unmount(); late.resolve(nativeStatus); await tick()
assert.equal(unloaded.completed(), 0); assert.equal(unloaded.render().props.open, false)
console.log('Consent controller: persistence before completion, double-click, failure, legacy/Web and unmount passed')

// The deferred prototype must not become a startup prompt through this PR.
const experienceSource = readFileSync(new URL('../ui/src/modules/experience/index.tsx', import.meta.url), 'utf8')
assert.match(experienceSource, /id: 'installation-statistics'/)
assert.doesNotMatch(experienceSource, /InstallationConsent|xharness-installations.*settings\.onboarding/)
function settingsFixture(invoke) {
  const cells = []; let cursor = 0; const effects = []; let cleanup
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useState(initial) { const id = cursor++; if (!(id in cells)) cells[id] = initial; return [cells[id], value => { cells[id] = value }] },
    useRef(initial) { const id = cursor++; if (!(id in cells)) cells[id] = { current: initial }; return cells[id] },
    useEffect(effect) { const id = cursor++; if (!(id in cells)) { cells[id] = true; effects.push(effect) } },
  }
  const m = { exports: {} }
  vm.runInNewContext(output, { exports: m.exports, module: m, require: () => react,
    window: { __TAURI__: invoke ? { core: { invoke } } : undefined, setInterval: () => 1, clearInterval() {} } })
  function render() { cursor = 0; const tree = m.exports.InstallationStatistics({ t: key => key }); for (const effect of effects.splice(0)) cleanup = effect(); return tree }
  function button(tree) { if (Array.isArray(tree)) { for (const child of tree) { const found = button(child); if (found) return found } } else if (tree && typeof tree === 'object') { if (tree.type === 'button') return tree; return button(tree.props?.children) } }
  return { render, button, unmount: () => cleanup?.() }
}
let settingsWrites = 0
const settingsSave = defer()
const settings = settingsFixture(name => name === 'desktop_installation_status' ? Promise.resolve(valid) : (settingsWrites++, settingsSave.promise))
settings.render(); await tick()
const settingsButton = settings.button(settings.render())
assert.equal(settingsButton.props.disabled, false)
settingsButton.props.onClick(); settingsButton.props.onClick()
assert.equal(settingsWrites, 1)
settingsSave.resolve({ ...valid, enabled: true }); await tick()
assert.equal(settings.button(settings.render()).props.children[0], 'disable')
const ordinaryWeb = settingsFixture(undefined)
assert.equal(ordinaryWeb.button(ordinaryWeb.render()), undefined)
const notConfigured = settingsFixture(() => Promise.resolve({ ...valid, configured: false }))
notConfigured.render(); await tick(); assert.equal(notConfigured.button(notConfigured.render()).props.disabled, true)
const deletionPending = settingsFixture(() => Promise.resolve({ ...valid, deletionPending: true }))
deletionPending.render(); await tick(); assert.equal(deletionPending.button(deletionPending.render()).props.disabled, true)
console.log('Settings controller: no startup prompt, duplicate-click guard, native-only and readiness/deletion guards passed')
