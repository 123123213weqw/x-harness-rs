# xharness-platform

The compile-time native lower layer for XHarness:

- shared `xharness-process` direct-exec runtime;
- shared `xharness-fs` capability/observation API;
- Linux Bubblewrap confinement;
- macOS Seatbelt confinement.

The model provider and agent loop do not depend on this crate. A CLI or daemon
composes them at the application boundary.
