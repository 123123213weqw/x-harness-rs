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
// Only the context form is product-owned; model/effort navigation stays upstream.
function XHarnessContextPane({ locked, directory, load, select, back, saved }) {
  const h = react.createElement;
  const state = react.useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
  const { current, model, maximum } = xhModelInfo(state);
  const currentTokens = current?.contextWindowTokens ?? maximum;
  const [draft, setDraft] = react.useState(String(currentTokens ?? ''));
  const [error, setError] = react.useState(null);
  const [saving, setSaving] = react.useState(false);
  const version = react.useRef(0);
  const busy = saving || state.status === 'loading' || state.status === 'selecting';
  const identity = JSON.stringify([current, maximum]);
  react.useEffect(() => {
    setDraft(String(currentTokens ?? '')); setError(null); setSaving(false);
  }, [identity]);
  react.useEffect(() => { ++version.current; }, [current?.provider, current?.model]);
  react.useEffect(() => () => { ++version.current; }, []);
  async function submit(event) {
    event.preventDefault();
    if (locked || busy || !maximum) return;
    let selection;
    try { selection = xhContextSelection(directory.getSnapshot(), draft); }
    catch (e) { setError(e.message); return; }
    const generation = version.current;
    setSaving(true); setError(null);
    try {
      const ok = await select(selection);
      if (generation !== version.current) return;
      if (!ok) throw new Error(directory.getSnapshot().error ?? '保存失败，请重试。');
      const actual = directory.getSnapshot().current;
      if (['provider', 'model', 'reasoningEffort', 'contextWindowTokens'].every(key => actual?.[key] === selection[key])) saved();
    } catch (e) {
      if (generation === version.current) setError(e.message ?? String(e));
    } finally {
      if (generation === version.current) setSaving(false);
    }
  }
  return h('form', { className: 'xh-context-form', onSubmit: submit }, [
    h('button', { key: 'back', type: 'button', onClick: back }, '← 返回模型设置'),
    h('h3', { key: 'title' }, '上下文容量'),
    h('p', { key: 'scope' }, '仅影响后续请求，不改变正在运行的请求。'),
    h('label', { key: 'label' }, ['Token 数量', h('input', { key: 'input', autoFocus: true, type: 'text', inputMode: 'numeric', 'aria-label': '上下文 Token 数量', value: draft, readOnly: busy, disabled: locked, onChange: e => { setDraft(e.target.value); setError(null); } })]),
    h('p', { key: 'limit' }, `当前模型有效上限：${maximum?.toLocaleString() ?? '未知'} tokens（${model?.contextWindowSource ?? '来源未标注'}）`),
    !maximum && h('p', { key: 'unknown' }, '当前模型未提供上限，暂时无法调整。'),
    (error || state.error) && h('p', { key: 'error', role: 'alert' }, error || state.error),
    state.status === 'error' && h('button', { key: 'retry', type: 'button', onClick: load }, '重新获取'),
    h('div', { key: 'actions', className: 'xh-context-actions' }, [
      h('button', { key: 'max', type: 'button', disabled: busy || locked || !maximum, onClick: () => { setDraft(String(maximum)); setError(null); } }, '填入上限'),
      h('button', { key: 'save', type: 'submit', disabled: busy || locked || !maximum }, saving ? '保存中…' : '保存'),
    ]),
  ]);
}
function XHarnessContextRow({ state, itemRef, open }) {
  const h = react.createElement, css = ModelSelect_module_css_default;
  const { current, maximum } = xhModelInfo(state);
  return h('button', {ref: itemRef, type: 'button', role: 'menuitem', className: css.cell, onClick: open},
    h('span', {className: css.cellLabel}, '上下文容量'),
    h('span', {className: css.cellValue}, xhTokenLabel(current?.contextWindowTokens ?? maximum)),
    h(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {className: css.cellChevron}));
}
function XHarnessModelSelect(props) {
  return react.createElement(react.Fragment, null,
    react.createElement('style', null, `.xh-context-form{box-sizing:border-box;width:300px;max-width:calc(100vw - 48px);padding:10px;font-size:13px;overflow:auto}.xh-context-form h3{font-size:14px;margin:12px 0 6px}.xh-context-form p{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:8px 0}.xh-context-form input{display:block;box-sizing:border-box;width:100%;padding:8px;margin-top:6px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#aaa);border-radius:6px}.xh-context-form button{padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#aaa);background:transparent;color:inherit;cursor:pointer}.xh-context-form button:disabled{opacity:.5;cursor:default}.xh-context-form [role=alert]{color:var(--dsw-alias-state-error-label,#c33)}.xh-context-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}`),
    react.createElement(ModelSelect, props));
}
