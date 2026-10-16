// Exercise the actual platform primitive without changing its public exports.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export async function acceptStateDot({page,implementation,engine,evidence,ui}) {
  // The isolated platform is stopped before the Theme plugin boots. Install
  // its real token sheet before the real product palette; no fixture colors.
  await page.addStyleTag({content:readFileSync(join(ui,'src/modules/theme/design-platform.css'),'utf8')})
  await page.addStyleTag({content:readFileSync(join(ui,'overrides/monochrome.css'),'utf8')})
  await page.addStyleTag({content:'#state-probe {padding:28px;display:grid;gap:18px;color:var(--dsw-alias-label-primary-bluish);background:var(--dsw-alias-bg-layer-1);font:400 16px/24px system-ui} #state-probe .state-row {display:flex;gap:8px;align-items:center} #state-probe .custom-size {display:flex;gap:8px;align-items:center}'})
  await page.evaluate(()=>{
    const R=staticModules.react,D=staticModules['react-dom'],P=staticModules['@xharness/dsh-client-ui-primitives']
    window.renderStateDots=(runningState='ongoing')=>D.flushSync(()=>mount.render(R.createElement('div',{id:'state-probe'},
      R.createElement('div',{className:'state-row','data-probe':'ongoing'},R.createElement(P.StateDot,{state:runningState,className:'caller-status-class'}),'How to'),
      ...['done','warning','error'].map(state=>R.createElement('div',{className:'state-row','data-probe':state,key:state},R.createElement(P.StateDot,{state}),state)),
      R.createElement('div',{className:'custom-size'},R.createElement(P.StateDot,{state:runningState,size:16}),R.createElement(P.StateDot,{state:runningState,size:24})))))
    renderStateDots()
  })
  const settled=[]
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>document.body.toggleAttribute('data-ds-dark-theme',theme==='dark'),theme)
    const states=await page.evaluate(()=>{
      const result={}
      for(const state of ['done','warning','error']) {
        const el=document.querySelector(`[data-probe="${state}"] > [data-state]`),box=el.getBoundingClientRect(),css=getComputedStyle(el)
        result[state]={size:[box.width,box.height],color:css.color,hidden:el.getAttribute('aria-hidden'),halo:getComputedStyle(el,'::before').opacity,core:getComputedStyle(el,'::after').inset}
      }
      return result
    })
    settled.push({theme,states})
    for(const state of Object.values(states)) {assert.deepEqual(state.size,[10,10]);assert.equal(state.hidden,'true');assert.equal(state.halo,'0.1')}
    const running=page.locator('[data-probe="ongoing"] > [data-state]')
    assert.equal(await running.getAttribute('aria-hidden'),'true')
    assert.match(await running.getAttribute('class'),/caller-status-class/)
    assert.deepEqual(await running.evaluate(el=>{const r=el.getBoundingClientRect();return [r.width,r.height]}),[10,10],'preserve every default row slot')
    assert.deepEqual(await page.locator('.custom-size > [data-state]').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return [r.width,r.height]})),[[16,16],[24,24]])
    if(implementation==='source') {
      assert.equal(await running.locator('path').count(),2)
      assert.equal(await running.locator('rect').count(),1)
      const state=await running.evaluate(el=>({color:getComputedStyle(el).color,primary:getComputedStyle(el.parentElement).color,names:el.getAnimations({subtree:true}).map(a=>a.animationName),durations:el.getAnimations({subtree:true}).map(a=>a.effect.getTiming().duration)}))
      assert.equal(state.color,state.primary,`${theme}: running state follows the actual neutral product token`)
      assert.notEqual(await page.locator('#state-probe').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','real theme surface must exist, including dark mode')
      const channels=state.color.match(/[\d.]+/g).slice(0,3)
      assert.equal(channels[0],channels[1]);assert.equal(channels[1],channels[2])
      assert.deepEqual(state.names.map(name=>name.replace(/^StateDot_/, '')).sort(),['xh-state-bracket-left','xh-state-bracket-right','xh-state-node-pulse'])
      assert.deepEqual(state.durations,[2600,2600,2600])
      const motion=await running.evaluate(el=>{
        const label=el.parentElement.getBoundingClientRect(),animations=el.getAnimations({subtree:true})
        for(const animation of animations){animation.pause();animation.currentTime=988}
        const pulse=getComputedStyle(el.querySelector('rect')).opacity
        const after=el.parentElement.getBoundingClientRect()
        return {pulse:Number(pulse),sameLayout:label.x===after.x&&label.y===after.y&&label.width===after.width&&label.height===after.height}
      })
      assert.ok(Math.abs(motion.pulse-.38)<.01,'center node visibly pulses, not the whole row')
      assert.equal(motion.sameLayout,true,'motion cannot move text or change row geometry')
      await page.screenshot({path:join(evidence,`state-dot-${engine}-${theme}.png`),fullPage:true})
      // Timeline scrubbing above explicitly takes ownership of CSS animations.
      // Remount before media emulation so this checks native lifecycle behavior,
      // not a JavaScript-paused animation retained by the test itself.
      await page.evaluate(()=>{renderStateDots('done');renderStateDots('ongoing')})
      assert.equal(await running.evaluate(el=>el.getAnimations({subtree:true}).length),3)
      await page.emulateMedia({reducedMotion:'reduce'})
      assert.deepEqual(await running.evaluate(el=>[...el.querySelectorAll('path,rect')].map(child=>({animation:getComputedStyle(child).animationName,transform:getComputedStyle(child).transform,opacity:getComputedStyle(child).opacity}))),Array.from({length:3},()=>({animation:'none',transform:'none',opacity:'1'})),'reduced motion stays fully visible and completely static')
      await page.waitForFunction(()=>document.querySelector('[data-probe="ongoing"] > [data-state]').getAnimations({subtree:true}).length===0)
      assert.equal(await running.evaluate(el=>el.getAnimations({subtree:true}).length),0)
      await page.emulateMedia({reducedMotion:'no-preference'})
    } else {
      assert.equal(await running.locator('rect').count(),8,'frozen positive control retains its original pixel chase')
    }
  }
  if(implementation==='source') {
    await page.evaluate(()=>renderStateDots('done'))
    assert.equal(await page.locator('[data-state="ongoing"]').count(),0,'completion removes every animated running mark')
    assert.equal(await page.locator('#state-probe').evaluate(el=>el.getAnimations({subtree:true}).length),0,'no leftover motion after completion')
  }
  writeFileSync(join(evidence,`state-dot-${engine}-${implementation}.json`),JSON.stringify({settled,unchangedSizing:true,reducedMotion:implementation==='source',cssMotionOnly:true},null,2)+'\n')
  return settled
}
