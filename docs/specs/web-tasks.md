# 任务列表面板（`@xlang/xharness-client-ui-tasks`）

对话页头部「任务」按钮打开右侧管理面板。交互模式（置顶区、日历日分桶的
时间线、行内重命名、⋯ 操作菜单）改写自 Apache-2.0 的 zai-org/ZCode 任务列
表；数据与操作全部走冻结的上游 RPC（`session.list`、`workspace.list`、
`session.rename`、`workspace.archiveSession`、`session.fork`），host 零改动。

## 视图

- **置顶区**：`localStorage`（`xharness.tasks.pinned.v1`）保存 id 列表，单用
  户本地产品可接受；跨浏览器不同步是已知边界。刷新时对已不存在的会话自动
  清理。
- **时间线分组**：按本地当日零点切桶——今天/昨天/最近 7 天/更早；`blank`
  会话不显示；桶内按 `updatedAt` 倒序。标题取 `session.list` 的
  `projections.values.title`（auto-titles 维护），缺省回退 cwd 末段。
- **已归档区**（默认折叠）：`workspace.list` 的 `archivedSessionIds`。
  `session.list` 会过滤归档会话，所以归档操作发生时前端把
  `{title, updatedAt}` 快照进 `localStorage`
  （`xharness.tasks.archive-snapshots.v1`）；存量归档会话无快照，显示 id 短码。

## 操作与恢复路径

菜单项：置顶/取消置顶（本地）、重命名（`session.rename`）、归档
（`workspace.archiveSession`）、复刻（`session.fork`）、复制会话 ID。

**归档没有上游恢复 RPC**（`archiveSession` 单向，`insertSessionBefore` 只做
工作区内排序）。恢复路径 = 复刻：`session.fork` 基于归档会话的历史创建新的
未归档会话。若后续要原生恢复，可在 `/api/terminal/*` 同款扩展插槽上加热点
方法（见 [web-terminal.md](web-terminal.md) 的扩展面先例）。

## 边界

- 点击条目不切换会话：上游 SPA 的会话导航没有稳定的插件入口，面板定位是
  「组织管理」，导航仍归侧栏。
- 面板每次打开或手动刷新时拉全量列表；没有增量订阅。
