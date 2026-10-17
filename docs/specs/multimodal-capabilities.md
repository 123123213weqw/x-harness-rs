# Text and image input capability resolution

## Scope

Connect the existing image pipeline to the independent Reasonmap catalog. Do
not rewrite the Loop, session format, attachment store, or provider wire encoder.
Audio/video generation and native audio/video/PDF inputs are not part of this change.
Main-session uploads use the existing attachment UI; the existing subagent
continuation upload restriction is unchanged.

## Resolution

1. `imageInput: true` or `false` is an explicit deployment override.
2. Missing/null selects Auto. An exact official endpoint + API protocol +
   upstream model match may supply a documented default.
3. Empty/omitted catalog input modalities mean unknown. Unknown routes reject
   image prompts and image-producing tools until the deployment declares support.
4. Resolve images independently of reasoning disable, custom reasoning patches,
   discovery observations, display names, and route aliases.
5. The active ModelDescriptor is the Host's capability snapshot. Host prompt
   admission, screenshot/read-media tools, browser model projection and adapter
   construction use the same effective result. Legacy runtimes without a
   descriptor may use an explicit settings flag; missing flags are not permission.
6. A failed settings activation must not overwrite the active descriptor with
   capabilities from unactivated settings.

## Wire and UI

`session.models`, `llm.models`, and discovery expose optional `imageInput` and
`imageInputCapability`. The latter carries state/source and, for documentation,
catalog version, checked date, and sources. Unknown omits the boolean; false
means unsupported, not unknown. Both Rust and TypeScript schemas preserve it.
No credentials or image bytes are included in this metadata.

The model editor offers Auto / Enabled / Disabled. Auto writes null so a prior
inherited override is cleared rather than silently restored by capability
inheritance. Adopting a documented discovery default keeps Auto; an explicitly
configured discovery flag keeps its value. Hidden draft fields survive edits.

## Existing media pipeline retained

Uploads remain session-scoped validated PNG/JPEG/WebP/GIF references, not base64
in chat logs. Chat Completions encodes image_url; Responses encodes input_image.
Exact image-bearing request counting, output limits, working-set image deferral,
attachment lookup, fork authorization, and opaque provider items retain their
existing implementations. No automatic conversion of an image to a text stub.
File attachments remain files and do not implicitly become image inputs.

## Acceptance

- [x] Separate Reasonmap schema and documented initial image records.
- [x] Explicit overrides and exact-match/unknown tests.
- [x] Reasoning-disabled/custom-profile independence and upstream aliases.
- [x] Host prompt/tool gate and capability projection tests.
- [x] Three-state UI and metadata-preserving decoder tests.
- [x] Remote XHarness Rust regression suites and Clippy.
- [x] Chromium and WebKit settings interaction acceptance.
- [ ] Optional live vision-provider acceptance (not required or claimed here).

Documented initial records are a subset, not a claim that every catalog model
supports vision. This feature does not install a vision projector in llama.cpp
or change the user's V100/4080 model deployment.
