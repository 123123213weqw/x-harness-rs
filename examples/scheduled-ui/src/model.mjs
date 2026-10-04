export function makeDraft(template) {
  const date = new Date(Date.now() + 3600_000);
  const at = new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16);
  return {
    title: template?.title ?? "",
    prompt: template?.prompt ?? "",
    kind: template?.kind ?? "every",
    minutes: template?.minutes ?? "30",
    time: "09:00",
    weekday: "1",
    at,
    workspace: template?.workspace ?? "x-harness-rs",
    runner: "local",
  };
}
export function seedTasks() {
  return [
    {
      ...makeDraft(),
      id: "training",
      title: "八卡 Qwen 夜间训练监测",
      prompt:
        "每 30 分钟检查训练日志与 GPU 状态。关注 loss、吞吐和异常退出；仅在有重要变化时汇报，不修改训练参数。",
      workspace: "training",
      enabled: true,
      nextAt: Date.now() + 30 * 60_000,
      runs: [{ id: "training-sample", seconds: 42 }],
    },
    {
      ...makeDraft(),
      id: "compare",
      title: "2k 与 4k 续训对照跟进",
      prompt:
        "每 15 分钟对比 2k 与 4k 续训日志，整理最新进展、差异与需要关注的异常。",
      minutes: "15",
      workspace: "training",
      enabled: true,
      nextAt: Date.now() + 15 * 60_000,
      runs: [{ id: "compare-sample", seconds: 26 }],
    },
  ];
}
export function visibleTasks(tasks, { query = "", filter = "all" } = {}) {
  return tasks
    .filter(
      (task) =>
        (!query.trim() ||
          `${task.title} ${task.prompt}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())) &&
        (filter === "all" || task.enabled === (filter === "enabled")),
    )
    .toSorted(
      (a, b) => Number(b.enabled) - Number(a.enabled) || a.nextAt - b.nextAt,
    );
}
export function validateDraft(draft, now = Date.now()) {
  if (!draft.title.trim()) return "title";
  if (!draft.prompt.trim()) return "prompt";
  if (
    draft.kind === "every" &&
    (!/^\d+$/.test(String(draft.minutes)) ||
      Number(draft.minutes) < 5 ||
      Number(draft.minutes) > 525600)
  )
    return "interval";
  if (
    draft.kind === "once" &&
    (!Number.isFinite(onceTime(draft.at)) || onceTime(draft.at) <= now)
  )
    return "future";
  if (
    ["daily", "weekly"].includes(draft.kind) &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)
  )
    return "time";
  return null;
}
// Fixed Asia/Shanghai calendar math for visual preview only.
// Production recurrence/execution stay in the Rust scheduler, not this UI.
export function nextTime(draft, now = Date.now()) {
  if (draft.kind === "every") return now + Number(draft.minutes) * 60_000;
  if (draft.kind === "once") return onceTime(draft.at);
  const shifted = new Date(now + 8 * 3600_000),
    [hours, minutes] = draft.time.split(":").map(Number);
  let next =
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
      hours,
      minutes,
    ) -
    8 * 3600_000;
  if (draft.kind === "weekly") {
    const days = (Number(draft.weekday) - shifted.getUTCDay() + 7) % 7;
    next += days * 86400_000;
    if (next <= now) next += 7 * 86400_000;
  } else if (next <= now) next += 86400_000;
  return next;
}
function onceTime(at) {
  return new Date(`${at}+08:00`).getTime();
}
