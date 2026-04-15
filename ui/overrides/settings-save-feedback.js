// One bounded notice; never display provider errors, preference values or HTML.
function xhSettingsSaveFeedback(namespace, failed) {
  if (typeof document === 'undefined') return;
  const id = 'xharness-settings-save-failure';
  let notice = document.getElementById(id);
  if (!failed) {
    if (notice?.dataset.namespace === namespace) notice.remove();
    return;
  }
  if (!document.body) return;
  const zh = (document.documentElement.lang || navigator.language || 'en').startsWith('zh');
  const messages = zh
    ? ['设置未保存，请检查连接后重试。', '关闭提示']
    : ['Settings were not saved. Check the connection and try again.', 'Dismiss notice'];
  if (!notice) {
    notice = document.createElement('div');
    notice.id = id;
    notice.setAttribute('role', 'alert');
    notice.setAttribute('aria-atomic', 'true');
    notice.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:1000;box-sizing:border-box;max-width:calc(100vw - 32px);width:max-content;display:flex;align-items:center;gap:16px;padding:12px 16px;border-radius:10px;background:#323232;color:#fff;font:14px/1.5 system-ui,sans-serif;box-shadow:0 4px 20px #0003;';
    const message = document.createElement('span');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.style.cssText = 'flex:none;border:1px solid #ffffff70;border-radius:6px;background:transparent;color:inherit;padding:4px 8px;font:inherit;cursor:pointer;';
    dismiss.addEventListener('click', () => notice.remove());
    notice.append(message, dismiss);
  }
  notice.dataset.namespace = namespace;
  notice.children[0].textContent = messages[0];
  notice.children[1].textContent = messages[1];
  // Keep the notice inside an active modal's layer, without moving user focus.
  const modal = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
    .filter(node => node.getClientRects().length > 0).at(-1);
  (modal || document.body).append(notice);
}
