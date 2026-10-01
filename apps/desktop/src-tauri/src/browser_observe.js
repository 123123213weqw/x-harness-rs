// Fixed DOM inspection/action function. No IPC, fetch, caller JS or privileged
// bridge is installed. The bounded page-local frame contains DOM references,
// not Host capabilities; it is untrusted and never an authorization boundary.
(function observeBrowser(args) {
  const slot = Symbol.for("xharness.browser.dom-frame");
  const visible = element => element.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
  // DOM .click()/value setters bypass the browser's modal input barrier. Treat
  // background controls as blocked on BOTH observation and action, including
  // when a dialog opens between the two. Non-modal/hidden dialogs do not block.
  const nativeModal = element => {
    try { return element.matches(":modal") || element.getAttribute("aria-modal") === "true"; }
    catch (_) { return true; } // Older WebViews: conservatively block an open dialog, not the entire observation.
  };
  const modals = Array.from(document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]')).filter(element => visible(element) && (element.tagName !== "DIALOG" || nativeModal(element))).reverse();
  const modal = modals.find(element => element.contains(document.activeElement)) || modals[0];
  const disabled = element => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || !!element.closest("[inert]") || !!modal && !modal.contains(element);
  const label = element => (element.getAttribute("aria-label") || Array.from(element.labels || []).map(x => x.innerText).join(" ") || element.getAttribute("placeholder") || element.innerText || element.getAttribute("title") || "").trim().slice(0, 240);
  const fingerprint = element => JSON.stringify([
    element.tagName, element.getAttribute("type"), element.getAttribute("role"), label(element),
    disabled(element), !!element.readOnly, !!element.checked,
    typeof element.value === "string" ? [element.value.length, element.value.slice(0, 500), element.value.slice(-100)] : null,
  ]);
  if (args.action && args.action !== "observe") {
    let effect = "not_started";
    const reply = (ok, message) => JSON.stringify({ ok, effect, frame_id: args.frame_id, ...(message ? { message } : {}) });
    try {
      const frame = window[slot];
      if (!frame || frame.id !== args.frame_id) return reply(false, "stale_frame: observe again");
      // Consume before any DOM effect. Neither a late callback nor a failed
      // follow-up observation makes replay of this frame safe.
      window[slot] = null;
      if (!Number.isFinite(args.deadline_epoch_ms) || Date.now() > args.deadline_epoch_ms) return reply(false, "action expired before execution; observe again");
      if (!["click", "fill", "select", "scroll"].includes(args.action)) return reply(false, "unsupported DOM action");
      const entry = frame.targets.get(args.ref), element = entry?.element;
      if (args.action !== "scroll" && (!entry || !visible(element) || !frame.area.contains(element) || fingerprint(element) !== entry.fingerprint || disabled(element))) return reply(false, "stale_target: observe again");
      if (args.action === "fill") {
        if (typeof args.text !== "string" || args.text.length > 16000 || element.readOnly || !["INPUT", "TEXTAREA"].includes(element.tagName) && !element.isContentEditable || element.tagName === "INPUT" && !["text", "search", "email", "url", "tel", "number"].includes(element.type)) return reply(false, "target is not a supported editable field");
      }
      let option;
      if (args.action === "select") {
        option = entry.options?.get(args.value);
        if (element.tagName !== "SELECT" || !option || !option.isConnected || !Array.from(element.options).includes(option) || option.disabled || option.parentElement?.disabled || option.value !== args.value) return reply(false, "option is no longer available; observe its option page again");
      }
      if (args.action === "scroll" && (!Number.isInteger(args.delta_y) || args.delta_y === 0 || Math.abs(args.delta_y) > 5000)) return reply(false, "invalid scroll delta");
      if (args.action === "scroll" && modal && frame.area !== modal) return reply(false, "modal blocks page scrolling; observe dialog scope");
      if (args.action === "scroll" && frame.area !== document.body && !visible(frame.area)) return reply(false, "observation scope disappeared; observe again");
      effect = "unknown";
      if (args.action === "click") element.click();
      if (args.action === "fill") {
        if (element.isContentEditable) element.textContent = args.text;
        else Object.getOwnPropertyDescriptor(element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value").set.call(element, args.text);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (args.action === "select") {
        element.value = option.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (args.action === "scroll") (modal || window).scrollBy({ top: args.delta_y, behavior: "instant" });
      effect = "applied";
      return reply(true);
    } catch (_) {
      return reply(false, "DOM action failed; observe before deciding whether to retry");
    }
  }
  try {
    window[slot] = null;
    const area = args.scope === "main" ? document.querySelector("main")
      : args.scope === "dialog" ? modal || Array.from(document.querySelectorAll('dialog[open],[role="dialog"]')).reverse().find(visible)
        : document.body;
    if (!area) return JSON.stringify({ error: "observation scope is not present; observe page again" });
    const selector = 'button,input,textarea,select,a[href],summary,[role="button"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
    const candidates = area.querySelectorAll(selector);
    const targets = new Map();
    const fullText = area.innerText || "";
    const text = fullText.slice(0, 1_000_000);
    const snapshot = {
      frame_id: args.frame_id, scope: args.scope,
      url: location.href.slice(0, 2048), title: document.title.slice(0, 240),
      text_offset: Math.min(args.text_offset, text.length),
      text: text.slice(args.text_offset, args.text_offset + 3500),
      nodes: [], next_node_offset: null, next_text_offset: null,
      source_text_truncated: fullText.length > text.length,
    };
    const bytes = () => new TextEncoder().encode(JSON.stringify(snapshot)).length;
    // Leave space for actionable controls even on multilingual, text-heavy pages.
    while (new TextEncoder().encode(snapshot.text).length > 1800) snapshot.text = snapshot.text.slice(0, -100);
    // URL/title are also untrusted, potentially very long Unicode strings.
    while (bytes() > 6000 && snapshot.text.length) snapshot.text = snapshot.text.slice(0, -100);
    while (bytes() > 6000 && snapshot.url.length) snapshot.url = snapshot.url.slice(0, -100);
    let next = Math.min(args.node_offset, candidates.length);
    const end = Math.min(candidates.length, next + 500);
    for (; next < end && snapshot.nodes.length < 60; next++) {
      const element = candidates[next], style = getComputedStyle(element);
      if (!element.getClientRects().length || style.visibility === "hidden" || style.display === "none") continue;
      const node = {
        ref: "n" + next, tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || "", role: element.getAttribute("role") || "",
        label: label(element),
        disabled: disabled(element),
        value: element.type === "password" ? "<redacted>" : typeof element.value === "string" ? element.value.slice(0, 500) : null,
      };
      if (element.tagName === "SELECT") {
        node.option_offset = Math.min(args.option_offset, element.options.length);
        node.option_count = element.options.length;
        node.options = Array.from({ length: Math.min(40, node.option_count - node.option_offset) }, (_, i) => element.options[node.option_offset + i]).map(x => ({ label: x.label.slice(0, 120), value: x.value.slice(0, 120) }));
        node.next_option_offset = node.option_offset + node.options.length < node.option_count ? node.option_offset + node.options.length : null;
      }
      snapshot.nodes.push(node);
      if (bytes() > 6000) {
        snapshot.nodes.pop();
        if (snapshot.nodes.length === 0) {
          // A select can be larger than the page budget by itself. Preserve its
          // existence and mark incomplete options instead of silently skipping it.
          node.options_truncated = true;
          node.options = (node.options || []).slice(0, 4);
          if (node.option_count !== undefined) node.next_option_offset = node.option_offset + node.options.length < node.option_count ? node.option_offset + node.options.length : null;
          node.value = typeof node.value === "string" ? node.value.slice(0, 120) : node.value;
          while (snapshot.text.length && bytes() + new TextEncoder().encode(JSON.stringify(node)).length > 6000) snapshot.text = snapshot.text.slice(0, -100);
          while (snapshot.url.length && bytes() + new TextEncoder().encode(JSON.stringify(node)).length > 6000) snapshot.url = snapshot.url.slice(0, -100);
          snapshot.nodes.push(node);
          next++;
        }
        break;
      }
    }
    snapshot.next_node_offset = next < candidates.length ? next : null;
    snapshot.next_text_offset = snapshot.text_offset + snapshot.text.length < text.length ? snapshot.text_offset + snapshot.text.length : null;
    snapshot.truncated = snapshot.next_node_offset !== null || snapshot.next_text_offset !== null || snapshot.source_text_truncated;
    if (bytes() > 6144) return JSON.stringify({ error: "observation exceeds byte budget" });
    for (const node of snapshot.nodes) {
      const element = candidates[Number(node.ref.slice(1))];
      const options = element.tagName === "SELECT" ? new Map((node.options || []).map((option, i) => [option.value, element.options[node.option_offset + i]])) : null;
      targets.set(node.ref, { element, fingerprint: fingerprint(element), options });
    }
    window[slot] = { id: args.frame_id, area, targets };
    return JSON.stringify(snapshot);
  } catch (_) {
    return JSON.stringify({ error: "guest-page observation failed; page evidence is untrusted" });
  }
})
