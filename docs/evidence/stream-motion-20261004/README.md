# Streaming prose presentation

The existing Assistant Markdown renderer now opts into a presentation-only
50 ms append batch and 150 ms opacity fade. Persisted messages, model requests,
the incremental parser, and the chat's scroll ownership remain unchanged.

Only recent, exact-source prose slices animate. Reconstructed Markdown uses
the original slice age rather than restarting a fade. Code, tables, math,
normalized entities, and unsafe Unicode split boundaries stay plain. Large
bursts, replacements, completion, interruption, hidden documents, and reduced
motion bypass batching. One pending timeout per mounted stream is cancelled
on disposal; only four recent numeric ranges are retained.

The older paragraph-level Motion observer skips Markdown owned by this
renderer, including when the stream finishes or history restores.

## Reproduce without an API key

```sh
node --test scripts/test-stream-presentation.mjs
node scripts/preview-stream-motion.mjs
```

Open `http://127.0.0.1:3267/`. The local simulation mounts the actual production
Markdown component. Use Natural / Raw, Replay, the structured example, and the
burst example. The demo performs no API requests and is not a model/network
benchmark. It is intentionally not shipped as a production route.

`results.json` records test and browser evidence. `demo.png` is the actual
in-app browser capture. GitHub CI, native desktop verification, and publishing
were not performed for this change.
