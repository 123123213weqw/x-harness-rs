# Real DeepSeek Swarm smoke test — 2026-10-16

A fresh isolated Web Host on WZU_Server used the existing server credential and the official DeepSeek endpoint. The live route was `deepseek/deepseek-flash`, low reasoning. Only the existing Agent tool was exposed for this bounded arithmetic test; filesystem, shell and browser tools were not exposed. No installed desktop app or existing user chat was changed.

The model created two workers and all three tasks through the actual Agent tool. The human test driver created the team, linked those workers and enabled dispatch; it did not add, assign or review tasks. Actual worker answers, exact assignment turns, durable claim/acceptance ordering and one consumed delivery per task were independently checked against the test Host’s persisted session and Control logs. Private verification scripts and raw journals remain in the isolated server run directory; no hidden reasoning or credentials are included here.

The two independent tasks returned SUM=42 and PRODUCT=42. Both were accepted before the dependent check was claimed; that check returned MATCH=42 and named both source tasks. All three were accepted. The three-task stage took 35.2 seconds, excluding the initial worker handshake and human driver setup. This is orchestration smoke coverage, not a coding-quality benchmark or proof of general autonomous reliability.

An idle restart retained the exact completed board. During a five-second observation after readiness, all actors stayed idle, model step/turn counts and reported usage were unchanged, and no task was rerun. Interrupted-effect/crash-cut recovery is covered separately by deterministic tests, not claimed from this idle restart.

Two late native result notifications caused additional coordinator confirmation turns. These were queued notifications, not duplicate task execution. The coordinator also made a SIM/SUM typo in one review summary and colloquially called the finished board closed; actual output was SUM=42, and the team remained active. These quality differences are retained in the acceptance record rather than hidden.

Usage is provider-reported normalized usage from the three test sessions. It is not a currency-cost estimate; account balance differences could include unrelated activity. Automatic dispatch remains enabled for this finite completed team, which has no pending tasks and creates no further work without a new request. The Web process remains available for inspection with the Agent-only tool restriction.
