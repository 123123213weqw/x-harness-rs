(() => {
  const invoke = window.__TAURI__?.core?.invoke
  const $ = id => document.getElementById(id)
  let busy = false
  function render(state) {
    $('status').textContent = `版本 ${state.version} · ${state.platform} · ${state.hostRunning ? '后台运行中' : '后台未运行'}`
    $('incident').hidden = !state.previousAbnormalExit
    $('dump-status').textContent = state.crashDumpAvailable ? '已留存崩溃转储；默认导出不会包含它。' : '暂无成功保存的崩溃转储。'
    $('full-memory').disabled = state.platform !== 'windows' || state.deepRemainingSeconds > 0
    $('heap-check').disabled = state.platform !== 'windows' || state.deepRemainingSeconds > 0
    $('deep-status').textContent = state.deepRemainingSeconds > 0 ? `已开启 · 剩余 ${Math.ceil(state.deepRemainingSeconds / 60)} 分钟` : '已关闭；退出应用后不会继续开启。'
    $('enable').disabled = busy || state.deepRemainingSeconds > 0
    $('disable').disabled = busy || state.deepRemainingSeconds === 0
    if (!state.available || state.storageError) {
      $('output').textContent = '部分诊断记录保存失败或目录不可用，不能保证完整。请检查磁盘空间和目录权限。'
      $('output').classList.add('error')
    }
  }
  async function refresh() { render(await invoke('desktop_diagnostics_status')) }
  async function run(action) {
    if (busy) return
    busy = true
    for (const id of ['export', 'acknowledge', 'enable', 'disable']) $(id).disabled = true
    try { await action() } catch {
      $('output').textContent = '操作失败，未确认保存或启用成功。请重试；原始对话不会被修改。'
      $('output').classList.add('error')
    } finally {
      busy = false
      $('export').disabled = false; $('acknowledge').disabled = false
      await refresh().catch(() => { $('status').textContent = '无法读取桌面诊断状态。' })
    }
  }
  $('export').addEventListener('click', () => run(async () => {
    const path = await invoke('desktop_export_diagnostics')
    $('output').classList.remove('error')
    $('output').textContent = '诊断包已保存到：\n' + path + '\n仅保存在本机，没有上传。'
  }))
  $('acknowledge').addEventListener('click', () => run(() => invoke('desktop_diagnostics_acknowledge')))
  $('enable').addEventListener('click', () => run(async () => {
    if (!$('consent').checked) { $('output').textContent = '请先阅读并勾选深度诊断提示。'; return }
    await invoke('desktop_set_deep_diagnostics', { enabled: true, consent: true, fullMemory: $('full-memory').checked, heapCheck: $('heap-check').checked })
    $('output').textContent = '深度诊断已开启，15 分钟后自动关闭。'
  }))
  $('disable').addEventListener('click', () => run(async () => {
    await invoke('desktop_set_deep_diagnostics', { enabled: false, consent: false, fullMemory: false, heapCheck: false })
    $('output').textContent = '深度诊断已关闭。'
  }))
  refresh().catch(() => { $('status').textContent = '诊断入口仅在 XHarness 桌面客户端内可用。' })
  setInterval(() => { if (!busy) refresh().catch(() => {}) }, 5000)
})()
