import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
const css=readFileSync(new URL('../ui/overrides/logo-motion.css',import.meta.url),'utf8')
const js=readFileSync(new URL('../ui/overrides/logo-motion.js',import.meta.url),'utf8')
assert.match(css,/var\(--xh-duration-logo-cycle, 5s\) var\(--xh-ease-in-out, ease-in-out\) infinite/)
assert.match(css,/prefers-reduced-motion: reduce/)
assert.match(css,/animation: none/)
assert.doesNotMatch(css,/display: none/, 'reduced motion must not hide the brand mark')
assert.match(css,/animation-play-state: paused/)
assert.match(css,/xh-sidebar-mark-out/)
assert.match(css,/xh-sidebar-name-in/)
assert.match(css,/--xh-duration-panel-in/)
assert.match(css,/\.U910La_root \.U910La_brandIdentity \{ gap: 0; \}/)
assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(js))
const attrs=new Set();let listener
const document={hidden:false,documentElement:{toggleAttribute:(k,v)=>v?attrs.add(k):attrs.delete(k)},addEventListener:(name,fn)=>{assert.equal(name,'visibilitychange');listener=fn}}
vm.runInNewContext(js,{document})
assert.equal(attrs.size,0)
document.hidden=true;listener();assert.ok(attrs.has('data-xh-page-hidden'))
document.hidden=false;listener();assert.equal(attrs.size,0)
for(const ext of ['css','js'])assert.equal(readFileSync(new URL(`../ui/dist/logo-motion.${ext}`,import.meta.url),'utf8'),readFileSync(new URL(`../ui/overrides/logo-motion.${ext}`,import.meta.url),'utf8'))
console.log('PASS: 5s mark highlight, reduced motion, hidden/resume lifecycle, source/bundle parity, no frame loop')
