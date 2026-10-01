// Fixed, read-only guest-page inspection. No IPC, fetch, arbitrary selector or
// privileged bridge is installed in the page. All returned page data is untrusted.
(function observeBrowser(args) {
  try {
    const area = args.scope === "main" ? document.querySelector("main")
      : args.scope === "dialog" ? document.querySelector('dialog[open],[role="dialog"]')
        : document.body;
    if (!area) return JSON.stringify({ error: "observation scope is not present; observe page again" });
    const selector = 'button,input,textarea,select,a[href],summary,[role="button"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
    const candidates = area.querySelectorAll(selector);
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
        label: (element.getAttribute("aria-label") || Array.from(element.labels || []).map(x => x.innerText).join(" ") || element.getAttribute("placeholder") || element.innerText || element.getAttribute("title") || "").trim().slice(0, 240),
        disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true",
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
    return JSON.stringify(snapshot);
  } catch (_) {
    return JSON.stringify({ error: "guest-page observation failed; page evidence is untrusted" });
  }
})
