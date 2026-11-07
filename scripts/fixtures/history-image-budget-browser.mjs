// Actual attachment components; synthetic derivatives/bytes, never user chats.
import assert from 'node:assert/strict'
import {syntheticPng} from './ui-memory-policies.mjs'

export async function acceptHistoryImageBudget(page) {
  const thumbnail = 'data:image/png;base64,' + syntheticPng(480, 300).toString('base64')
  const original = 'data:image/png;base64,' + syntheticPng(3200, 2000).toString('base64')
  await page.evaluate(({thumbnail, original}) => {
    window.testLoads = []; window.failThumbnail = false; window.holdOriginal = false
    const t = (key, values) => ({'image.label':'Image','image.openOriginal':'Open original','image.openOriginalLabel':'Open '+values?.label,'image.loading':'Loading image','image.loadFailed':'Image failed, retry','image.preview':'Image preview','image.closePreview':'Close preview','image.budgetExceeded':'Image memory budget reached. Close other previews, then retry.'}[key] ?? key)
    window.testLoad = async (ref, small) => {
      testLoads.push({id:ref.attachmentId, small:small===true})
      if (small && failThumbnail) throw Error('old Host / unsupported thumbnail')
      if (!small && holdOriginal) await new Promise(resolve => window.finishOriginal = resolve)
      return small ? thumbnail : original
    }
    window.testImages = (count, huge=false) => {
      root.render(React.createElement(React.StrictMode, {}, React.createElement(slots['conversation.message.images'], {
        images:Array.from({length:count}, (_, index) => ({attachment:{attachmentId:'memory-'+index,name:'memory-'+index,bytes:123,width:huge?4096:3200,height:huge?4096:2000}})),
        loadImage:testLoad, align:'start', t,
      })))
    }
    testImages(40)
  }, {thumbnail, original})
  await page.waitForFunction(() => document.querySelectorAll('#root img').length === 40 && [...document.querySelectorAll('#root img')].every(image => image.complete && image.naturalWidth === 480 && image.naturalHeight === 300))
  assert.equal(await page.evaluate(() => testLoads.filter(row => !row.small).length), 0, 'gallery must not request originals')
  await page.getByRole('button', {name:'Open memory-0', exact:true}).click()
  await page.waitForFunction(() => document.querySelector('[role=dialog] img')?.naturalWidth === 3200)
  assert.equal(await page.evaluate(() => testLoads.filter(row => !row.small).length), 1)
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'})

  // Filling the thumbnail sub-limit cannot starve a user-triggered original.
  await page.evaluate(() => testImages(0)); await page.waitForFunction(() => document.querySelectorAll('#root img').length === 0)
  await page.evaluate(() => {testLoads=[]; testImages(60)})
  await page.waitForFunction(() => document.querySelectorAll('#root img').length === 54)
  assert.equal(await page.getByRole('button', {name:'Image memory budget reached. Close other previews, then retry.',exact:true}).count(),6)
  await page.getByRole('button', {name:'Open memory-59',exact:true}).click()
  await page.getByRole('dialog').getByRole('img').waitFor()
  assert.equal(await page.evaluate(() => testLoads.filter(row=>!row.small).length),1,'refused thumbnail still has room for explicit original')
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'})

  // Drop all old thumbnail leases before the new scope. StrictMode replay must
  // not steal the next real mount's reservation or start twice the work.
  await page.evaluate(() => testImages(0)); await page.waitForFunction(() => document.querySelectorAll('#root img').length === 0)
  await page.evaluate(() => {testLoads=[]; testImages(2, true)})
  await page.waitForFunction(() => document.querySelectorAll('#root img').length === 2)
  await page.getByRole('button', {name:'Open memory-0', exact:true}).click()
  await page.getByRole('dialog').getByRole('img').waitFor()
  // Open the second from the fixture, not by clicking through a modal mask.
  await page.evaluate(() => document.querySelector('button[aria-label="Open memory-1"]').click())
  await page.getByRole('alert').filter({hasText:'Image memory budget reached.'}).waitFor()
  assert.equal(await page.evaluate(() => testLoads.filter(row => !row.small).length), 1, 'deny BEFORE loading another 64 MiB original')
  const dialogs = page.getByRole('dialog')
  await dialogs.nth(1).getByRole('button', {name:'Close preview'}).click()
  await page.getByRole('dialog').getByRole('button', {name:'Close preview'}).click()
  await page.getByRole('button', {name:'Open memory-1', exact:true}).click()
  await page.getByRole('dialog').getByRole('img').waitFor()
  assert.equal(await page.evaluate(() => testLoads.filter(row => !row.small).length), 2, 'closed original returns its lease exactly once')
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'})

  // Old Host/unsupported format: never silently decode the full source in a
  // tile, but keep a user-triggered original and retry path.
  await page.evaluate(() => testImages(0)); await page.waitForFunction(() => document.querySelectorAll('#root img').length === 0)
  await page.evaluate(() => {testLoads=[]; failThumbnail=true; testImages(1)})
  await page.getByRole('button', {name:'Image failed, retry', exact:true}).waitFor()
  assert.equal(await page.evaluate(() => testLoads.filter(row => !row.small).length), 0)
  await page.evaluate(() => {holdOriginal=true})
  await page.getByRole('button', {name:'Open memory-0', exact:true}).click()
  await page.getByRole('dialog').getByRole('status').waitFor()
  await page.waitForFunction(() => typeof finishOriginal === 'function')
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'})
  await page.evaluate(() => {holdOriginal=false; finishOriginal()})
  await page.waitForTimeout(50)
  assert.equal(await page.getByRole('dialog').count(), 0, 'late original cannot reopen a closed dialog')
  await page.getByRole('button', {name:'Open memory-0', exact:true}).click()
  await page.getByRole('dialog').getByRole('img').waitFor()
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'})
  await page.evaluate(() => testImages(0))
}
