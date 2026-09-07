// Product-owned extension of the upstream ModelDirectory, not a second settings store.
// Inserted by scripts/patch-model-controls.mjs; all carriers use the same RPCs.
async function xhModelRequest(directory, generation, promise) {
  try { return await promise; }
  catch (error) {
    if (!directory.disposed && directory.generation === generation) directory.store.update(s => {
      s.status = 'error'; s.error = error.message ?? String(error);
    });
    throw error;
  }
}
function xhModelInfo(state) {
  const current = state.current;
  const model = state.groups.find(g => g.id === current?.provider)?.models.find(m => m.id === current?.model);
  const maximum = Number.isSafeInteger(model?.contextWindow) && model.contextWindow > 0 ? model.contextWindow : undefined;
  return { current, model, maximum, effort: current?.reasoningEffort ?? model?.reasoning?.defaultEffort };
}
function xhContextSelection(state, raw) {
  const { current, maximum } = xhModelInfo(state);
  if (!current || !maximum) throw new Error('当前模型未提供上下文上限，无法调整。');
  if (!/^\d+$/.test(raw.trim())) throw new Error('请输入正整数 Token 数量。');
  const tokens = Number(raw);
  if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > maximum) throw new Error(`请输入 1–${maximum.toLocaleString()} 之间的 Token 数量。`);
  return { ...current, contextWindowTokens: tokens };
}
function xhTokenLabel(value) {
  if (!Number.isSafeInteger(value) || value < 1) return '未知';
  return value % 1024 === 0 ? `${value / 1024}K` : value.toLocaleString();
}
function XHarnessModelControls({ locked, available, directory, load, select }) {
  const h = react.createElement;
  const state = react.useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
  const { current, model, maximum, effort } = xhModelInfo(state);
  const [pane, setPane] = react.useState(null);
  const [draft, setDraft] = react.useState('');
  const [error, setError] = react.useState(null);
  const [saving, setSaving] = react.useState(false);
  const root = react.useRef(null);
  const trigger = react.useRef(null);
  const version = react.useRef(0);
  const busy = saving || state.status === 'loading' || state.status === 'selecting';
  const disabled = locked || !available || !current || busy;
  const currentTokens = current?.contextWindowTokens ?? maximum;
  const effortName = model?.reasoning?.efforts?.find(e => e.id === effort)?.name ?? effort ?? '默认';
  const identity = JSON.stringify([current?.provider, current?.model, current?.reasoningEffort, current?.contextWindowTokens, maximum]);
  // A model switch, external selection or reconnect invalidates the old form and async callbacks.
  react.useEffect(() => {
    ++version.current;
    setPane(null); setError(null); setSaving(false); setDraft(String(currentTokens ?? ''));
  }, [identity]);
  react.useEffect(() => () => { ++version.current; }, []);
  react.useEffect(() => {
    if (!pane) return;
    const outside = e => { if (!root.current?.contains(e.target)) setPane(null); };
    const escape = e => { if (e.key === 'Escape') { setPane(null); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [pane]);
  function open(next, event) {
    trigger.current = event.currentTarget;
    setError(null); setDraft(String(currentTokens ?? ''));
    setPane(pane === next ? null : next);
    load(); // revalidate the provider catalog whenever the control opens
  }
  async function save(selection) {
    if (disabled) return;
    const generation = version.current;
    setSaving(true); setError(null);
    try {
      const ok = await select(selection);
      if (generation !== version.current) return;
      if (!ok) throw new Error(directory.getSnapshot().error ?? '保存失败，请重试。');
      setPane(null); trigger.current?.focus();
    } catch (e) {
      if (generation === version.current) setError(e.message ?? String(e));
    } finally {
      if (generation === version.current) setSaving(false);
    }
  }
  function submitContext(event) {
    event.preventDefault();
    try { const next = xhContextSelection(directory.getSnapshot(), draft); void save(next); }
    catch (e) { setError(e.message); }
  }
  const control = (name, text, unavailable, title) => h('button', {
    key: name, type: 'button', className: 'xhmodel-trigger', disabled: disabled || unavailable,
    'aria-expanded': pane === name, 'aria-haspopup': 'dialog', title,
    onClick: e => open(name, e),
  }, text);
  const efforts = model?.reasoning?.efforts ?? [];
  const panel = pane && h('div', { className: 'xhmodel-panel', role: 'dialog', 'aria-label': pane === 'context' ? '调整上下文容量' : '调整思考强度' }, [
    h('strong', { key: 'title' }, pane === 'context' ? '上下文容量' : '思考强度'),
    h('p', { key: 'scope' }, '保存到当前会话；正在运行的请求不改变，后续请求使用新设置。'),
    pane === 'context' ? h('form', { key: 'form', onSubmit: submitContext }, [
      h('label', { key: 'label' }, ['Token 数量', h('input', { key: 'input', autoFocus: true, type: 'text', inputMode: 'numeric', 'aria-label': '上下文 Token 数量', value: draft, disabled: busy, onChange: e => { setDraft(e.target.value); setError(null); } })]),
      h('p', { key: 'limit' }, `当前模型有效上限：${maximum?.toLocaleString() ?? '未知'} tokens（${model?.contextWindowSource ?? '来源未标注'}）`),
      h('div', { key: 'actions', className: 'xhmodel-actions' }, [
        h('button', { key: 'max', type: 'button', disabled: busy || !maximum, onClick: () => { setDraft(String(maximum)); setError(null); } }, '填入上限'),
        h('button', { key: 'save', type: 'submit', disabled: disabled || !maximum }, saving ? '保存中…' : '保存'),
      ]),
    ]) : h('div', { key: 'efforts', className: 'xhmodel-efforts' }, [
      ...(model?.reasoning?.defaultEffort === undefined ? [{ name: 'Provider 默认', id: undefined }] : []),
      ...efforts,
    ].map(level => h('button', { key: level.id ?? '__default', type: 'button', disabled, 'aria-pressed': effort === level.id, title: level.description, onClick: () => {
      const next = { ...directory.getSnapshot().current };
      if (level.id === undefined) delete next.reasoningEffort;
      else next.reasoningEffort = level.id;
      void save(next);
    } }, level.name))),
    (error || state.error) && h('p', { key: 'error', role: 'alert' }, error || state.error),
    state.status === 'error' && h('button', { key: 'retry', type: 'button', onClick: load }, '重新获取'),
    h('button', { key: 'close', className: 'xhmodel-close', type: 'button', onClick: () => { setPane(null); trigger.current?.focus(); } }, '关闭'),
  ]);
  return h('div', { ref: root, className: 'xhmodel-controls' }, [
    h('style', { key: 'style' }, `.xhmodel-controls{position:relative;display:flex;gap:3px;align-items:center;flex-wrap:wrap}.xhmodel-trigger{font:inherit;font-size:12px;white-space:nowrap;min-height:28px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);padding:3px 7px;cursor:pointer}.xhmodel-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.xhmodel-trigger:disabled{opacity:.5;cursor:default}.xhmodel-panel{position:absolute;bottom:calc(100% + 8px);right:0;z-index:50;width:310px;max-width:calc(100vw - 40px);max-height:min(430px,70vh);overflow:auto;box-sizing:border-box;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#222);box-shadow:var(--dsw-shadow-lv3);font-size:13px}.xhmodel-panel p{font-size:12px;line-height:1.5;overflow-wrap:anywhere;margin:8px 0;color:var(--dsw-alias-label-secondary)}.xhmodel-panel input{display:block;box-sizing:border-box;width:100%;padding:8px;margin-top:6px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#aaa);border-radius:6px}.xhmodel-panel button{padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#aaa);background:transparent;color:inherit;cursor:pointer}.xhmodel-panel button:disabled{opacity:.5;cursor:default}.xhmodel-panel [role=alert]{color:var(--dsw-alias-state-error-label,#c33)}.xhmodel-actions,.xhmodel-efforts{display:flex;gap:8px;flex-wrap:wrap}.xhmodel-panel [aria-pressed=true]{border-color:#2675ee;background:#2675ee22}.xhmodel-close{margin-top:12px}.xhmodel-seat{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:3px;min-width:0;max-width:100%}`),
    control('effort', `思考：${efforts.length ? effortName : '未声明'}`, efforts.length === 0, efforts.length ? '选择此模型声明的思考档位' : 'Provider 没有声明此模型的思考档位'),
    control('context', `上下文：${xhTokenLabel(currentTokens)}`, !maximum, maximum ? '调整当前会话的上下文容量' : 'Provider 未提供上下文上限，无法调整'),
    panel,
  ]);
}
function XHarnessModelSelect(props) {
  return react.createElement('div', { className: 'xhmodel-seat' },
    react.createElement(ModelSelect, props), react.createElement(XHarnessModelControls, props));
}
