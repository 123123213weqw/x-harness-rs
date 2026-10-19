# Embedded browser routing

## Ownership and policy

`HostState::prompt_sections` adds one versioned `tool/browser` system section.
It describes a conditional preference, not a declaration that every deployment
has a browser. Version 2 contains only this preference:

> For website browsing and interaction, prefer the embedded browser through plugin_mcp when available; respect explicit browser choices.

Detailed browser guidance lives under **Embedded browser** in `plugin_mcp.description`,
not as another long system section. The section is stable within the existing per-turn prompt snapshot;
no bridge polling, Tauri dependency or per-tool-step prompt rewrite is added to Host/Core.

- Open/view/interactive website requests prefer the embedded browser through
  `plugin_mcp`. An explicit open request is not fulfilled by fetching HTML alone.
- Discover availability first. Zero open tabs is not an unavailable browser.
- Lightweight, specific public facts can still use `web_fetch` without opening UI.
  An insufficient title-only/empty fetch should trigger browser discovery before
  an unresolved page-reading request is abandoned.
- Explicit external-browser choices and desktop application tasks retain their
  existing routes. Discovery, navigation and fallback do not bypass approvals.
- Unavailable capabilities or failed operations are not successful page opens.

The native implementation and schemas stay in the existing Host-app adapter.
This is model routing guidance, not an engine-level prohibition or a guarantee
that every model always chooses correctly.

## Discovery compatibility

`plugin_mcp` advertises the embedded browser first in its description. Its existing
`list` response retains the `plugins: string[]` index and adds `capabilities`:

```json
{
  "plugins": ["@xharness/native-browser"],
  "capabilities": [{
    "plugin": "@xharness/native-browser",
    "server": "webview",
    "description": "Embedded browser: open pages, inspect and interact. Available with zero tabs; describe control to open this chat's sidebar."
  }]
}
```

A browser summary is emitted only after the existing private bridge availability
probe succeeds. It contains no bridge token/address, input schema, screenshot or
page contents. No bridge or an unavailable bridge produces no browser capability
summary. Full schemas remain lazy through `describe`; control/open still expands
the sidebar and uses the existing readiness/approval protocol.

## Regression layers

1. Host tests check one stable, audited policy section, generic capability wording,
   explicit browser-choice/fallback boundaries, and absence of transcript mutation.
2. Native adapter tests exercise real loopback framing for available/unavailable
   zero-tab discovery, bounded schema-free summaries, frozen owner and no secret echo.
   Existing approval, cancellation, unknown-effect, screenshot and display regressions remain enrolled.
3. `scripts/experiments/test-browser-routing-ab.py` runs offline in CI and checks
   the behavioral oracle, production source/schema extraction and nested tool-result envelopes.
4. The opt-in live experiment calls a real provider with the same 18 public desktop
   tool definitions in both arms. Only the production MCP description, browser
   discovery summary and browser policy differ. Browser/desktop/shell results are
   simulated; no real command, browser navigation or account action executes.

The live corpus covers explicit open, a bare link, continuation after a sparse
JavaScript fetch, interaction, explicit Chrome, desktop Calculator, fact-only
reading and an unavailable bridge. Route success requires observable tool calls;
self-report, discovery alone or open without observe cannot pass a browser case.
A correct desktop/external choice is not counted as an unwanted Computer Use fallback.

Example opt-in run (requires an existing evaluation credential):

```sh
python3 scripts/experiments/browser-routing-ab.py \
  --base 34b9336d476d861277e91eff4085c54bc1343d39 \
  --tool-snapshot docs/evidence/browser-routing-20261017/tools-public.json \
  --output /tmp/xharness-browser-routing-new-run \
  --repeats 2
```

The client reads `XHARNESS_EVAL_API_KEY`, or the existing local evaluation Keychain
entry. Never commit credentials or copy private chat/system-memory snapshots into
this experiment. Evidence records token usage rather than inferring an account charge;
hidden reasoning is never saved. Paid model calls are not part of CI.

This experiment measures routing, not browser rendering, real website extraction,
full task completion or universal reliability. Native cross-platform GUI acceptance
remains separate; these tests do not install or restart the desktop application.

## Recorded acceptance (2026-10-17)

The final MCP-policy placement run contains eight cases, repeated twice per arm.
Baseline passed 6/16 routing checks; candidate passed 16/16. For the four
browser-required cases specifically, candidate opened and observed through the
embedded route in 8/8 trials with no Computer Use/shell fallback. Baseline passed
0/8 and attempted desktop fallback in six of those trials. Explicit Chrome,
desktop, title-only and unavailable-bridge controls all passed in the candidate.

V100 regression and Clippy results are recorded alongside the exact source hashes
in `docs/evidence/browser-routing-20261017/acceptance.json`, the protocol, all 32
final trial traces and the full Rust log. Ten offline oracle tests run in CI.
Earlier failed pilots and the earlier long-system-policy placement are retained
in the acceptance history rather than counted as final passes.

These are bounded routing results with simulated actions, not live Tmall GUI
acceptance or a guarantee across models. The installed app remains unchanged.
