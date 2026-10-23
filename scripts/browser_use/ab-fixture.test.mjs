#!/usr/bin/env node
// Runner-only contract test. Expected IDs never enter a paid-model prompt.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AB_TASKS, startAbFixture, verifyAbFixtureContracts } from './ab-fixture.mjs';

if (process.env.XHARNESS_BROWSER_TEST_SERVER !== '1') throw new Error('Run only on isolated V100 with XHARNESS_BROWSER_TEST_SERVER=1');
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(root, 'plugins/browser-use/package.json'));
const { chromium } = require('playwright');
const fixture = await startAbFixture();
const browser = await chromium.launch({ headless: true });
const results = [];
let failures = 0;
async function until(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(await predicate(), 'Server-owned state did not reach expected state');
}
async function action(page, callback) {
  const pending = page.waitForResponse(response => response.url().endsWith('/action') && response.request().method() === 'POST');
  await callback(); const response = await pending; assert.equal(response.status(), 200); const body = await response.json();
  // Synchronization only; correctness is always fixture.score(), never this JS state.
  await page.waitForFunction(expected => JSON.stringify(state) === expected, JSON.stringify(body.state));
  return body;
}
async function choose(page, type, id) { return action(page, () => page.locator(`[data-action="${type}"][data-id="${id}"]`).click()); }
async function open(task, arm = 'native-a', seed = `ab-native-${task.id}`) {
  const run = fixture.createRun({ taskId: task.id, arm, seed });
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage(); await page.goto(run.url);
  assert.equal(fixture.score(run.runId).success, false, 'Opening a page or claiming completion cannot pass');
  return { run, context, page, expected: fixture.evidence(run.runId).expected };
}
console.log('TAP version 13');
try {
  const synthetic = await verifyAbFixtureContracts(); assert.equal(synthetic.passed, true);
  for (const task of AB_TASKS) {
    let a, b;
    try {
      a = await open(task); b = await open(task, 'native-b');
      assert.equal(a.run.scenarioHash, b.run.scenarioHash); assert.equal(a.run.goal, b.run.goal); assert.notEqual(a.run.runId, b.run.runId);
      const { page, run, expected } = a;
      // A synthetic DOM click and an untrusted raw POST must not mutate task state.
      if (task.id === 'duplicate-controls') {
        await action(page, () => page.locator(`[data-action="mark"][data-id="${expected.correct}"]`).evaluate(element => element.click()));
        assert.equal(fixture.score(run.runId).success, false); assert.deepEqual(fixture.evidence(run.runId).state.marked, []);
        assert.equal(fixture.evidence(run.runId).events.at(-1).accepted, false);
        const response = await fetch(run.url + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'mark', id: expected.correct, trusted: false }) });
        assert.equal(response.status, 200); assert.deepEqual(fixture.evidence(run.runId).state.marked, []);
      }
      if (task.id === 'catalogue') {
        const budget = run.goal.match(/不超过 ([0-9]+) 元/)[1];
        await page.getByLabel('搜索商品', { exact: true }).fill('TravelBook');
        await page.getByLabel('最高价格', { exact: true }).fill(budget);
        await page.getByLabel('最大重量kg', { exact: true }).fill('1.5');
        await page.getByLabel('最少续航小时', { exact: true }).fill('10');
        await page.getByLabel('最低评分', { exact: true }).fill('4.5');
        await page.getByLabel('排序', { exact: true }).selectOption('price-asc');
        await action(page, () => page.getByRole('button', { name: '应用条件', exact: true }).click());
        assert.equal(fixture.score(run.runId).success, false, 'Correct filter alone is incomplete');
        for (const id of expected.eligible) await choose(page, 'compare', id);
        await choose(page, 'select', expected.correct);
        assert.equal(fixture.score(run.runId).success, true);
        await page.getByLabel('搜索商品', { exact: true }).fill('');
        await action(page, () => page.getByRole('button', { name: '应用条件', exact: true }).click());
        assert.equal(fixture.score(run.runId).success, false, 'Extra DeskStation in wrong filter must fail');
        await page.getByLabel('搜索商品', { exact: true }).fill('TravelBook');
        await action(page, () => page.getByRole('button', { name: '应用条件', exact: true }).click());
        const extra = await open(task, 'incorrect-compare', 'incorrect-comparison');
        try {
          const wrong = await extra.page.locator('[data-action="compare"]').evaluateAll((elements, eligible) => elements.find(element => !eligible.includes(element.dataset.id)).dataset.id, extra.expected.eligible);
          await choose(extra.page, 'compare', wrong);
          assert.equal(fixture.score(extra.run.runId).criteria.comparedCorrectPair, false, 'Wrong comparison cannot be scored correct');
        } finally { await extra.context.close(); }
      } else if (task.id === 'duplicate-controls') {
        await choose(page, 'mark', expected.correct);
        const wrong = await open(task, 'incorrect-card', 'wrong-card');
        try {
          const wrongId = await wrong.page.locator('[data-action="mark"]').evaluateAll((elements, correct) => elements.find(element => element.dataset.id !== correct).dataset.id, wrong.expected.correct);
          await choose(wrong.page, 'mark', wrongId); await choose(wrong.page, 'mark', wrong.expected.correct);
          assert.equal(fixture.score(wrong.run.runId).success, false, 'Changing another card is irreversible evidence');
        } finally { await wrong.context.close(); }
      } else if (task.id === 'scroll-record') {
        const target = page.locator(`[data-review="${expected.correct}"]`);
        const initial = await target.boundingBox(); assert.ok(initial && initial.y > 760, 'Target must begin below viewport');
        await action(page, () => target.check());
        const after = await target.boundingBox(); assert.ok(after && after.y < 760, 'Native checkbox action must scroll into view');
      } else if (task.id === 'modal-rules') {
        await action(page, () => page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click());
        await choose(page, 'details', expected.correct);
        await page.getByRole('dialog').getByText(/支持目的地/).waitFor();
        await action(page, () => page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click());
        await choose(page, 'select', expected.correct);
      } else if (task.id === 'slow-stock') {
        await page.getByText('真实库存已更新', { exact: true }).waitFor({ timeout: 5000 });
        await choose(page, 'select', expected.correct);
        assert.equal(fixture.evidence(run.runId).state.availabilityServed, true);
      } else if (task.id === 'report-navigation') {
        await page.locator(`a[href$="/report/${expected.correct}"]`).click();
        await page.waitForURL(run.url + '/report/' + expected.correct);
        await page.getByLabel('收藏格式', { exact: true }).selectOption('CSV');
        await choose(page, 'favourite', expected.correct);
        assert.ok(fixture.evidence(run.runId).events.some(event => event.kind === 'navigation' && event.page === `report:${expected.correct}`));
      } else if (task.id === 'layout-change') {
        const before = await page.locator('[data-action="pin"]').evaluateAll(elements => elements.map(element => element.dataset.id));
        await page.getByLabel('视图排序', { exact: true }).selectOption('name');
        await action(page, () => page.getByRole('button', { name: '应用排序', exact: true }).click());
        const after = await page.locator('[data-action="pin"]').evaluateAll(elements => elements.map(element => element.dataset.id));
        assert.notDeepEqual(before, after, 'Sort must really replace/rearrange controls'); await choose(page, 'pin', expected.correct);
      } else if (task.id === 'draft-correction') {
        await page.getByLabel('草稿名称', { exact: true }).fill(run.goal.match(/名为“([^”]+)”/)[1]);
        await page.getByLabel('目标区域', { exact: true }).selectOption(run.goal.match(/目标区域为“([^”]+)”/)[1]);
        const rejected = await action(page, () => page.getByRole('button', { name: '校验兼容性', exact: true }).click());
        assert.equal(fixture.score(run.runId).success, false);
        const version = rejected.state.message.match(/模板版本 ([0-9]+\.[0-9]+)/)[1];
        await page.getByLabel('模板版本', { exact: true }).selectOption(version);
        const noValidation = await action(page, () => page.getByRole('button', { name: '保存草稿', exact: true }).click());
        assert.equal(noValidation.state.saved, false, 'Saving cannot skip the explicit validation step');
        await action(page, () => page.getByRole('button', { name: '校验兼容性', exact: true }).click());
        assert.equal(fixture.score(run.runId).success, false, 'Validation without saving is incomplete');
        await action(page, () => page.getByRole('button', { name: '保存草稿', exact: true }).click());
      }
      await until(() => fixture.score(run.runId).success);
      assert.equal(fixture.score(b.run.runId).success, false, 'Arm A must not change arm B');
      const accepted = fixture.evidence(run.runId).events.filter(event => event.kind === 'action' && event.accepted);
      assert.ok(accepted.length > 0); assert.ok(accepted.every(event => event.action.trusted === true));
      results.push({ taskId: task.id, status: 'passed', criteria: fixture.score(run.runId).criteria, nativeAcceptedActions: accepted.length });
      console.log(`ok ${results.length} - ${task.id}`);
    } catch (error) {
      failures++; results.push({ taskId: task.id, status: 'failed', error: error.stack ?? String(error) });
      console.log(`not ok ${results.length} - ${task.id}\n  ${JSON.stringify(error.stack ?? String(error))}`);
    } finally { await a?.context.close(); await b?.context.close(); }
  }
  console.log(JSON.stringify({ passed: failures === 0, total: results.length, failures, cases: results, boundary: 'Native Chromium fixture reachability, not LLM quality or Host e2e. trusted is a client flag, not cryptographic authentication: paid-model broker must prohibit eval, raw HTTP and shell.' }, null, 2));
  process.exitCode = failures ? 1 : 0;
} finally { await browser.close(); await fixture.close(); }
