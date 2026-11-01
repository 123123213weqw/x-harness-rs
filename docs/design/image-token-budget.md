# Provider-specific image allowance

The OpenAI adapter keeps text calibration and image budgeting separate. On the
verified official DeepSeek HTTPS endpoint, the documented Flash model and its
legacy Flash aliases reserve **1,024 tokens per image**. This is a documented
upper allowance, not a claim of exact tokenization. The bound is recorded in the
adapter with its source and verification date:
[DeepSeek Vision / Token Usage](https://api-docs.deepseek.com/guides/vision/#token-usage).

Unknown models, proxies, local deployments and unrecognized routes retain the
existing saturating pixel-based fallback. Model names alone never establish an
endpoint's preprocessing contract. Missing or invalid dimensions still fail.
Each image occurrence counts independently, including repeated attachments.

Nothing changes image bytes, resolution, encoding, request options, context
capacity, output reserve or compaction thresholds. Exact request counts retain
precedence. Compatible text-only calibration remains usable; image captions
retain their independent byte reserve. Mixed usage is not split into guessed
text and image samples. Existing mixed-overflow invalidation remains active.
No calibration snapshot or transcript format changes are needed.

## Reproduction

- Offline tests: provider `image_budget` tests cover official endpoint/model
  selection, invalid metadata, dimensions and multi-image counts, unknown-provider
  fallback, cold/warm calibration, caption reserve, true overflow, unchanged
  Chat Completions/Responses payloads and exact-count precedence.
- Opt-in live check: `scripts/experiments/image-token-budget-live.py --output
  <evidence-directory>` syncs sources and compiles only on WZU_Server. It runs
  twelve official Flash requests: text-only, small, square, large screenshot,
  panoramic and repeated screenshot inputs through both real Rust wire adapters.
  Credentials are never written to source, argv, fixtures or reports. The live
  Rust test is ignored in normal CI and requires explicit environment setup.
- Reports compare old/new estimates against complete provider-reported input,
  including cached tokens. Synthetic fixtures contain no user content. These
  checks validate budgeting, not image-understanding quality or monetary cost.
