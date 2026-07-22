import assert from 'node:assert/strict'
import { ownedViewModuleTestInput } from '../owned-view-module-test-input.mjs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

export function loadPluginApi() {
  let api
  const window = { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, '@xlang/xharness-client-plugin-api')
    api = factory(() => { throw Error('plugin API must have no runtime dependencies') })
  } } }
  const previous = process.env.UI_TEST_IMPL
  process.env.UI_TEST_IMPL = 'source'
  try {runInNewContext(ownedViewModuleTestInput('@xlang/xharness-client-plugin-api'), { window, Error })}
  finally {if(previous === undefined)delete process.env.UI_TEST_IMPL;else process.env.UI_TEST_IMPL=previous}
  assert.ok(api?.createPluginClient)
  return api
}

export const copy = value => JSON.parse(JSON.stringify(value))
