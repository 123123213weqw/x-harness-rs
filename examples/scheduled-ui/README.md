# Scheduled UI design preview

A standalone, interactive XHarness design proposal inspired by the supplied
Scheduled page: a compact task sidebar and a centered, two-column template
landing page. This is a **sample-only preview**, not the production Automations
page or a new scheduler.

## Run locally

Node.js 22 or later is required. From this directory:

```sh
npm ci
npm run dev
```

Open [the local preview](http://127.0.0.1:3092/). If that port is already in use,
choose another one with `npm run dev -- --port 3093`. The development server
binds to loopback only.

```sh
npm test
npm run build
```

The dependency lockfile and the scoped `Scheduled UI preview` CI workflow test
this example independently of the application's UI toolchain.

## Try the flow

1. Select a template or **New task**.
2. Edit the instructions and schedule: interval, daily, weekly, or one-shot.
3. Review the configuration before **Create sample**.
4. Open the task, edit it, toggle its sample state, or **Demo one run**.
5. Search/filter the sidebar and try Chinese/English or light/dark themes.

On narrow screens the sidebar becomes a drawer. Run history collapses work
details to leave the result readable. Deleting a sample requires confirmation.
Motion uses a copy of the product's motion tokens and respects reduced motion.

**All records live in memory and reset on reload.** There are no Host RPCs,
model calls, execution timers, filesystem reads, or server connections. Names,
summaries, locations, execution records, and next-run times are illustrative.
The local/server selector does not connect to a runner.

## Production integration is deliberately separate

Merging this example does not change the installed app or its Automations page.
Production must keep task definitions, execution records and recurrence owned
by `xharness-schedule`/Host and project them into the UI. Reuse the existing
conversation components for each task's conversation rather than adding
another conversation implementation.

The preview calendar helper fixes its timezone to Asia/Shanghai and is only for
displaying the proposed interaction. It is **not** a production recurrence
engine. Daily/weekly schedules, pause/resume and runner selection need explicit
backend contracts before those controls can be enabled in the real app.

## 说明

这是定时任务页面的独立设计预览：左侧任务列表，右侧模板；新建、确认、
详情、编辑、暂停与执行记录均可体验。支持中英双语、黑白双主题和窄屏布局。

所有任务和执行结果均为示例，刷新即重置；未连接后端、模型或真实定时器。
合入这个示例不会改变已安装的软件，也不会创建真实自动化。
