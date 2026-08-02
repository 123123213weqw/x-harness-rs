import test from "node:test";
import assert from "node:assert/strict";
import {
  makeDraft,
  seedTasks,
  validateDraft,
  nextTime,
  visibleTasks,
} from "../src/model.mjs";
test("blank draft requires a title and instruction", () => {
  const draft = makeDraft();
  assert.equal(validateDraft(draft), "title");
  assert.equal(validateDraft({ ...draft, title: "a" }), "prompt");
});
test("repeat uses whole minutes, minimum five", () => {
  const draft = { ...makeDraft(), title: "a", prompt: "b" };
  for (const minutes of ["0", "4", "5.5", "abc", "99999999"])
    assert.equal(validateDraft({ ...draft, minutes }), "interval");
  assert.equal(validateDraft({ ...draft, minutes: "5" }), null);
});
test("once requires a future time", () => {
  const draft = {
    ...makeDraft(),
    title: "a",
    prompt: "b",
    kind: "once",
    at: "invalid",
  };
  assert.equal(validateDraft(draft), "future");
  assert.equal(
    validateDraft({ ...draft, at: "2026-01-01T00:00" }, Date.UTC(2026, 9, 4)),
    "future",
  );
});
test("daily advances in Asia/Shanghai", () => {
  const now = Date.parse("2026-10-04T01:01:00Z");
  assert.equal(
    new Date(
      nextTime({ ...makeDraft(), kind: "daily", time: "09:00" }, now),
    ).toISOString(),
    "2026-10-05T01:00:00.000Z",
  );
});
test("weekly advances after same weekday time", () => {
  const now = Date.parse("2026-10-04T01:01:00Z");
  assert.equal(
    new Date(
      nextTime(
        { ...makeDraft(), kind: "weekly", weekday: "0", time: "09:00" },
        now,
      ),
    ).toISOString(),
    "2026-10-11T01:00:00.000Z",
  );
});
test("catalog sorts, filters, searches without mutating input", () => {
  const tasks = seedTasks(),
    order = tasks.map((item) => item.id);
  assert.equal(visibleTasks(tasks)[0].id, "compare");
  assert.deepEqual(
    tasks.map((item) => item.id),
    order,
  );
  assert.equal(visibleTasks(tasks, { query: "Qwen" }).length, 1);
  assert.equal(visibleTasks(tasks, { filter: "paused" }).length, 0);
  assert.equal(visibleTasks(tasks, { query: "missing" }).length, 0);
});
test("one-shot preview time is Shanghai, independent of system timezone", () => {
  const draft = { ...makeDraft(), kind: "once", at: "2026-10-05T09:30" };
  assert.equal(
    new Date(nextTime(draft)).toISOString(),
    "2026-10-05T01:30:00.000Z",
  );
});
