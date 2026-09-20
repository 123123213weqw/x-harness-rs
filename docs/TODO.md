# XHarness 总任务清单

## Host RPC 模块化重构（2026-09-20）

目标：保持单进程、线协议和持久格式不变，把当前“文件已拆、依赖未拆”的 `BasicHost` 重构为可维护的
模块化单体。完整规范见 [Host RPC 模块化重构规范](specs/host-rpc-modularization.md)。

- [x] `RPC-ARCH-00` 建立 WZU_Server quick/full 回归入口，锁定当前 master 行为和动态投影压力测试。
- [x] `RPC-ARCH-01a` 为 52 个固定 RPC 建立穷举的 typed Params/Response 目录；兼容边界允许附加字段，
  `Value` 只留在 content block、schema、事件等确实开放的内部节点。
- [x] `RPC-ARCH-01b` 增加协议契约测试：全部方法请求可解码、字段保持 camelCase、错误报告包含方法与方向。
- [x] `RPC-ARCH-01c` 用现有 Host 全方法基线实际验证其中返回的全部成功响应，确保冻结的是运行行为而不是只靠手写猜测；错误路径仍按既有 `RpcResult` 契约断言。
- [x] `RPC-ARCH-01d` WZU_Server quick/full 全绿；本阶段没有接入生产分发，也未修改 UI、JSONL 或 Control Log。
- [x] `RPC-ARCH-02a` 以 Workspace 建立首个职责分离样板：`WorkspaceProcessor` 只接收只读领域快照，纯计算响应、Control Event 与 Host Event，不依赖 `BasicHost`、Transport、锁或 Store。
- [x] `RPC-ARCH-02b` `rpc/workspace.rs` 收敛为兼容适配器：保留旧字段校验、控制锁、Exactly-once Receipt、原子提交及提交成功后发布事件；`rpc.rs` 的七个 Workspace 分支合并为一个领域入口。
- [x] `RPC-ARCH-02c` 加源码依赖门禁，禁止 WorkspaceProcessor 重新引入 `BasicHost`、RPC ID/Method、Tokio 或 ControlStore；新增重复创建、确定性排序和失败前零事件测试。
- [x] `RPC-ARCH-02d` WZU_Server full 全绿：全工作区、Clippy `-D warnings`、进程清理与 UI 套件均为 `failures=0`；固定 RPC 类型基线继续覆盖 Workspace 实际响应。
- [x] `RPC-ARCH-03a` 抽出纯 `SettingsProcessor`：Settings Describe/Update/Replace/Mutate 只根据设置快照计算下一版 Namespace；Revision CAS、Permission 白名单、偏好校验和 JSON Path 语义均由领域核负责。
- [x] `RPC-ARCH-03b` `rpc/settings.rs` 成为兼容与持久化适配器：Receipt Replay 仍先于校验，Model Registry 在提交前 Prepare，Control Log 原子提交后才 Activate 并发布 `settings/document-updated`；模型 Schema 继续只作为可执行版本元数据重建，不写入回执。
- [x] `RPC-ARCH-03c` 为 SettingsProcessor 增加源码依赖门禁以及 Revision 冲突、Model Base 合并、非法操作零变更、Permission 拒绝测试；WZU_Server quick 回归全绿。
- [x] `RPC-ARCH-03d` WZU_Server full 回归全绿：全 Workspace Test、Clippy `-D warnings`、进程清理、模型设置真实进程重启和 UI 套件均为 `failures=0`，Settings 阶段完成。
- [x] `RPC-ARCH-03e` 抽出纯 `PresetProcessor` 和 `rpc/preset.rs` 兼容适配器：六个 Agent Preset RPC 统一领域入口；列表默认项、读取、复制、只读删除保护、Session 存在性/运行态选择校验由快照决策核负责，Session Receipt 与耐久提交仍由适配器负责。
- [x] `RPC-ARCH-03f` PresetProcessor 增加默认项不污染快照、选择错误矩阵、复制冲突零变更、System Preset 删除拒绝测试和源码依赖门禁；WZU_Server quick 回归全绿。
- [x] `RPC-ARCH-03g` WZU_Server full 回归全绿：全 Workspace Test、Clippy `-D warnings`、进程清理、Preset/Session Receipt 基线和 UI 套件均为 `failures=0`，Preset 阶段完成。
- [x] `RPC-ARCH-03h` 抽出纯 `CredentialProcessor` 与 `rpc/credentials.rs` 适配器：引用格式、环境变量遮蔽、内存后备状态和只含元数据的 Describe 响应进入领域核；Keychain/Backend I/O、Registry 激活和 Web 通知留在副作用适配器。
- [x] `RPC-ARCH-03i` Credential 快照只含引用集合、不含 Secret Value；新增引用矩阵、环境遮蔽、响应/错误不回显密钥和显式内存变更测试，并加入源码依赖门禁；WZU_Server quick 回归全绿。
- [x] `RPC-ARCH-03j` WZU_Server full 回归全绿：全 Workspace Test、Clippy `-D warnings`、Secret-free Session/Server 测试、Model Settings Keychain/进程重启和 UI 套件均为 `failures=0`，Credentials 阶段完成。
- [ ] `RPC-ARCH-03k` 依次迁移 Model、Subagent、Goal；一次只迁移一个领域。
- [ ] `RPC-ARCH-04` 建立统一 `EventGateway`，让实时事件和历史恢复使用同一投影 reducer。
- [ ] `RPC-ARCH-05` 最后迁移 Session/Prompt/Turn 状态机；本项不夹带 compaction、预算或调度语义改动。
- [ ] `RPC-ARCH-06` 删除旧 `BasicHost` handler 与双重投影；动态上游端点保留在明确的兼容适配器中。
- [ ] `RPC-ARCH-07` 每阶段独立提交、可回滚；合并前跑跨平台 CI 和 WZU_Server full，部署另设门禁。

## 模型路由对账与原因可见（2026-09-19）

现场：已配置模型的用户被作曲家提示「当前模型不可用，请先选择模型」，而 `llm.providers` 里该
provider 仍是 `active: true`。三条互不相关的路径都会产生这一矛盾，且**都没有任何原因到达用户**。

- **C（无故障即可触发）**：`can_route` 拿会话里存的 `contextWindowTokens`/`reasoningEffort` 与实时注册表
  比对，而这两个值是用户选择那一刻的快照。此后一次设置改动或一次升级把模型声明改小（例如
  `contextWindow` 32768 → 16384），provider 与 model 都健康，路由却永久失败。`selectModel` 只在选择
  当时校验，之后没有任何地方重新对账。
- **A**：激活失败会用空注册表替换全部路由——这是**有意的 fail-closed**，且已由
  `restore_activation_failure_clears_stale_routes_but_preserves_settings_repair` 覆盖；问题在于原因只进
  Host 的 stderr。
- **B**：凭据缺失的 provider 被 `registry_from_resolved_settings` 静默丢弃（`None => continue`），
  `model_settings_error` 为 `None`、`startupIssues` 为空、stderr 也没有任何输出。

- [x] `MODEL-ROUTE-01` 对账会话存储的选择：仍合法的用户窗口原样保留，只有超出新上限时才夹回
  `effective_hard_max`；effort 依次回退到模型默认与无，必要时才尝试其他可路由窗口。provider/model
  真消失时不动（无可夹目标）。夹回结果只作进程状态，不写新的持久事件。
- [x] `MODEL-ROUTE-02` 在 `restore_from_store` 与读取 `session.models` 两处对账，使**实时改设置无需重启**即自愈；修复写入 `startupIssues` 说明改了什么。
- [x] `MODEL-ROUTE-03` `host.describe.modelSettingsError` 暴露激活失败原因（与 #94 让 `startupIssues` 可达同构）；客户端 schema 忽略未知字段，加字段不破坏客户端。
- [x] `MODEL-ROUTE-04` 填充 `session.models.failures` / `llm.models.failures`——UI **已渲染**该通道（`warning.groupLoad`、`option.loadError`），Host 此前恒返回 `[]`；凭据缺失时点名具体引用。
- [x] `MODEL-ROUTE-05` WZU_Server：`-p xharness-host -p xharness-host-app` 209 项通过、Clippy `-D warnings` 与 fmt 干净；仅回退 `crates/xharness-host/src` 时三个回归测试全部失败，确认判别力。
- [ ] `MODEL-ROUTE-06` PR 跨平台 CI 通过后合并；源码修复不代表已安装桌面/Web 已生效。
- [ ] `MODEL-ROUTE-07` 桌面启动屏仍只监听 `xharness-bootstrap`，不显示上述原因；主 UI 模型选择器已可见，启动失败场景待接。

## 历史读取失败后的实时回答可见性（2026-09-19，Issue #119）

用户上报：「有时候我发消息，前面已经 fail，后面发了消息；有可能模型还在回答，但是前端不显示」。
真实事故 `session-1789711617394-1009`：回合 6（19:57:08）、7（19:59:04）因
`provider recovery deadline exceeded` 失败 → 20:04:25 App 重启 → 20:27:22 新消息起轮 8，
20:28:08 已产出文本与工具调用，20:41:29 `completed`；用户于 20:29:13 另开会话上报本问题。
即模型确实在答、持久日志完整，**丢的只在客户端显示**。

- [x] `LIVE-ANSWER-01` 排除 Host：新增 `failed_turn_projection_tests.rs`，覆盖「失败已结束后再发」与
  「失败进行中就排队」两种顺序，断言该 Prompt 会真正起轮且 `assistant/message` 经 mux 发到浏览器。
  master 树 WZU_Server 上两项通过；此前 Host 侧无失败路径投影回归。
- [x] `LIVE-ANSWER-02` 修复 `ui/overrides/live-answer-recovery.js`：当前会话在 `error` 态收到已接纳
  Prompt 或 `running=true` 上报时复用错误横幅的只读重试路径重开窗口；Prompt 触发覆盖已运行会话
  排队时不会产生第二个状态沿的路径，使缓冲的实时回答得以发布；限速 5 秒、仅从
  `error` 起步、仅当前选中会话，避免拉取循环与后台自发请求。补丁接入
  `scripts/assemble-static-ui.mjs` 与 `ui/dist`（含 eager `<script src>` 的 rev 收敛）。
- [x] `LIVE-ANSWER-03` 回归 `scripts/test-live-answer-recovery.mjs`：Prompt/状态双触发、拒绝零请求、发布缓冲回答、限速、后台隔离、
  健康窗口零请求，以及补丁幂等/锚点失败关闭/图谱哈希；未打补丁时首项即失败（回答留在缓冲不显示）。
  同轮 15 个涉及 runtime 包的既有 UI 套件全部通过。
- [ ] `LIVE-ANSWER-04` PR 跨平台 CI 通过后合并；`ui/dist` 只覆盖 `--static-dir` 部署，
  已安装 App 的 `Contents/Resources/web` 需随版本替换后才对用户生效。
- [ ] `LIVE-ANSWER-05` 历史接口长期不可用时的降级：当前仍只保证缓冲不丢、不渲染。
- [ ] `LIVE-ANSWER-06` 前端状态可观测：本次只能靠持久日志反推「模型答了、前端没显示」。
  建议把 `openState` / `openError` / `liveBuffer` 长度 / 最近一次历史失败原因接入既有运行诊断。

## Control Log 启动恢复（2026-09-19，Issue #109）

- [x] `CONTROL-RECOVERY-01` 精确零字节日志按空状态加载，首次 Append 自动补齐 Header；非空损坏保持 fail closed。
- [x] `CONTROL-RECOVERY-02` Header 改为同目录完整写入并同步后再发布，正式路径不暴露半写 Header。
- [x] `CONTROL-RECOVERY-03` 仅容忍完整记录后的纯换行后缀，并在下一次 Append 截断；中间空行仍拒绝。
- [x] `CONTROL-RECOVERY-04` 补零字节重启/追加、尾部空行修复、中间损坏、空白/坏 Header、符号链接与跨实例 CAS 回归。
- [x] `CONTROL-RECOVERY-05` WZU_Server 全 Workspace 测试与 Clippy 零警告；真实桌面姿态 Host 在零字节 Control Log 下成功进入 Ready 并优雅退出。
- [ ] `CONTROL-RECOVERY-06` PR 跨平台 CI 通过后合并；源码修复不自动替换已安装软件。

## macOS 预览签名分支（2026-09-18）

现场：`0.2.20` 的三平台候选构建里 Windows、Linux 通过，两个 Mac 架构都在
`Build and sign desktop bundle` 失败：`SecKeychainItemImport: One or more parameters
passed to a function were not valid`。`desktop-release.yml` 用空字符串表示「不用 Apple
凭据」（`APPLE_CERTIFICATE: ${{ !matrix.macos_preview && secrets.APPLE_CERTIFICATE || '' }}`），
但 bundler 用 `std::env::var_os` 选分支，**已定义但为空**仍返回 `Some("")`，预览版因此照样
走证书导入与公证，`APPLE_SIGNING_IDENTITY: '-'` 永远轮不到。该写法由 #69 引入；0.2.16/0.2.18/
0.2.19 均无 Mac 资产，说明这条路径从未成功过。原有回归还断言了 `|| ''` 这个机制本身，锁住了缺陷。

- [x] `MAC-PREVIEW-SIGN-01` 拆成两个 `if` 守卫的构建步骤：正式步骤用 `!matrix.macos_preview` 并直接引用 Secrets；预览步骤用 `matrix.macos_preview`，只设 `APPLE_SIGNING_IDENTITY: '-'` 与 updater 密钥，**完全不定义** Apple 凭据。与已成功的 `desktop-macos-preview.yml`、CI 预演写法一致。
- [x] `MAC-PREVIEW-SIGN-02` 把回归从「断言空字符串」改为「断言预览步骤存在且不含 Apple 凭据、任何 `APPLE_*` 赋值都不得带 `|| ''`」；已验证旧 workflow 会失败。
- [ ] `MAC-PREVIEW-SIGN-03` 合并后以 0.2.21 重跑三平台候选、原生验收与发布；正式公证范围 `all` 仍需先配置 Apple 凭据（本仓库只有 updater 密钥）。

## 统一发布任务入口（2026-09-18）

- [x] `RELEASE-TASK-01` 单命令协调既有构建、Unix/Windows 验收与 Promote；固定来源 SHA，自动传递 Run ID。
- [x] `RELEASE-TASK-02` 原子状态、进程锁、派发前记录意图、网络未知不重复触发、显式失败重试、正式发布确认。
- [x] `RELEASE-TASK-03` 离线边界回归与三平台 CI 接线；中文[规范](specs/release-orchestrator.md)。
- [ ] `RELEASE-TASK-04` PR 跨平台 CI 通过后合入 master；真实候选构建与发布演练单独授权，未修改线上更新通道。

## 厂商耦合清除：Host 能力表、示例与 CI（2026-09-17）

承接「上游命名空间退出出厂产物」。产物侧的 `@deepseek-ai` 已随 `feat/ui-namespace` 迁到
`@xharness/`；这里清掉剩余会**影响行为**的厂商耦合。

- [x] `VENDOR-01` 删除 `xharness-host-app` 内置能力目录（只在 HTTPS `api.deepseek.com` + 三个精确模型 ID 生效的冗余回退），思考档位改由部署声明（`reasoning.efforts[].request_patch`）或 `reasoningDiscovery` 发现；观测来源收敛为 `configured` / 发现来源，未知端点照旧不主动探测。
- [x] `VENDOR-02` `config/providers.deepseek.example.json` → `config/providers.remote.example.json`（占位端点 + `EXAMPLE_API_KEY` + 显式档位）；`scripts/start-windows.ps1`、Windows 打包步骤、`docs/windows.md`、`docs/specs/model-settings.md` 同步。
- [x] `VENDOR-03` live 验收工作流 `deepseek-live.yml` → `live-model-acceptance.yml`：端点、模型与密名都变成 `workflow_dispatch` 输入；`live_loop.rs` 的用例名/会话名/断言文案中性化；`history_live_eval` 例子的端点由输入提供（`scripts/history-live-ab.py` 转发并记录 `base_url`）。
- [x] `VENDOR-04` 测试夹具里的 `DEEPSEEK_API_KEY` 示例名改为 `EXAMPLE_API_KEY`（control / process / desktop sidecar）；compaction 的用例名与注释、host 的示例 provider id、server/metrics 的文档注释改为按「上游契约版本」表述。
- [ ] `VENDOR-05` 发版与装机复验：确认移除内置能力表后，现有 `providers.json`（已显式声明档位）行为不变；未声明档位的旧配置在 Web 中显示 `unknown`，需要按 `docs/specs/model-settings.md` 迁移段落补 `reasoning`。
- [ ] `UI-NS-06` 保留项与仍属上游语义的名字：`--dsw-static-deepseek-*` 设计令牌、`__DSH_BOOT__`、`--dsh-*` class 前缀、UI 侧 provider/settings id（`deepseek-official`、`llm-deepseek`、`web-search-deepseek`）与 onboarding/搜索文案；必须保留的上游溯源记录（`xharness-api::UPSTREAM_CONTRACT_REVISION`、`docs/compat/*`、`scripts/terminal_bench/official-*`、`THIRD_PARTY_NOTICES.md`）。

## Worker 生命周期监督（2026-09-18，PR #102）

- [x] `WORKER-01` 稳定 Handle 与 Worker 可用性分离，监督任务独占 Join/重建，旧代结束后才释放 reservation。
- [x] `WORKER-02` 普通错误保留 Worker；异常退出自动退避重建，不自动重放命令/副作用；关闭可取消恢复。
- [x] `WORKER-03` idle/ready/stopped 等待、跨代通知、并发恢复、强制退出和最后 Handle 释放回归。
- [x] `WORKER-04` Schedule 等待 Ready，临时故障间隔重试；丢失 Worker 后真实 Owner 投递回归。
- [x] `WORKER-05` V100 全工作区回归：679 通过、9 忽略、0 失败；相关模块 Clippy 通过。
- [ ] `WORKER-06` 更新 PR 后通过跨平台 CI，再合并/发布；当前已安装软件不因源码修改自动生效。
- 规范见 [Agent 生命周期](specs/agent.md#worker-故障监督与等待语义pr-102-调整)。

## 停止后的排队用户 Prompt（2026-09-17）

现场：`session-1789634172710-56127` 16:44:43 排队「可以关的关掉吧」→ 16:44:55 用户停止 →
`agent/dispatch-paused{paused:true}` 把已排队的用户输入一起冻住，直到 16:44:59 手打「1」才解冻；
`session-1789295337629-42012` 停止后 22 小时零派发。

- [x] `STOP-QUEUE-01` Host Driver：门禁为 paused 且队列里仍有 `source.kind=user` 的 queued Prompt 时，重新打开门禁并让该 Prompt 开始下一 Turn；内部 `placement=context` 回执不能解冻（保留 TODO 中「内部回执不能突破停止门禁」不变式）。
- [x] `STOP-QUEUE-02` 启动恢复：next-turn 里存在用户 Prompt 时，即使持久门禁为 paused 也恢复该会话；其余暂停语义不变。
- [x] `STOP-QUEUE-03` 回归：`xharness-host` `user_stop_lets_the_already_queued_prompt_start_the_next_turn`（停止后自动 turn 2 + 门禁落盘为 false）与既有 `host_flood_steer_stop_clears_running_and_parks_internal_followup`（内部回执仍被拦）。
- [ ] `STOP-QUEUE-04` 跨平台 CI、合并、发布与已安装桌面/Web 替换后真实会话复验（源码修复不代表已部署）。

## Web UI 与桌面 App UI 的漂移（2026-09-17）

现象：`http://127.0.0.1:3082` 的页面与已安装 App 的界面看起来不同。实测结论是「两边各新一半」：

- 静态资源：`diff`/md5 全树比对（各 199 个文件）只有 3 个文件不同，且无单边文件。
  App 的 `Contents/Resources/web` 与标签 `desktop-v0.2.19`（`9f8e7dc`）的 `ui/dist` **逐字节相同**；
  仓库 `ui/dist`（= 3082 的 `--static-dir`）多了 #87（`3e28e17`）的设置补丁。
  唯一有行为差异的文件是 `plugins/@deepseek-ai/dsh-client-ui-settings/client.js`（51168 → 53464 字节，
  多出 `xhSettingsSaveFeedback`），`index.html` / `client-graph.json` 只是它的 rev 变了。
- Host 二进制：App 内是 0.2.19 官方构建（27181344 字节，装机时间 09-17 10:00）；
  3082 用的是 `~/Library/Application Support/XHarness/bin/xharness-host`（26739920 字节，09-11 15:33，更旧）。
- 数据面：App Host `--state-dir .../com.xlang.xharness/state`、无 `--providers-file`；
  3082 Host `--state-dir .../XHarness` + `--providers-file .../XHarness/providers.json`，
  工作区/会话/模型列表天然不同。
- 桌面专有层：`ui/dist/desktop-updater.js` 只在 `window.__TAURI__` 存在时挂载，浏览器里永远看不到
  「XHarness 桌面更新 / 运行诊断」入口，两边资源相同但渲染结果不同。

- [x] `UI-DRIFT-01` 用 md5 全树比对确认 App 资源 == `desktop-v0.2.19` 树、与 HEAD 只差 3 文件，并定位到 #87 设置补丁。
- [x] `UI-DRIFT-02` 在 WZU_Server 上用**App 自带的那份 web 资源**（`~/ca-work/app-web`）配修复版 Host 跑真实 Chromium 探针：30/30 通过，证明 GoalBar 修复不依赖仓库 `ui/dist`。
- [ ] `UI-DRIFT-03` App 侧缺 #87 的两半：UI 无「设置未保存」提示，Host 也不持久化 `ui-theme`/`locale`/`ui-conversation`/`agent-presets`（重启即丢）。发版替换 App 后需复验这两点。
- [ ] `UI-DRIFT-04` 改 App UI 必须重打包：`apps/desktop/src-tauri/tauri.conf.json:45` 把 `ui/dist/` 整体塞进 `Contents/Resources/web`，桌面壳 `apps/desktop/src-tauri/src/sidecar.rs:78` 又硬编码 `app.path().resolve("web", BaseDirectory::Resource)`，没有覆盖开关（同一处已支持 `XHARNESS_WORKSPACE`/`XHARNESS_STATE_DIR`/`XHARNESS_PROVIDERS_FILE` 三个环境变量）。建议加 `XHARNESS_STATIC_DIR`：桌面壳先按环境变量解析 web 目录，缺省仍走 bundle，之后改 UI 只需改工作目录 + 重载窗口，不必重打包重装。
- [x] `UI-DRIFT-05` 免重打包的临时办法（机制已验证）：把 `Contents/Resources/web` 换成指向工作副本的符号链接。用 0.2.19 自带 Host 实测 `--static-dir /tmp/xh-web-link`（软链到仓库 `ui/dist`）→ `/`、`/plugins/.../client.js`、`/monochrome.css` 全部 200 且 `index.html` 内容正确，说明 Host 静态服务会跟随目录软链。注意：这是改本机已安装 App（会被下次自动更新覆盖），必须先整目录备份。

## GoalBar 按钮全 404：上游命名空间 Remote 未挂载（2026-09-17）

现场：已安装桌面 App（0.2.19）与 3082 Web 后端上，GoalBar 的暂停/恢复/编辑/确认/清除按钮点击后
只出现红字 `client api: goals/clear failed: transport failure for /api/goals/clear: HTTP 404`，
目标不变。真实 Chromium + 出厂 Web 资源抓包确认：UI 发的是上游命名空间 Remote
`POST /api/goals/<verb>`（`{"args":{agentId,ref,request}}`），而 Host 只挂了
`commands/list`、`commands/execute`，其余动态端点按设计返回 404。

- [x] `GOAL-UI-01` Host `call_dynamic` 挂载 `goals/create|edit|pause|resume|complete|clear`，把 `args.{agentId,ref,request}` 映射到既有扁平方法；其他上游命名空间（`fileReferences`、`dynamicCordisRunner` 等）保持 404，不在此次范围。
- [x] `GOAL-UI-02` 结果形状按客户端 schema 返回：create 为 `{ref}`、clear 为 `{id,revision}`（清除事件的新 revision，扁平 API 仍返回 `{cleared:true}`），edit/pause/resume/complete 返回整个目标状态（含 `activation: armed|disarmed`，取自执行 `enabled`），否则客户端 `rejected "result"`。
- [x] `GOAL-UI-03` 回归两层：`xharness-host` 单测 `namespaced_goal_remotes_serve_every_goal_bar_action`（六个动词 + 过期 ref 仍报错 + 其他命名空间仍 404）；`xharness-host-app` 集成测试 `tests/goal_remotes.rs` 起真实 Host 进程走 HTTP `POST /api/goals/<verb>`，断言 200 且返回整目标、未挂载命名空间仍 404。负向验证：删掉 `call_dynamic` 的 goals arm 后两个测试都失败（`goals/create must not 404` / `goals/edit is not mounted`）。
- [ ] `GOAL-UI-04` 跨平台 CI、发布与已安装实例替换后在真实 App/Web 上复验按钮（源码修复不代表已部署）。真实路由已由 `GOAL-UI-03` 的进程级集成测试覆盖；`scripts/test-goal-runtime-browser.mjs` 仍用内存 stub，只验 UI 补丁形状。手工端到端（真实 Chromium + 修复版 Host + `ui/dist`，逐个点击 暂停/恢复/预算/编辑/清除）已一次性 30/30 通过，脚本未入库。
- [ ] `GOAL-UI-05` 停止过的会话里 `goal.resume` 到达 Host 后不会解除 `agent/dispatch-paused` 门禁（自动续轮是内部回执），因此恢复按钮即使路由通了也不会立刻起轮；与停止后排队 Prompt 的修复（PR #91）属同一扇门。
- [ ] `GOAL-UI-06` `goal.clear` 只写 tombstone，未像 pause/edit 那样落 `GoalExecutionOperation::Discard` + `execution_enabled=false`（`invalidate_goal_pending(id, None)` 跳过整段），清除后执行层仍留 `enabled=true/active`。
- [ ] `GOAL-UI-07` `goal` 工具没有 clear/cancel 动作（`goals.rs` 取消用例显式断言拒绝），且非 complete 旧目标挡住宅建（`rpc.rs` `session already has a non-complete goal`），模型无法主动取消或替换目标。

## 上游命名空间退出出厂产物（2026-09-17）

产物（`ui/dist`）过去沿用上游 npm scope：41 个插件目录、图 id、boot 清单、每个插件内部由
import 路径派生的标识符（`deepseek_ai_*`）以及打包时写入的 region 注释都带 `@deepseek-ai`。
仓是 fork，产物归我们发布，因此统一改到自有 scope。

- [x] `UI-NS-01` `scripts/ui-namespace.mjs` 作为唯一映射源（`UI_NAMESPACE=@xharness`、`UPSTREAM_NAMESPACE`、`distId`、`pluginName`、`isPlugin`、`portableBytes` 用的来源标签）。
- [x] `UI-NS-02` `scripts/rewrite-ui-namespace.mjs` 在装配最后一步执行：迁移插件目录、改写 scope 与派生标识符、重算每个 entry 的 `rev`/`url`、重算 `graph.rev` 并刷新 `index.html` 的 boot 清单；重复执行是空操作，残留 scope 直接抛错。
- [x] `UI-NS-03` `assemble-static-ui.mjs` 末尾调用改写并把 region 注释来源标签从 `deepseek-harness/` 改为 `vendored/`；`sync-workspace-directory.mjs` 的依赖注入表、`rebuild-ui.sh` 的 brand 目录、`ui/plugins/**` 与 `ui/overrides/**` 同步改名；dual-use 补丁（settings 保存提示、workspace 时间戳、attachments、composer、question continuation）改为用 `pluginName()` 比对，装配期（上游名）与出厂后（`@xharness`）两种拼写都能命中。
- [x] `UI-NS-04` 回归：`ui/dist` 内 `@deepseek-ai` 与 `deepseek_ai_` 均为 0；非浏览器 UI 测试 29/30 通过（唯一失败 `test-context-layout` 是本机缺 playwright，master 上同样失败）；服务端真实 Chromium 跑 CI 浏览器清单；真实 Host + 真实页面复验 GoalBar 六条 `/api/goals/*` 仍 200。
- [x] `UI-NS-05` Host 侧厂商耦合清除：删除内置 `reasoning_catalog`（只在 `api.deepseek.com` + 精确模型 ID 生效的冗余回退），思考档位改由配置声明；`config/providers.deepseek.example.json` → `config/providers.remote.example.json`（占位端点 + 显式 `reasoning`），Windows 启动脚本、打包步骤、文档同步；live 验收工作流改为 `live-model-acceptance.yml`（端点/模型为输入，凭据统一使用仓库 Secret `XHARNESS_LIVE_API_KEY`），live 测试、示例与测试夹具改名。详见 PR。
- [ ] `UI-NS-06` 仍是上游语义的名字（不构成依赖，按需处理）：`--dsw-static-deepseek-*` 设计令牌与 `__DSH_BOOT__` 协议名、`--dsh-*` class 前缀；UI 侧 provider/settings id（`deepseek-official`、`llm-deepseek`、`web-search-deepseek`）与 onboarding/搜索文案；必须保留的上游溯源记录（`xharness-api::UPSTREAM_CONTRACT_REVISION`、`docs/compat/*`、`scripts/terminal_bench/official-*`、`THIRD_PARTY_NOTICES.md`）。

- [ ] `UI-NS-05` 仍是上游语义的名字，按层 B/C 后续处理（不影响本项“依赖”目标）：`--dsw-static-deepseek-*` 设计令牌与 `__DSH_BOOT__` 协议名；UI 侧 provider/settings id（`deepseek-official`、`llm-deepseek`、`web-search-deepseek`、`DEEPSEEK_API_KEY`）与 onboarding/搜索文案；Rust 侧 `reasoning_catalog.rs` 的 host/model 白名单；CI `deepseek-live.yml` 与 live 测试；`xharness-api::UPSTREAM_CONTRACT_REVISION`、`docs/compat/*`、`scripts/terminal_bench/official-*` 等上游溯源记录（保留）。

## Token 校准重启恢复（2026-09-17）

规范见 [校准持久化](specs/token-calibration-persistence.md)。

- [x] `TOKEN-CACHE-01` 数值/哈希快照、版本/容量/TTL 校验、损坏退回保守估算。
- [x] `TOKEN-CACHE-02` Host state 独占目录接入共享缓存，模型刷新复用，完整 usage 原子落盘，服务端超限持久化失效。
- [x] `TOKEN-CACHE-03` V100 单测、两种协议模拟 HTTP 重启回归、隐私/隔离/并发/写入失败边界与 Clippy。
- [ ] `TOKEN-CACHE-04` 跨平台 CI、合并发布、已安装 Mac/Web 升级和真实会话重启验收。
- [x] `TOKEN-CACHE-05a` 旧版文本 Chat 历史离线回填：审计 blob 哈希、turn/step 配对、历史 wire 指纹匹配、TTL、去重及 Rust 编码/缓存恢复交叉验证；当前真实会话恢复 32 个数值样本。
- [ ] `TOKEN-CACHE-05b` 新版安装时停机备份并应用候选缓存，真实会话继续请求验收；不把候选文件生成当作已修复运行中的 0.2.19。


## macOS 未公证长期更新（2026-09-15）

- [x] `MAC-UPDATE-01` 发布默认包含两个 Mac 架构预览版，复用长期统一清单；正式公证模式仍保留凭据门禁。
- [x] `MAC-UPDATE-02` 旧测试通道迁移脚本与受限 CI：复用已发布包、旧/新两条签名链、内置通道校验、旧清单变更检查及备份。
- [x] `MAC-UPDATE-03` 无编译合同回归及 CI 接线。
- [ ] `MAC-UPDATE-04` PR 全量 CI 通过、合并、新版双架构 Mac 原生验收与发布。
- [ ] `MAC-UPDATE-05` 旧通道迁移演练后正式推进；本机在软件内检查、下载、确认重启及数据保留验收。
- 规范与操作步骤：[Mac 预览更新通道](specs/macos-preview-updates.md)。

## 推理能力发现与配置恢复（2026-09-14）

- [x] `REASONING-DISCOVERY-01` 同源可配置能力发现、原生档位/请求映射、未知与来源标记、独立有界持久缓存及失败保留。
- [x] `REASONING-DISCOVERY-02` 保存/恢复补回缺失元数据，明确 null 和跨 endpoint/协议/模型隔离；菜单刷新和共享构建资源。
- [x] `REASONING-DISCOVERY-03` 单元、真实 HTTP fixture、Host RPC、配置恢复与打包前端回归。规范见 [推理能力发现](specs/reasoning-capability-discovery.md)。
- [ ] `REASONING-DISCOVERY-04` CI、合并、发布与本机安装验证；源代码完成不代表当前软件已生效。
- [ ] `REASONING-DISCOVERY-05` 更多厂商官方发现端点、非兼容原生协议与连续数值预算控件，逐项验证后接入。


**状态日期：** 2026-09-12
**完成规则：** 只有实现、规范、测试和用户文档全部落地，任务才算完成。ID 永久稳定，
Commit、Issue、PR 应引用这些 ID。

全面复刻的里程碑、依赖关系、当前执行批次和上游同步规则见
[`FULL_REPLICATION.md`](FULL_REPLICATION.md)。本文件保存稳定任务 ID 和验收条件；
`FULL_REPLICATION.md` 是执行顺序和跨模块主控面板。

当前冻结兼容基线为 `deepseek-harness@141eb6fef8`。2026-08-21 已检测到远端 HEAD
`b150a551b8d4`，但在增量目录和兼容测试完成前不移动冻结基线。

## 运行中权限选择（2026-09-12）

- [x] `ISSUE-64` 接受并持久化运行中选择、下一 turn 权限/提示词一致快照，覆盖排队与自动续轮路径；保留当前审批和子 Agent 权限边界。见 [规范](specs/runtime-permission-selection.md)。
- [x] `ISSUE-64-UI` 复用选择器及风险确认，显示保存中/下一轮生效，源码补丁和打包资源同步。
- [ ] `ISSUE-64-RELEASE` 推送跨平台 CI、合并发布、桌面端实机更新验收。

## 显示与计量修复（2026-09-12）

验收见 [314 项远程 Rust 与前端回归记录](reports/issues-57-59-61-20260912.md)。

- [x] `ISSUE-61` 思考/正文/工具参数分离块编号；实时、完成消息、历史统一投影，保留中断思考。见 [规范](specs/assistant-web-projection.md)。
- [x] `ISSUE-57` 超限错误正确报告期望预留和最低输出；两条计量路径回归，预算算法不变。
- [x] `ISSUE-59` 实际/请求前读数独立精度、历史变化提示、前后端 replay 与文档统一。见 [计量规范](specs/context-accounting.md)。
- [ ] `ISSUE-57-61-RELEASE` 推送、GitHub 跨平台 CI、合并与软件安装更新；源代码验收不代表已安装版本已生效。

## 前端闲置会话历史缓存（2026-09-13）

- [x] `UI-CACHE-01` 保留 Session/scope 的历史 LRU，默认 6 个闲置会话 / 64 MiB 估算历史容量；保护当前/运行/待处理任务。见 [规范](specs/session-history-cache.md)。
- [x] `UI-CACHE-02` 清理原始历史与派生视图，按原范围分页恢复；错误可重试、旧请求 generation 防护、cold 重连不复活缓存。
- [x] `UI-CACHE-03` 实际打包 Runtime 27 项断言、V100 Chromium 三次内存对比、本机 WebKit 测试，并接入双引擎 CI。见 [实验记录](reports/session-history-cache-20260913.md)。
- [ ] `UI-CACHE-04` 推送并通过 GitHub CI 后合并发布；已安装 App 的真实多会话内存对照验收。
- [ ] `UI-CACHE-05` 独立评估共享 projection/图片/插件缓存；按锚点区间恢复优化，避免很长历史重新打开时逐页回补。

## 内存与请求审计（2026-09-10）

规范见 [请求审计与内存边界](specs/request-audit-storage.md)。

- [x] `MEM-01` 请求审计无损冷存储、消息级去重，普通 Journal/前端不重复保存完整请求。
- [x] `MEM-02` Session 缓存容量/数量限制、旧审计轻量视图、流式恢复、目标记录偏移读取。
- [x] `MEM-03` Durable Host 移除第二份常驻 transcript；启动计量增量 fold，导出按需完整派生。
- [x] `MEM-04` Context/Harness 按需读取、Diff、错误重试与切换/卸载；边界回归。
- [x] `MEM-05` V100 全仓 564 项/Clippy、Chromium/WebKit、合成历史内存对照；真实 DeepSeek 4 轮及 151 项代码测试 + 12 项独立验收。见 [实验记录](evaluations/memory-audit-20260910.md)。
- [ ] `MEM-06` GitHub 跨平台 CI、合并发布、已安装 App 的同一真实历史升级前后内存验收（不以合成 Linux 数据冒充 Mac 实测）。

## GoalController：外层持续目标推进（产品源码/真实实验已通，待发布）

规范见 [GoalController 设计](specs/goal-controller.md)。复用已完成的 `DONE-33` Goal 状态/RPC，不能将它当作自动执行已经实现。

- [x] `GOAL-01` 中文设计文档：薄外层 Controller、现有 Runtime 复用、状态/报告/事务/恢复和验收契约。
- [x] `GOAL-02a` v2 `goal/execution` 契约与 Session 校验、配套 v2 Goal 快照、JSONL 重放；v1 active 不自动启用，暂停/恢复保留已用轮数。
- [x] `GOAL-02b` v2 状态/未知记录失败关闭门禁与降级说明；安装实例升级验收归 GOAL-08。
- [x] `GOAL-03a` 独立 `xharness-goal` 契约与纯 `decide`：报告作用域、完成确认、等待/暂停原因、稳定续轮 Key 和提交 Fence；V100 18 个测试通过（含状态矩阵）。不执行入队或自动续轮。
- [x] `GOAL-03b` Agent Runtime 事务适配：Session 一致观察、CAS/claim 版本校验、意图与 Inbox 原子提交、claim/start/轮数原子提交、收据去重与用户输入优先。复用原 Driver 与 Loop。
- [x] `GOAL-03c` Host 产品入口：新建/恢复原子 Enable、复用 complete/resume 用户裁决、统一 Admission Fence/RPC、实时投影和启动恢复。
- [x] `GOAL-04` 一个窄报告工具、目标快照注入、完成证据/待确认和阻塞语义，不另加评审模型。
- [x] `GOAL-05` 暂停/恢复/编辑/清除竞态、依赖唤醒、预算收敛、崩溃恢复且不重放未知副作用。
- [x] `GOAL-06` 复用 Goal UI：实时/历史一致、运行与目标状态分离、明确暂停/等待/完成原因。
- [x] `GOAL-07a` V100 Rust 回归、丢失提交回执/过期 claim 等故障测试；当前 DeepSeek 三轮真实编码，106 个产物测试与 12 个独立验收通过，JSONL 恢复及确认完成通过。见 [实验报告](evaluations/goal-multi-round-20260910.md)。
- [x] `GOAL-07b` 产品 Host 恢复/依赖矩阵、Chromium/WebKit 和正式 DeepSeek 三轮实作；115 个产物测试 + 12 个独立验收通过。见 [产品实验](evaluations/goal-product-20260910.md)。
- [ ] `GOAL-07c` 当前分支的 macOS/Windows GitHub CI 与长时间稳定性观测；不能用 Linux 或一次真实实验代替。
- [ ] `GOAL-08` 分支评审/合并、发布与已安装实例升级验收。源码完成不等于用户软件已更新；本次未替换现有 App/Web。

## 执行检查点与精确重复提醒（2026-09-10）

规范见 [执行检查点](specs/execution-checkpoints.md)。

- [x] `RUN-CKPT-01` 1024/64 阶段提醒，完整模型工具响应续行，不注册新工具，保留显式硬上限。
- [x] `RUN-CKPT-02` 精确连续重复：错误 3 次/成功 5 次提醒；工具元数据、shell 归一化、轮询豁免，不拦截执行。
- [x] `RUN-CKPT-03` 临时控制提醒在 ContextPolicy 后、token guard 前注入；状态持久化、实时/历史共享投影及可见停止原因。
- [x] `RUN-CKPT-04` V100 Rust 回归、Node、Chromium/WebKit 及真实 DeepSeek Flash 编程续行测试。
- [ ] `RUN-CKPT-05` 提交评审、跨平台 CI、合并及发布安装验收；本次尚未替换任何已安装实例。

## 统一附件整合（PR #39）

规范见 [附件能力统一整合](specs/attachments.md)。

- [x] `ATT-01` 单一附件库扩展文件类型、只读命名空间、旧图片存储兼容。
- [x] `ATT-02` 混合附件 UI、文件下载/重试、复用 #35 编辑事务和已有 imageInput 配置。
- [x] `ATT-03` 统一 read 图片识别、工具图片核心/重放/Provider/UI 注入，不新增工具名。
- [ ] `ATT-04` 完成本次整合的跨平台 CI 后合并。
- [ ] `ATT-05` 发布安装包并验收已安装 Web/桌面实例；流式上传、文件 API 缓存和回收另行推进。

## 历史消息重新编辑专项（PR #35）

规范见 [历史消息编辑后重新发送](specs/message-edit-resend.md)。

- [x] `MSG-EDIT-01` 停止后的文字/图片消息恢复为新草稿，不修改历史；保留主分支最新 UI。
- [x] `MSG-EDIT-02` 草稿覆盖确认、取消还原、会话隔离、刷新恢复和发送失败保留。
- [x] `MSG-EDIT-03` 复用附件读取与 prompt，增加授权图片引用和运行态/模型能力检查。
- [x] `MSG-EDIT-04` Node、真实 Chromium/WebKit 与远程 Rust 回归覆盖正常和异常路径。
- [ ] `MSG-EDIT-05` 发布包含本功能的新安装包并验收；合并源码不会自动更新已安装软件。

## 桌面搜索与审批专项（2026-09-09）

规范见 [桌面搜索与审批终态](specs/desktop-search-approval.md)。

- [x] `DESKTOP-FIX-01` macOS CI 固定无 PCRE2 的内部 rg，拒绝外部 dylib，增加签名包内真实搜索验收。
- [x] `DESKTOP-FIX-02` glob/grep 区分无匹配与进程失败，保留诊断，不再误报 success。
- [x] `DESKTOP-FIX-03` 审批超时/取消收敛、Host/UI 清理、迟到回答拒绝和旧日志追加式修复。
- [x] `DESKTOP-FIX-04` PR #43 全部跨平台 CI 通过并合并；macOS 0.2.9 已发布、验证签名并替换本机。28 个旧会话及 Provider 配置保留，旧审批追加 cancelled 且 UI history 已返回终态，最终签名包内 rg 实测通过。独立 3082 Web 未重启。

## 请求级上下文计量专项（2026-09-09）

规范见 [请求级上下文计量](specs/context-accounting.md)，证据见 [回放及真实请求报告](reports/context-accounting-20260909.md)。

- [x] `CTX-ACC-01` 请求前估算与 Provider 实际 usage 分离；按请求/模型隔离，修复实际值被估算覆盖。
- [x] `CTX-ACC-02` 完整编码请求特征、配置隔离、内存有界校准、漂移与多模态保守回退。
- [x] `CTX-ACC-03` 可配置计数截止时间/严格模式、瞬态降级与冷却；保留 token guard 和鉴权失败。
- [x] `CTX-ACC-04` 无损解开已知工具结果内层 JSON；正文、诊断字段和持久日志不裁减。
- [x] `CTX-ACC-05` Web/Tauri 共享显示、历史 inspector、重建补丁与自动化回归；真实 DeepSeek 12 轮工具调用及 112 次历史数字回放。
- [x] `CTX-ACC-06` PR #42 全部跨平台 CI 通过并合并；macOS 个人测试版 0.2.8 已签名发布并替换本机，27 个会话/Provider 配置保留，历史实际输入 117,446 验收通过。
- [ ] `CTX-ACC-08` 将本次修复部署到独立 Web / Linux / Windows 已安装实例；本次没有重启 3082 独立服务。
- [ ] `CTX-ACC-07` Provider 专用图片计量/校准；当前明确保守估算，不套用文本模型。

## 多模态附件专项（2026-09-09）

规范见 [多模态消息与持久附件](specs/multimodal-attachments.md)。以下区分源码完成与安装包交付。

- [x] `MM-01` 消息 Text/Image blocks、兼容旧文本日志，替换图片占位符链路。
- [x] `MM-02` AttachmentStore 抽象、正式文件持久化、尺寸/格式验证、会话隔离与分叉预览。
- [x] `MM-03` Chat/Responses 原生图片编码、token count 复用、能力三态与 Debug 图片脱敏。
- [x] `MM-04` 图片 token 估算、上下文引用保留、协议/重试/持久性测试与真实 DeepSeek 两轮读图验证。
- [ ] `MM-05` CI 跨平台回归和合并已完成；macOS 0.2.8 已替换本机；独立服务更新与桌面上传图片端到端验收仍待完成。
- [ ] `MM-06` 附件回收、引用生命周期与失败 admission 的孤儿文件清理。
- [ ] `MM-07` 工具图片输出、PDF/音频扩展与按 Provider 校准图片预算。
- [ ] `MM-08` 自动发现视觉能力；当前提供显式声明/未知状态，不猜模型名。
- [ ] `OBS-EXIT-01` 单独核对 Bash 非零退出码与外层 outcome 的呈现及模型可见语义，不将图片丢失问题归因于工具探索本身。

## 当前状态快照

当前正式 `xharness-host-app` 已具备可日常使用的本地 Coding Agent 主链路：Web RPC、
`DurableLoopAgentRuntime`、双层 Durable Inbox、JSONL Session、File Lease、Prompt/Token Guard、
OpenAI-compatible Chat/Responses、多 Provider/Model 路由、正式 Tool Runtime、动态投影的 11 个
Coding/Job/Web Tool、Linux/macOS/Windows 原生平台、审批恢复、权威 History/Queue 和全链路 Debug Trace。

当前共有 `DONE-01`—`DONE-78` 七十八个完成里程碑。最近一批已经关闭输入在 TTFT 前不可见、
Web 对话重启恢复、模型性能指标投影、长思考输出预算、大 Session 热路径、逐模型推理强度、
Context 占用圆环、Harness 构造视图、Web Fetch 大结果直接挤爆 Context 的回归，以及后台 Job
第一阶段、持久 Schedule、会话权限/推理强度刷新保持、历史 Assistant 请求侧投影与 Tauri
桌面 Sidecar/签名更新基线。

以下能力已经完成主体，不应再描述成“尚未接入”：

- 长生命周期 Agent 已接管正式 Host；输入先 Flush 再确认，Claim 与 `turn/start + user/message`
  原子提交，Pending Turn/Approval 可以在重启后续跑。
- 正式生产 Tool 路径已经由 `xharness-tools::ToolExecutor` 接管；Core 旧 Tool 类型、Request 字段与 Scheduler/Approval 分支已删除（`P0-03`）。
- Provider 原生输入 Token 计数端点已接入；不支持或可重试故障时，经可配置策略降级为 Adapter 校准/保守估算，仍执行预算守卫。
- 自动 Context Compaction 已接入正式 Durable Host：80% Pressure、请求前 Hard Overflow 和
  Provider 无 Delta 的 400 Context Overflow 都会进入有界压缩恢复；成功后重新构造并计量请求，
  Session/Web 使用不删除原 Event Log 的 Surface Replace。
- `web_fetch` 已使用 8,000 字符的确定性 Reader 摘要；历史或当前批次遗留的大 Tool Result 会先
  经过 8,192 字符的请求侧 Pruner，再进入 Compact 与 Token Guard。原始 Session Event 不丢失。
- Platform/Search Readiness 已裁剪每个模型 Step 的工具定义；尚缺 Web Readiness 投影。
- 正式 Host 已实现结构化 Shutdown：关闭 Admission，Signal/Join Agent、Loop、Tool、Job
  和 Process；超时清理会显式报告 Forced Cleanup。
- macOS ARM64 已在原生 GitHub Runner 运行 Workspace、FS、Process、PTY、Seatbelt 测试并生成
  未签名构件；剩余是 Live Provider、签名、公证和安装验证。
- 当前 XHarness Web 源插件、品牌覆盖、重建脚本和可直接部署的静态 Bundle 已与 Rust 后端收敛到
  同一仓库的 `ui/`；Fresh Clone 不再依赖本机相邻的旧 `x-harness` 工作树才能启动网页。

当前最短阻塞链调整为：**大结果持久 Spill/Reference 与 Pruner Replace → Credential Reference/配置 → 远程 Web Auth → WebSocket Cursor Resume →
macOS 签名/公证与发布验证**。手动 `/compact`、独立摘要 Purpose 路由和精确 Tokenizer 作为
Context P1 后续并行推进；MCP、Skills、LSP、Subagent 和 Workflow 不阻塞本地单用户 Coding Agent。

## 已完成基础能力

- [x] `DONE-01` Provider-neutral 流式 Loop 与多 Step 工具执行。
- [x] `DONE-02` Chat Completions 和 Responses SSE Adapter。
- [x] `DONE-03` 运行时 Steering、Injection、Pause/Resume、Cancel、Approval。
- [x] `DONE-04` Append-only 强类型 Session Log 和内存 CAS Store。
- [x] `DONE-05` 跨进程加锁、可恢复崩溃尾部的 JSONL Store。
- [x] `DONE-06` 正式 Tool Registry、Schema 校验、Middleware 和 Policy。
- [x] `DONE-07` 直接 Argv Subprocess Runtime、有界输出与清理。
- [x] `DONE-08` Linux/macOS Workspace FS 与 Observation CAS。
- [x] `DONE-09` Linux Bubblewrap、macOS Seatbelt 和平台抽象。
- [x] `DONE-10` 按 Owner 隔离的持久 PTY Runtime。
- [x] `DONE-11` 匿名有界 Web Fetch 和可插拔 Search。
- [x] `DONE-12` 标准 11 个 Coding/Job/Web Tool；旧六个 Terminal Tool 已退出默认模型面。
- [x] `DONE-13` 真实 V100 Qwen 工具 Loop：模型 → 审批 → 写入 → 重放 → 最终回答。
- [x] `DONE-14` 每 Crate 规范和总路线图。
- [x] `DONE-15` Web 线协议第一阶段：52 RPC、四象限信封、Mux/Host Frame、HTTP、
  下行 WebSocket、`/api/respond`、Export/Static 路由骨架。
- [x] `DONE-16` Web Host 基线：52 RPC 全部有状态行为；真实 Loop Turn、原生工具、
  审批响应、Mux/Host 事件投影、JSON Export 和 Loopback Server Binary 全部接通。
- [x] `DONE-17` Context 第一阶段抽象：独立 `xharness-context`、一次性 Surface、Edit 来源
  范围校验、Policy 版本与 Request Header 审计。
- [x] `DONE-18` Host 组合解耦：`xharness-host` 只保留 Provider/平台无关控制面，
  `xharness-host-app` 组合 OpenAI Adapter、Server、Platform、Job、Web 和原生工具；
  Host 可显式注入 ContextPolicy。
- [x] `DONE-19` Host Turn Runtime 解耦：定义 `AgentRuntime`、`AgentTurnRequest`、
  `RunningTurn` 和 `ModelRoute`，BasicHost 不再直接持有 Provider/ToolFactory/ContextPolicy 或
  创建 Loop；`LoopAgentRuntime` 作为当前兼容适配器。
- [x] `DONE-20` Apple Silicon 原生 CI：在 GitHub `macos-15` ARM64 Runner 上执行整个
  Workspace 的 Check、Test、Clippy，真实覆盖 FS Symlink Race、Process Group、PTY 和
  Seatbelt 隔离，并生成带 SHA-256 的 `xharness-host-darwin-arm64` 构件。
- [x] `DONE-21` Web Full access 权限预设：接通 `permissions` Projection、Schemastery
  Settings、`commands/list`/`commands/execute` 动态 Remote；前端一次风险确认后，Session 使用
  `danger-full-access + never`，原生工具获得系统范围文件/进程能力且不再逐工具审批；Full access
  已从 `SandboxMode` 移出，只绕过权限隔离，不绕过 `ProcessRuntime`。
- [x] `DONE-22` Web 重启基线工作区：Host 启动时把 canonical cwd 注册为
  `workspace-default`，避免内存状态重置后工作区选择器为空、Composer 看似无法点击。
- [x] `DONE-23` Web/Full access 发布回归：真实 Host 子进程原端口重启后恢复默认 Workspace
  和 WebSocket Carrier；Full access 验证 Workspace 外绝对路径读写、Loopback 网络、Timeout/
  Cancel 仍走受管 Process Group；真实 Chromium 覆盖风险确认取消/确认，并在 TCP 承载连续失败
  至少 8 次后重新拉取 Host、Workspace、Session、History、Settings 与权限投影。
- [x] `DONE-24` 冻结上游兼容 Catalog v2：机器可读记录 52 固定 RPC、26 动态 Typert RPC、
  Mux/Host Frame、转发事件、48 Session Event、Tool、四类 Prompt Component、Settings、
  Service Definition/Provision、Preset 和 Package；生成器对重复目录和无法解析的 Remote fail fast。
- [x] `DONE-25` 持久 Host 启动恢复第一阶段：`Store::list_headers` 可验证枚举 Memory/JSONL
  会话；Host 从强类型日志重建 Session、History、模型路由、Workspace 归属和 Durable Queue；
  恢复 Worker 必须先为每个稳定输入 ID 订阅，再显式 Wake，未领取输入续跑时不重复 Append；
  真实 Host 子进程在同一状态目录重启后仍能列出 Session 和 Assistant History。
- [x] `DONE-26` Prompt Admission 持久回执：`session.prompt` 与 `subagent.prompt` 在附件物化和
  Runtime 调用前，以 RPC ID + 规范化 Payload SHA-256 做会话内幂等判定；并发同 Payload 只
  Admission 一次，不同 Payload 复用 ID fail closed。回执从完整 `agent/inbox/spliced` 历史
  重建，成功响应丢失、消息已消费或 Host 重启后重试都不会重复插入输入。
- [x] `DONE-27` 七个持久切点的确定性恢复矩阵：Admission、Claim、Request Header、Tool Call、
  Tool Result、Step End、Turn End。已证明未闭合 Turn 变为 `Interrupted`、已落账 Tool Call 只产
  `OutcomeUnknown` 而不重放、权威 Tool Result/Completed Turn 保持不变、原输入只派生一次。
- [x] `DONE-28` 八点真实 SIGKILL 矩阵：独立子进程使用正式 JSONL Store，在 Admission、Claim、
  Request Header、Tool Call、Approval Asked、Tool Result、Step End、Turn End 写入 Ready Marker
  后由父进程发送 SIGKILL；随后在同一 State Dir 重启 Durable Host/Core。矩阵验证 Admission
  不丢不重、未审批 Tool 不执行、未知 Tool 不重放、Interrupted/OutcomeUnknown/权威终态符合规范。
- [x] `DONE-29` Web History 权威投影：Durable Runtime 暴露不可变 Session Cut，History 查询和
  Driver 按 Session Sequence 刷新同一纯投影；运行中与重启后的 Events/Projections 逐字相等，
  User 的结构化 Content、Source 与 Timezone 从 Inbox 元数据恢复。内存 Event DTO 不再是正式
  History 真源。
- [x] `DONE-30` Approval/Provider Retry 持久控制事件：新增强类型 `approval/asked`、
  `approval/decided`、`llm/retry`、`llm/retry-started` 及生命周期校验；审批使用独立 ID，Asked/
  Decided 在工具副作用前 Flush，Provider Retry 在下一次 I/O 前以稳定链 ID 落账；Web History
  从同一权威 Session 投影冻结字段。该里程碑把 48 个冻结事件的强类型覆盖推进到 16 个。
- [x] `DONE-31` Session 创建与权限命令持久化：Durable Runtime 提供 Turn 外强类型 Event CAS/
  Flush Seam；创建时持久化 Agent Preset、Permission Preset、Sandbox Mode 与 Approval Policy，
  `/permission` 的 Command Run、策略三元组和 Command Done 按顺序落账。Full access 的冻结线值修正
  为 `danger-full-access`，Host 重启从日志恢复权限而非退回默认。48 个冻结事件当前覆盖 22 个。
- [x] `DONE-32` Session Title 与 Agent Preset 持久化：`session.rename` 写入强类型、log-only、
  latest-wins 的 `session/title`；`agentPreset.select` 复用 `agent-preset/selected`。两者均经过
  Per-session Admission Fence 和 Flush Barrier 后才更新内存投影，重启从 Session Log 折叠恢复；
  运行中 Rename 被 Core 视为允许的外部控制事件。48 个冻结事件当前覆盖 23 个。
- [x] `DONE-33` Goal 全快照事件与恢复：6 个 Goal RPC 经 Per-session Admission Fence 写入
  `goal/change`；Create/Edit/Pause/Resume/Complete 使用 version 1 全快照，Clear 使用递增 Revision
  Tombstone。Session 校验 ID/Revision/Phase/时间和定义迁移，History/Projection 与重启从同一日志
  折叠，默认 `maxGoalRounds=256`。48 个冻结事件当前覆盖 24 个。
- [x] `DONE-34` Idle Plan Mode 持久化基线：动态 Command 目录暴露 `/plan`，空参数进入、`off`
  退出；成功选择以 `command/run → plan/mode → command/done` Flush 并投影 `{active,pending}`，
  重启从最后事件恢复。运行中 Pending Pre-step、附带 Message/Image Steering 和 `exit_plan_mode`
  仍归 `P0-14/P1-01`，当前 fail explicit 而非静默丢输入；加上 `DONE-57` 的四个 Compaction
  事件和 `DONE-66` 的 `request/context` 后，48 个冻结事件当前强类型覆盖 30 个。
- [x] `DONE-35` 真实最小 Coding System Prompt：新增 `xharness-prompt` 确定性有序组装器，
  将选中 Preset、权限、Workspace、Coding 工作流和 Plan Policy 组装为每轮第一个 System
  Message；Request Header 保存 Assembler/Assembly/Section/System Hash 与 Tool Definition Hash，
  Transcript 不保存 System。Chat Completions、Responses、Host Provider 边界和重启 Pending Turn
  均有测试；Cancel 在 Turn 已结束时改为幂等，避免控制终态竞态。
- [x] `DONE-36` 请求前上下文硬预算：新增 Provider-neutral `xharness-token` 与可替换
  `TokenMeter`，生产 Host 配置模型时强制显式声明 Context Window；Core 在 Context Surface
  完成后、Provider I/O 前计量 System/消息/工具/协议开销并预留输出与安全余量，预算报告写入
  Request Header。Chat/Responses 分别下发 `max_tokens`/`max_output_tokens`；固定
  `64196 > 53248` 回归验证 Provider Attempt 为零。当前保守 UTF-8/JSON Byte Meter 保证宁可
  过估，不把精确 Tokenizer 绑定到 llama.cpp；自动 Pressure/Overflow 已在 `P1-03` 接线，请求侧
  通用 Pruner 已由 `DONE-68` 接入。精确 Adapter、手动 Compact 与持久 Pruner Replace 仍归该项。
- [x] `DONE-37` 模型 `read` 分页：默认页从 256 KiB/2,000 行降为 32 KiB/400 行，暴露
  `offset`、`start_line`、`limit`、`line_limit` 与 Opaque `next_cursor`。Cursor 固定原页限制并
  绑定完整文件 SHA-256，文件变化后继续读取 fail stale；底层仍完整计算 Version 并保持
  Observation CAS。测试覆盖 Line 起点、连续 Cursor、UTF-8 边界、Cursor Roundtrip、版本变化
  和模型工具真实两页读取。
- [x] `DONE-38` 确定性 Tool Result Head/Tail Reduce：超过单结果模型预算时优先生成
  `head_tail/v1` JSON Envelope，保留 UTF-8 安全头尾、原始 Byte 数、遗漏 Byte 数和 SHA-256；
  相同输入逐字稳定，极小预算继续使用合法 JSON 前缀后备。原始 `ToolResult` 仍通过运行事件交给
  宿主，但持久内容寻址 Spill/Reference 与历史 Surface Replace 尚未实现。
- [x] `DONE-39` 原生平台 Readiness 与模型工具动态投影：`NativePlatform` 对同一 Workspace/
  Permission 组合只 Probe 一次并缓存强类型 `CapabilityReport`；Host 在每次模型 Step 前根据
  Sandbox 与 Search Provider 状态裁剪工具。受限进程不可用时移除 `bash/glob/grep`，仍保留
  Job 控制器收敛历史任务；未配置 Search 时移除 `web_search`；Full access 明确报告
  `none-full-access`，不会为探测偷偷创建 Sandbox。确定性测试覆盖不可用能力的模型可见子集。
- [x] `DONE-40` Tool 双重身份与 Provider Replay：每个调用分别持久化全 Session 唯一的
  Harness `execution_id` 与 Provider 原生 `provider_call_id`；Journal、Approval、Tool Result 和
  Web 审计继续使用前者，Chat/Responses 的 Assistant Tool Call 与 Tool Output 统一使用后者。
  旧日志缺少原生 ID 时确定性回退到 Execution ID，Responses Opaque Item 与
  `function_call_output.call_id` 不再错配。
- [x] `DONE-41` 有界 Loop Event Journal：删除无界 MPSC，改为按事件数和序列化 Byte 双预算的
  非阻塞 Ring Journal。慢消费者收到强类型 `events_lagged { missed, resume_seq }`，可通过
  `subscribe_events_from(resume_seq)` 从最早保留事件继续；完全不消费事件不会阻塞 `result()`，
  单个超大事件也会被逐出而不是突破内存预算。Drop、Cancel 和工具清理竞态保持确定终态。
- [x] `DONE-42` Pending Approval 跨重启续跑：Session 纯投影区分“尚未越过审批边界”和
  “工具结果未知”；Core 在原 Turn/Step 上重发相同 Approval ID，只有再次收到 Allowed-once 才
  执行，拒绝则写回 Tool Error。Agent 在 Host 订阅后显式唤醒恢复 Turn，Web 重新生成可回答的
  `approval/requested` RPC；Provider 只从下一 Step 继续，既不伪造新 User Turn，也不把未批准
  Tool 写成 `outcome_unknown`。测试覆盖 Core、Agent/Host 和 Provider Native Call ID 重放。
- [x] `DONE-43` 持久 Web History 游标与有界尾缓存：Durable `session.history` 不再从
  `SessionRecord.events` 切片，而是按 `beforeSeq + maxMessages` 直接查询并纯投影权威 Session
  Log；Host 仅保留按 Event 数和序列化 Byte 双预算约束的连续尾部，Sequence 不因驱逐重编号。
  Session Search 与 Fork 同样读取权威日志。测试覆盖尾缓存已驱逐 37/42 个事件后仍能取回完整
  42 个事件、跨页 Cursor 严格递减，以及 Host 重启前后等价。
- [x] `DONE-44` Host Control Log 与首批通用 Mutation Receipt：新增 `xharness-control`，以
  Append-only Event、CAS Revision、跨进程锁和 JSONL Crash-tail 恢复持久化 Workspace
  定义/标题/排序/Session 排序/归档以及 Settings 文档。Workspace 6 个变更 RPC 与 Settings 3 个
  变更 RPC 把状态事件和 `{rpcId, method, fingerprint, response}` 在同一 Revision 落账并 Flush；
  同 ID/同 Payload 跨并发和重启逐字重放原响应，不同 Payload fail closed。日志递归拒绝非空
  Password/Token/Secret/API Key 字段，真实 Host 子进程重启验证自定义 Workspace、Settings 和回执。
- [x] `DONE-45` Session 级原子 Mutation Receipt：新增内部、log-only 的
  `xharness/mutation-committed`，状态事件与 `{rpcId, method, fingerprint, response}` 在同一
  Session CAS Revision 落账并 Flush。`session.rename`、`session.selectModel`、
  `agentPreset.select` 和 6 个 Goal RPC 共 9 个变更接口支持同 ID/同 Payload 跨重启逐字重放，
  ID 冲突 fail closed；模型选择以 `session/model-selected` latest-wins 事件恢复，不再依赖最近一次
  Request Header。Web History 只投影隐藏的回执占位，不暴露 Fingerprint 或 Response Body。
- [x] `DONE-46` Durable Inbox 权威 Web Queue：`session/queue` 不再读取 Host Driver FIFO，而是从
  Session Log 的完整 `agent/inbox/spliced` 历史折叠 `next-turn + next-step`。三种 Placement 固定为
  `queued/steering/context`，每次 Insert/Edit/Remove/Claim 后发送完整快照；Mux 重连为所有 Session
  发送 subscribed/projection，并为非空 Inbox 发送 Queue Baseline。`session.updateQueue` 先修改
  Durable Inbox，Claim 竞态返回 `queue-item-not-found`，非文本 Edit 返回冻结 Attachment Error；
  Host FIFO 只保留 RunningTurn Attachment，不再是真源。
- [x] `DONE-47` Tool Execution ID 跨层贯通：Core 在 Tool Call 落账后把同一个 Durable
  `execution_id` 绑定到 `xharness-tools::ToolRequest`，因此 Registry、Middleware、Approval、
  Handler、Observer 和 Result 不再另造进程内身份。Provider 原生 `provider_call_id` 仍只用于
  线协议重放。已覆盖非法外部 ID、Executor 原样传播以及 Journal → Runtime Handler 的一致性回归。
- [x] `DONE-48` 正式 Tool Batch Scheduler 与副作用边界：`xharness-tools` 新增 Model-order
  Batch Runtime，统一执行全局并发上限、Parallel、Keyed FIFO 与 Exclusive Barrier；完成事件按
  真实完成顺序输出，最终 Result 按原始调用顺序重排。新增 `ToolLifecycle::started`，只有 Policy、
  Approval、Concurrency Admission 和宿主 Durable Start Acknowledge 全部成功后 Handler 才能产生
  副作用；Lifecycle Error/Panic 均 fail closed。Batch Drop/Cancel 会广播到全部 Call Token，调用方
  可继续等待 Result 收敛。该 Runtime 已接管 Core 全部新执行与恢复执行路径。
- [x] `DONE-49` 正式 Tool Runtime 接管生产 Host：`LoopRequest` 新增互斥的
  `tool_executor` 边界，模型 Tool Definition、Context/Token Budget、Request Header、Fresh Batch 与
  Pending Approval Recovery 均读取同一个 Registry/Executor。Core 通过 Channel Bridge 把 Web
  Command 转为正式 Approval Provider，并在 `ToolLifecycle::started` Ack 前发布 Tool Started；
  Completion 真实顺序投影、Result 模型顺序落账。`SessionToolFactory` 现在返回 Executor，原生
  Tool Bundle、Full Access 裁剪和 Durable Host 默认全部走新路径；`core_specs()`、自动批准适配器及
  Coding Tools 对 Core 的生产依赖已删除。
- [x] `DONE-50` 正式 Tool Runtime 回归矩阵：Core 的恢复审批、并行审批、拒绝、重复 Provider
  Call ID、取消和 Crash Cut 已迁移到 `ToolExecutor` 路径；补齐 Registry Definition 投影、未知
  工具、坏 JSON、Schema Error、空 Batch、重复 Order、零并发和 Cooperative Quiescence 测试。
  测试发现并修复了 Core Bridge 串行等待单个审批导致第二个并行审批永远无法投影的问题；现在
  多个 Approval 先全部发布，再按 Execution ID 独立决议。取消会关闭所有已落账 Approval，并在
  返回 Run Result 前等待正式 Batch 收敛；等待 Lifecycle Ack 时取消也不会启动 Handler。
- [x] `DONE-51` 多 Provider/Model Registry 基线：一个 Durable Runtime 可注册多条公共路由，
  Web 暴露模型目录并在选择/启动前 fail closed；每条路由独立绑定 Adapter 与 Token Guard。
- [x] `DONE-52` Provider 原生输入 Token 计数：Chat 使用 `/chat/completions/input_tokens`，
  Responses 使用 `/responses/input_tokens`；按最终结构化请求计数，404/405/501 能力缺失会缓存并
  回退保守 Meter，其他错误不静默降级。
- [x] `DONE-53` Durable 流式检查点：Assistant Text/Reasoning/Tool-call Chunk 在 Session 中按
  最多 64 个事件或 250ms 批量落账，Host 从权威序列刷新投影，在不逐 Token `fsync` 的前提下保持
  Provider 流式节奏和崩溃可恢复性。
- [x] `DONE-54` Bash Pipeline 失败传播：One-shot Bash 默认启用 `pipefail`，`git push ... |
  tail` 等管线不再以最后一个过滤命令的零退出码掩盖前序失败，并有真实工具回归。
- [x] `DONE-55` Provider-neutral Compaction 规划器：默认阈值/保留比例、Pressure/Overflow/Manual
  规划、Tool Call/Result 安全切点、Unicode Tool Result Pruner、Checkpoint Frame 和 Summary Trait
  已完成；生产自动接线由 `DONE-57` 关闭。
- [x] `DONE-56` Full Debug Trace 全链路接线：默认 Noop 零 I/O；Full 模式以全局 Sequence、
  Secret Redaction、有界 Blob 和显式 Flush 记录 Host/Core/Provider/Tool/Process/PTY/Sandbox/Web/
  Server，跨层测试已覆盖同一 Scope 关联。
- [x] `DONE-57` Durable 自动 Context Compaction：正式 Host 默认安装
  `CompactionConfig::default()`；Core 在 80% Pressure、请求前 Hard Overflow 和 Provider 无 Delta 的
  400 Context Overflow 三个入口执行有界恢复。Session 强类型记录 `compaction/start|summary|end|prune`
  与 Checkpoint `surfaceReplace`，成功批次原子替换模型 Surface 而不删除源 Event；失败/中断写错误
  End，重启闭合悬空 Start。每次成功 Replace 后重新组装、原生计数并走 Token Guard；Web 投影
  `surfaceOp={op:replace,start,end}` 和 `sourceEventSeqs`。WZU_Server 全 Workspace Test、Check、
  Clippy `-D warnings` 与 Fmt 均通过。
- [x] `DONE-58` 结构化 Shutdown/Quiescence：正式 Tool Batch 取消会 Signal 并 Join，
  不合作 Handler 返回 `CleanupTimeout` 并使 Loop 显式 Failed；Process Supervisor 在
  Runtime Abort 时同步 KILL 受管 Group，输出 EOF 有界收敛。Agent Supervisor 关闭新
  Admission，用共享 Deadline 收敛所有 Worker；Host 在 SIGINT/SIGTERM 后再关闭共享
  PTY Registry 并 Flush Shutdown Trace。测试覆盖 Runtime Drop、逃逸 Session、不合作
  Handler、活动 Provider Stream、Bash Leader/Descendant、多 PTY 和真实 Host SIGTERM。
  WZU_Server 全 Workspace Test、Check、Clippy `-D warnings` 与 Fmt 均通过。
- [x] `DONE-59` 可重复 Compact 消融基线：正式 Host 新增 `default/off/JSON` 策略选择，明确
  `auto=false` 只关闭 Pressure、`off` 才是真正无压缩；标准库 Runner 通过正式 Web RPC 为四个
  Variant 创建独立 Host/State/Session，落盘权威 History、Debug Trace、Usage、Compact 事件、
  质量和退出状态。RTX 4080 上 Qwen3.8-27B 四组烟测均精确回忆 3/3 事实，Auto 两组各完成一次
  Durable Replace，四个 Host 均正常退出；证据固化在
  `docs/evidence/compaction-qwen-4080-20260825/`。正式性能结论仍需多任务、多 Seed、轮换顺序和
  Variant 间 Provider Prefix Cache 冷启动。
- [x] `DONE-60` macOS LaunchAgent 工具依赖闭环：受管 Tool PATH 不再照抄 launchd 的最小
  `/usr/bin:/bin`，而是优先 Host 同目录并补齐用户/系统常见目录；ARM64 Artifact 同目录打包
  `xharness-host + rg`。本机已用双 V100 Qwen3.8-27B 真实执行 `glob`，返回 24 个 Cargo Manifest、
  `tool/result.ok=true` 并完成最终回答；当前 LaunchAgent 也已使用 bundled ARM64 ripgrep。
- [x] `DONE-61` Web 模型性能确定性投影：Host 新增 Provider-neutral 的 Usage Mapper 与纯
  `tokenUsage/sessionStats` 折叠器，统一把旧 snake_case 和新 camelCase Usage 输出为冻结的
  Web camelCase 契约；Live、History、Restart 与 Ephemeral 路径共用同一算法。TTFT、Decode
  Token/s、Token/Cache Accounting、LLM/Tool Duration 均从权威 Session Event 重建，同一步
  Usage 采用后样本替换而不重复累计；缺失 Provider Usage 时不伪造吞吐。WZU_Server 全
  Workspace Fmt、Check、Test 和 Clippy `-D warnings` 已通过；GitHub Linux 与原生 macOS
  ARM64 CI 通过并生成 Release。新版本已部署到本机 3082，双 V100 27B 真实流与强制重启前后
  Projection 等价验证均通过。
- [x] `DONE-62` Web Context Inspector：Core 每个 Step 的 `request/header` 已保存经过
  ContextPolicy、压缩和 Token Guard 后的完整 `input/tools/options`；Host 同时投影上游兼容的
  `config/system/tools` 与 XHarness 审计扩展。前端在 `Chat | Trajectory` 后注册第三个
  `Context` Tab，支持按请求切换、实际发送、压缩前/后、Diff、搜索、Token Budget、Tool Schema、
  Raw JSON，以及 System/人类/Reasoning/回答/Tool Call/Tool Result/压缩 checkpoint 颜色分类。
  产品插件进入静态模块图，具备 Node 烟雾测试和浏览器真实 Session 验证；规范见
  [`specs/context-inspector.md`](specs/context-inspector.md)。
- [x] `DONE-63` 长思考动态输出预算与安全续写：模型路由把目标输出、最小输出保留和安全余量
  分离，Token Guard 根据本次真实输入生成 `selectedOutputTokens`；默认允许 2 次新请求续写和
  131,072 Token 的 Turn 级累计上限，不设置独立的小 Reasoning 硬限制。`Length` 已成为
  `MaxTokens` 一等终态，部分 Text/Reasoning 正常持久化，残缺 Tool Call/Replay Envelope 禁止
  执行；纯思考、正文和 Tool Call 分别使用安全恢复指令。Host/Web 投影上游兼容的
  `turn/end: max-tokens`，不再显示通用失败。V100 路由目标 49,152、最小保留 16,384、安全余量
  4,096；4080 路由目标 16,384、最小保留 8,192。WZU_Server 的 Token/Core/Session/Host/
  Host-app 定向测试全部通过。
- [x] `DONE-64` 大 Session 流式热路径治理：Session 的不可变 Cut 使用 `Arc<Vec<Event>>`
  共享已校验前缀，单写者 Append 通过 Copy-on-write 保持旧快照隔离；JSONL Store 在进程内保存
  经文件身份、长度、纳秒时间戳和有界内容采样校验的写穿快照，Append/Flush 可移动热快照，避免
  每个检查点重新解析或克隆整份日志；跨进程 Advisory Lock 与磁盘 Revision 仍是 CAS 真源。Core 在持久化前合并相邻
  Text/Reasoning Delta，并以 64 个原始碎片、4 KiB 或 250 ms 任一阈值触发检查点。Web History
  对已有完整 Assistant Message 的 Chunk 只保留最终消息，对尚未完成 Step 的同类 Chunk 合并为
  最大 64 KiB 的投影块；连续尾缓存用隐藏占位保持 Sequence 不变。修复针对东京部署中单会话
  11.94 MiB、44,881 Event（其中 44,557 Chunk）导致的反复全量回放和浏览器超大事件列表。
  冷启动解析先校验每行 Batch Revision，再对汇总后的完整 Cut 只运行一次 Session 生命周期校验，
  不再为每行重复校验此前全部前缀。
- [x] `DONE-65` 精确模型推理强度：`ModelDescriptor` 为每条 Provider/Model 路由保存有序
  Effort、说明和默认值，Web `session.models/llm.models` 只投影当前模型真实能力，现成模型菜单
  动态显示并持久化选择。Session 选择与 Runtime 在写事件和网络前拒绝未知 Effort；Core 把
  Opaque ID 贯穿每个 Provider Request，OpenAI-compatible Adapter 用每档 `request_patch` 映射
  `reasoning_effort`、`chat_template_kwargs` 等端点原生字段，并禁止覆盖消息、工具、流和输出预算
  等 Core 所有字段。默认值进入新 Session 和 `request/header`，模型切换不会继承旧强度；配置、
  Registry、RPC、恢复与 Wire 映射均有回归测试，WZU_Server 全 Workspace Fmt、Check、Test 和
  Clippy `-D warnings` 通过。
- [x] `DONE-66` 输入框 Context 占用圆环：Core 在路由或容量变化时持久化标准
  `request/context`；Host 新增可重建、可增量发布的 `contextPressure` Projection，并为旧
  `request/header.options.tokenBudget` 日志保留容量迁移。Context 工具栏移除重复 Token 文本，
  直接启用聊天输入框原生无文字圆环及其按需详情面板。
- [x] `DONE-67` Harness 构造视图：Context 页的同权胶囊改为默认折叠的单行请求详情，
  Tool Definitions 移出模型输入正文；新增第四个 `Harness` Tab，从选中 RequestHeader 快照
  重建 Prompt Assembly、最终 System Prompt、可搜索 Tool Registry、Context Policy 和 Runtime
  Route。浏览器已验证 13 个真实模型可见工具与 4 个 Prompt Section，无新增后端协议。
- [x] `DONE-68` Web Reader 摘要与当前批次大结果保护：`web_fetch` 的模型可见预算从 100,000
  字符降为 8,000，HTML 在 Markdown 前移除 Script/Style/Template/SVG 等噪声，并用确定性
  `reader-extractive/v1` 按标题、章节、表格、前部和可选 Focus 选段；响应报告 Source/Extracted
  字符与算法版本。正式 Host 同时从 `IdentityContextPolicy` 切换到 8,192 字符的
  `ToolResultPruningContextPolicy`，旧 Session 或最新未可 Compact 的大工具结果在请求 Surface
  上形成 `tool_result_pruned/v1` Envelope，原始日志与 Tool Call ID 不变。该修复针对真实回归：
  Codeforces 抓取读取 261,147 Byte、写回 102,434 Byte，连续两次 Compact 后仍以
  `120811 > 118784` 被请求前 Token Guard 拒绝。
- [x] `DONE-69` Web Fake-IP 与 macOS `/dev/null` 修复：公共域名被 Clash/Surge TUN 解析为
  `198.18.0.0/15` 时，不再误报 Private Target；Host 引入加密公共 DNS 验证并把真实地址固定到
  HTTP Client，直接 Reserved/Private IP 仍拒绝。`web_fetch` 明确独立于 Session 进程权限，
  Workspace-write 下可用而 Bash 网络仍隔离。Seatbelt 仅额外允许精确的 `/dev/null` 字符设备
  写入，修复 `command 2>/dev/null` 的假失败，不扩大 Workspace 外普通文件写权限。
- [x] `DONE-70` 通用后台 Job 第一阶段：新增生产者无关 `xharness-jobs`，实现
  Reserve-before-side-effect/Commit、按 Kind 单调 ID、Owner Fence、`running/stopping/completed/
  killed/failed` First-wins、每 Owner 10 个活跃任务、100 条终态保留、每流 256 KiB 未读 Tail、
  Wait Timeout、幂等 Kill、Cancel Hook 异常零状态变更、Lease Drop Force-fail、三类 Lifecycle
  Broadcast 与有界 Shutdown。`bash` 新增 `run_in_background=true` 并用 Process Live Observer
  增量喂入 Job；模型新增 `job_output/job_list/job_kill`，旧六个 `terminal_*` 从默认 Tool Schema
  移除；Host 同步注入 Job 跨 Step 选择规则，模型输出隐藏 Owner/PID/通知账本。WZU_Server 定向
  测试覆盖全部五态、动态配置、Owner/容量/历史保留/UTF-8/丢输出、非零退出、Kill、进程树和
  Shutdown Cancel 异常/超时 Corner Case，并提供可选 DeepSeek PTY/nohup 行为测试。2026-09-01
  DeepSeek V4 Flash 实测正确选择 `bash(run_in_background=true) -> job_output(wait=true)`，未生成
  `nohup/&/PTY/screen/tmux`。
- [x] `DONE-71` 持久 Schedule：复用正式 Tool Registry、Session Log 与 Durable Agent，新增
  `schedule_create/list/delete` 和版本化 `schedule/change`；支持 `after`、显式 Offset/IANA 时区
  `at`、最小 5 分钟固定相位 `every`、DST 校验、离线 latest-only catch-up、ID 永不复用和稳定
  Delivery Message ID。Timer 是可丢弃投影，Host 重启会重挂或补发 overdue；到期只在 Idle 边界
  以注入安全 reminder followup 唤醒 Agent，并沿普通 RunningTurn 实时投影到 Web。远程测试覆盖
  规则校验、时区、调度、Busy/Idle、恢复和 Host 背景回合；模型行为验收保留为部署后测试。
- [x] `DONE-72` 会话选择刷新保持：模型恢复先折叠最后一个显式 `session/model-selected`，只有
  旧日志不存在显式选择时才回退最后一个 `request/header`，避免 Provider 未回写 Effort 时把
  用户选择的推理强度恢复成模型默认值；真实 Web 权限回归新增浏览器 Reload，Composer 在 Turn
  运行期间禁用权限切换，避免 Host 拒绝策略热切换后 UI 暂时显示未落盘的 Full access。
- [x] `DONE-73` 历史 Assistant 请求侧投影：正式 Context Policy 升级为
  **历史记录：以下 v2 参数投影已于 2026-09-11 被 v3 撤回；当前工具参数逐字保留，
  防止省略标记被照抄成写入。旧测量仅保留作审计，见 `docs/specs/context.md`。**
  `context-history-pruning/v2`；只有匹配到后续 `ok=true` Tool Result 的大型 `write.content`、
  `edit.old/new` 才替换成带字符数、UTF-8 Byte 数和 SHA-256 的
  `tool_arguments_pruned/v1`，失败、未完成和坏 JSON 调用逐字保留。最新 User Turn reasoning 与
  opaque Provider Item 保留，旧 Turn plaintext reasoning 从一次性 Surface 移除；Responses
  `function_call` 与 provider-neutral Tool Call 同步投影，Call ID、Result 和源日志不变。
  WZU_Server 32 Tool Call Release 消融把请求消息从 1,136,998 Byte 降至 42,150 Byte
  （-96.29%），Policy CPU 从每次 0.159 ms 增至 3.639 ms；全 Workspace Test、Check、Clippy
  `-D warnings` 通过。当前真实会话最后一次请求重放估算从 90,363 Byte 降至 35,699 Byte
  （-60.49%）。真实 Provider TTFT/Prefill A/B 仍按 `REL-05` 单独验收，不能由 Payload 降幅替代。
- [x] `DONE-74` Bash Tool View：Rust Host 对权威 Session、旧内存适配器、Live Mux、分页 History
  和重启日志统一投影上游 `callView/resultView.card="terminal"`。Call 保留 command/cwd/description；
  前台结果从结构化 Metadata 恢复 stdout/stderr/exitCode/signal，并明确标出截断。后台 Job、坏 JSON、
  错误形状均 Fail-closed 回退通用卡片；旧日志可从 JSON Tool Result 恢复。WZU_Server 回归覆盖运行中、
  完成、非零退出、截断、后台结果、坏参数、Legacy Live/History 等边界。
- [x] `DONE-75` Tool Arguments Durable Coalescer：同一 Turn/Step/Tool Index 且兼容 ID/Name 的相邻
  参数碎片在 Checkpoint 内合并；Direct Embed 仍收到每个实时 Delta，冲突身份 Fail-closed 分帧。
  DeepSeek V4 Flash 真实 Coding Run 中 4 个 Tool Call 和外部验收均通过，实时 Delta 110 条、Durable
  Chunk 5 条（-95.45%）。Full Debug 继续保留原始 Provider/Core 证据，不与普通下行量混淆。
- [x] `DONE-76` Windows 原生适配：新增集中审计的 Win32 原语层，Process 使用
  `CREATE_SUSPENDED → Job Object → ResumeThread` 消除派生竞态，文件系统覆盖大小写边界、
  reparse point、CAS、DACL 与 `ReplaceFileW`，受限写入使用 restricted-token ACL partial 后端，
  终端使用 ConPTY，模型命令使用 PowerShell 7 并可显式调用 OpenSSH/Git Bash。Windows Server
  2025 CI 执行全 workspace format/check/test/clippy、release 打包；DeepSeek V4 长任务验收保持
  手动 secret workflow，未实际运行前不得声称在线通过。
- [x] `DONE-77` Tauri 桌面壳与一键更新基线：`apps/desktop` 使用 Tauri v2 打包同一个
  `xharness-host` Sidecar 与版本化 Web UI；Host 自己绑定 `127.0.0.1:0` 并以原子 Ready File
  回传地址，避免端口预占 TOCTOU。每次启动用独立 256-bit Token 交换 HttpOnly/SameSite Cookie，
  `/api` 无凭据 401；浏览器部署保持原边界。关窗/更新通过 Shutdown File 复用 Agent→Loop→Tool→
  Job/Process 结构化收尾，15 秒后才强停。独立产品脚本提供自动检查、用户点击下载/安装、进度与
  重试，不进入上游 Client Module 图。签名 Updater、Sidecar Staging、macOS ARM64/Linux x64/
  Windows x64 Release Workflow、图标、中文规范和缓存 CI 已接入；Windows 包额外携带 ACL runner
  与固定版本 ripgrep。WZU_Server 通过 Desktop Test/Clippy、Host Token/Ready/Shutdown 真实进程
  验收；正式 Developer ID/Authenticode 签名、安装回归和 Release Secret 配置仍是发布门禁，
  不冒充已完成的品牌签名发布。

- [x] `DONE-78` 桌面更新下载/安装分离（0.1.1）：左下角蓝色更新入口、静默检查、下载进度、
  已验证后“重启更新”二次确认、按操作重试、刷新恢复与事件乱序保护；下载不停止 Host。
  关窗取消检查/下载，安装中不强退。补控制器/DOM 接线和远程 Rust 状态/取消测试，
  CI 校验包内图标、更新脚本与版本，Release 要求同 Commit CI 成功。
  **边界：** 缓存仅当前进程有效；正式签名升级仍须完成下述发布门禁，不算已在线发布。

## P0 — 可日常使用的本地 Coding Agent



- [x] `P0-02` **持久长生命周期 Agent 层。** 新增 `xharness-agent`：Agent、Turn、Step、
  Durable Inbox Message ID、Claim/Ack、Next-turn/Next-step 语义、Single-writer Session
  Lease 和重启续跑。
  Host-facing `AgentRuntime -> RunningTurn` 替换边界以及正式 Host 的持久 Runtime 接管均已完成。
  已实现：`agent/inbox/spliced` 事件、Next-turn/Next-step Replay、稳定 Message ID、原子 Claim
  Prelude、进程内 Registry、Memory/File Lease、AgentSupervisor、多 Turn Driver、Idle Inject、
  Active Turn 持久 Steering 和消费恢复去重。`xharness-host-app` 已默认组合
  `DurableLoopAgentRuntime + JSONL Store + File Lease`，连续 Turn 的模型历史来自持久日志；
  `session.prompt` 使用 RPC ID 作为稳定输入 ID，先完成 Durable Inbox Flush 才返回成功，
  Queue Edit/Remove 同步写入 Inbox，多条预准入消息用 `TurnStarted.input_ids` 绑定各自缓冲事件流。
  `Store::list_headers`、Host 启动 Replay、Workspace/Session/History/Queue 重建和 Pending Turn
  显式 Wake 已完成；History 已按 Cursor 直接查询权威日志，Host Event Projection 只保留有界
  尾部。Web Queue 已从完整 Durable Inbox 折叠两条列表并在重连发送 Baseline；Host 内存 FIFO
  只承担 Driver Attachment。Workspace 自定义元数据、排序、归档与 Settings 已进入独立 Host Control Log，相关
  9 个变更 RPC 使用通用 Exactly-once Receipt。Session Log 内的 Rename、Model Select、Preset
  Select 和 6 个 Goal RPC 也已使用同 Revision 原子 Receipt。Session Create/Fork、Queue/Cancel/
  Attachment、Preset Copy/Remove 等剩余通用 Receipt 归 `P2-01`；Secret-free Credential
  Reference Store 归 `P0-09`，不再作为长生命周期 Agent 主链路的完成阻塞项。
  七点通用日志前缀和包含 Approval Asked 的八点真实子进程 SIGKILL/同目录重启矩阵均已完成。
  Approval Asked/Decided、Provider Retry/Started、Agent/Permission/Sandbox/Approval Policy 与
  Permission Command Receipt 已进入强类型 Session Log 和确定性 Web History；Pending Approval
  已能在重启后按原 Approval/Execution ID 重新投影并继续回答。剩余冻结 Event 词汇归 `P2-01`
  的 Web 完整投影。
  **验收：** 输入被接受后到下次 Request 之间崩溃不能丢输入，也不能重复 Tool Side Effect。

- [x] `P0-03` **端到端统一使用 `xharness-tools`。** 从 Core 删除重复的 Scheduling/Approval，
  淘汰兼容 `xharness-core::ToolSpec`。同一个 Execution ID 必须贯穿 Journal、Approval、
  Middleware、Event 和 Result。
  已完成：Durable Execution ID 已贯穿 Journal、Core Event/Approval、`xharness-tools`
  Middleware/Approval/Handler/Observer 与 Result；未提供 ID 的独立 Executor 调用仍安全生成进程内
  唯一 ID。Core 测试已迁移到正式 Registry/Executor，`LoopRequest.tools`、
  `xharness-core::ToolSpec`、`ScheduledTool`、旧 Approval/Scheduler 和旧 Handler Bridge 已删除。
  未配置 Executor 时 Core 使用空 Registry 统一产出 Unknown Tool 结果，不再回退第二套调度器。

- [x] `P0-04` **Provider Call ID 映射。** `ToolCall` 已分别保存内部 Execution ID 和
  Provider Native Call ID。Responses Opaque Item Replay、无 Opaque Responses 和 Chat 均保证
  Tool Output ID 与 Assistant Call 匹配；审计事件继续使用稳定 Namespaced ID。测试覆盖跨 Step
  复用 Provider ID、旧日志回退、Session 重放和两种真实请求体编码。

- [x] `P0-05` **有界事件投递。** Loop 已使用逻辑 Append-only、物理有界的 Event Ring
  Journal，按事件数与序列化 Byte 双预算驱逐；Subscription 提供明确 Lag/Resume Cursor。
  忽略事件的 Host 不会积累无界 Channel，也不会阻塞 `result()`。WebSocket 跨连接 Cursor
  继续由 `P2-02` 完成，不再由 Core 临时流承担。

- [x] `P0-06` **结构化 Shutdown 和 Quiescence。** 正式生产路径已用明确所有权管理
  Provider/Tool/Process/PTY Task；Cancel 必须 Signal 并 Join，超过 Grace 记为
  `CleanupTimeout/ForcedCleanup`，不伪造普通 Cancelled。Agent/Host 关闭会阻止新 Admission，
  共享一个 Deadline，并在所有持久 Terminal 收尾后才成功退出。
  `FullAccess` 不能硬回收主动 `setsid()` 逃离 Group 的孤儿；该安全保证仍属于
  Linux PID Namespace/受限 Sandbox，保留 Pipe 的逃逸会被有界 Drain 检测为失败。

- [ ] `P0-07` **macOS 原生运行验证。** 在真实 Apple Silicon Mac 上运行 FS Race、Seatbelt、
  PTY Lifecycle、Web TLS、Live Loop，并打包/签名 CLI。仅 Cross Compilation 不算完成。
  ARM64 原生 CI、FS/Process/PTY/Seatbelt 测试和未签名 Host 构件已经完成；剩余 Web TLS、
  真实 Provider Live Loop、开发者签名、公证和本机安装/启动验证。

- [x] `P0-08` **Web DNS Rebinding 加固。** 每个连接绑定到已验证 Resolve Address，同时
  保留 TLS Host/SNI；Redirect 重新应用 Policy。已测试 Address Pin、IPv4-mapped IPv6、
  Reserved Range，以及 Fake-IP 仅对域名进入加密公共 DNS 验证、IP Literal 始终拒绝的边界。

- [ ] `P0-09` **配置与凭据边界。** 强类型配置文件、环境覆盖、Provider/Search Secret
  Reference、Redacted Debug、Event Log 禁止 Secret、文件权限校验。不做 Plugin/HMR Loader。
  候选上游 `b150a551b8d4` 新增 Authorization Seam；本项同时建立 Credential Store，然后新增
  one-in-flight-per-key Authorization Flow/Interaction、Cancel/Settlement 和 Web Prompt/Notice
  Projection。Authorization 不得进入模型 Prompt，Secret Prompt 不得进入任何日志。

- [ ] `P0-10` **真实协议矩阵。** 针对支持端点运行 Chat/Responses 真实 Tool Loop，覆盖
  Reasoning、多并行 Call、Tool Failure、Cancel、Usage、Long Context。保存不含 Secret 的
  可复现 Fixture。

- [x] `P0-11` **请求前上下文硬预算。** 在 Provider I/O 前计量 System、消息、全部工具
  Schema、协议模板和输出预留；窗口未知或预算超限时结构化失败。加入 2026-08-21 的
  `64196 > 53248` 固定回归，断言超限时 Provider Attempt 为零。`xharness-token` 已提供统一
  `TokenMeter`、保守 Byte Meter、强类型 Budget/Report/Error；正式 Host 配置模型时缺少窗口会
  拒绝启动。每次成功预算的分项进入 Request Header，输出上限进入两种 OpenAI 线协议。

- [ ] `P0-12` **大结果治理与分页 Read。** `read` 增加 Byte/Line Range 和下一页 Cursor，
  默认降到适合模型的小页；工具原始输出落日志/Spill，模型 Surface 只保留确定性的
  Head/Relevant/Tail、元数据和引用。不得破坏 Observation CAS。
  已完成：模型 Schema 的 Byte/Line 起点、页大小/行数和版本绑定 Cursor；默认 32 KiB/400 行，
  Cursor 延续原限制且文件变化后拒绝拼接；单结果超限使用带 Hash/Byte 统计的确定性 Head/Tail
  Envelope；通用 Durable Surface Replace 已由 `DONE-57` 完成；生产请求侧 Tool Result Pruner
  与 Web Focus Relevant 选段由 `DONE-68` 接入。剩余：原始大输出持久 Spill/Reference，以及把
  Pruner 的一次性 Edit 接入持久 Replace 事务。

- [ ] `P0-13` **Platform Readiness 与动态工具投影。** 模型请求侧已完成：Host 缓存
  Sandbox/Search/PTY Readiness，并在每个 Step 只发送实际可用工具；已确认失败的 Sandbox 不会
  被每轮重复 Probe。剩余：把同一报告接入 Web UI 的 Workspace Readiness 投影，并补
  WZU_4080 `RTM_NEWADDR` Bubblewrap 失败的固定诊断夹具与浏览器提示回归。

- [x] `P0-14` **真实 Coding System Prompt 注入。** 把选中的 `AgentPreset.content` 通过有
  版本的最小 Prompt Assembler 变成 `Role::System`，明确分页读取、不可用工具不重试、证据
  足够即回答和审批规则。测试必须解析 Provider 请求体，而不是只检查 Host 内存。
  已实现 `xharness-prompt/v1`：Preset/Permission/Workspace/Workflow/Plan 的顺序固定，动态内容
  以 SHA-256 版本化；Core 在 Context Policy 前注入并在 Request Header 记录审计元数据，
  Provider 两种线协议与 Host 实际请求均验证。完整可注册 Scope/Variable/Provider Section 仍归
  `P1-01`，Token Guard 仍归 `P0-11/P1-03`。

- [ ] `P0-15` **Linux `.deb` 自动沙箱配置。** 依赖声明、AppArmor 检测、官方
  `bwrap-userns-restrict` 安装/升级/保留管理员文件、语法校验、四项真实隔离 Probe、状态 Hash、
  远程打包和卸载已实现。剩余：在干净 Ubuntu 24.04 VM 完成 dpkg 矩阵，并在 WZU_4080 输入
  管理员授权真实安装后，重启 Host 验证 Coding Tool。

- [x] `P0-16` **持久 User Question 交互。** 已新增 `xharness-interaction`，冻结每次 1—3 个问题、
  每题最多 3 个有限选项、可选自由文本、`context/agent_markdown` 目标、Submit/Continue、空或部分
  回答、Draft/Dismiss、Cancel 与幂等 Resolution；`ask_user_question` 复用现有 Tool Registry，使用
  `Exclusive + External Settlement + Standalone Batch`，不受普通 Tool Timeout 影响，混合副作用
  批次在执行前拒绝。规范和接口测试见
  [`specs/user-questions.md`](specs/user-questions.md)。Session 强类型事件、Flush、Pending Recovery、
  `DurableQuestionHub`、`/api/respond`、冻结 Web 组件协议、受管 AGENTS.md Memory Sink 与下一轮
  Prompt 注入均已接通；Host Restart 会复用原 Interaction/Execution ID 恢复原 Turn。已覆盖有限
  选择、自由输入、部分/空回答、取消、幂等、Registry、Web Frame、Session 投影、Host 恢复和
  AGENTS.md 原子写测试。**后续但不阻塞本项：** 冻结上游 UI 没有跨刷新 Draft RPC；问题组的
  Compact 原子安全切点、Agent Markdown 独立 Prompt Budget，以及 Requested/Resolved/Tool Result
  每个 Flush 点的外部 SIGKILL 扩展矩阵归 `P1-03/E-08`。

### 桌面发布后续验收（DONE-78 后续，不冒充完成）

- [x] macOS 手动演练基础设施与基础包上线：独立测试签名、双版本 CI、固定目标 Pre-release。
  `a6b5d01` / CI `33945463459` 全部通过，`desktop-test-v0.1.2` 已发布；原生 0.1.1
  已安装并发现 0.1.2，修复 Loopback 应用 IPC 权限遗漏，25 个数据文件原有内容保留。
- [ ] 用户手动完成 0.1.1 → 0.1.2 下载/确认重启与会话继续验收；当前停在「下载更新」。
  演练不代替下列正式签名/公证与跨平台升级验收。

- [ ] 配置 Updater 签名密钥/公钥、Apple Developer ID 和公证 Secrets，发布第一个正式 Release。
- [ ] 用两个正式签名版本完成真实 macOS/Windows/Linux 升级，覆盖网络中断、签名错误、
  安装失败、运行任务时确认停止、对话与配置保留；当前单元/控制器测试不等同此验收。
- [ ] 跨进程下载缓存/断点续传、磁盘不足与缓存配额、版本撤回与数据迁移回退机制。
- [ ] 可选“等待任务空闲后安装”：须覆盖所有 Agent/Job 的原子 Admission 门禁，不能只看 UI。

## P1 — Coding 质量与上下文效率

- [ ] `P1-01` **Prompt Registry。** 有序 System Section、Workspace Context、Tool Guidance、
  Variable、Provider-specific Section、确定性 Request Header Capture 和 Prompt Version ID。
  `P0-14` 只交付最小可用注入，本项完成完整注册、Scope 与组合能力。

- [ ] `P1-02` **LLM/Provider Registry。** 按 Provider/Model/Purpose 路由，把 Prepared Call
  绑定到一个注册 Adapter，暴露 Reasoning/Max-token 控制，并在不猜协议的情况下发现模型能力。
  **已完成基础切片：** 单 Host 多 Provider/Model Registry、公共路由与上游模型名分离、每路由
  Token Guard、JSON 配置、Web 模型目录和选择前 fail-closed 校验。**剩余：** Purpose 路由、
  Reasoning 原生字段、模型 Capability/Tokenizer 注册、凭据服务绑定和安全热重载。推理档位必须
  改为 Adapter 驱动的动态 Capability：优先读取 Provider 明确提供且带版本的能力元数据，其次使用
  Adapter 的 Last-known-good 缓存，最后才回退到显式静态配置；禁止 Core/UI 猜测
  `low/high/max/xhigh` 的含义。探测结果必须带 `capability_revision`、TTL/ETag、来源与更新时间，
  热更新不能让活动 Turn 的已绑定档位在请求中途变化；Provider 只返回模型列表而不返回推理档位时，
  必须明确标记 `not_advertised`，不能把 `/models` 的成功误当成完整能力发现。Web 只投影目标模型
  当时真实可用的档位，新档位可出现，撤销档位对新 Turn fail-closed，历史 Session 仍可读取。
  **已完成 Context Capability 切片：** `ModelProvider::capabilities()`、带来源/ETag/抓取时间的
  `ContextWindowCapability`、OpenAI-compatible 结构化 URL + JSON Pointer + TTL Probe、显式
  `deployment_declared_fallback`、Web Capability 投影，以及 Session 可持久化软窗口均已接线。
  Token Guard/Compact 使用软窗口，选择超过部署硬上限会在 Event/Provider I/O 前失败。**剩余：**
  Registry 热刷新与 Last-known-good、运行中能力撤销的下一 Turn 对账、其他 Capability、Purpose、
  凭据服务和安全热重载。
  Context 数据模型现已拆分模型 Ceiling、Provider、Deployment、Account 和 Fallback Evidence，
  有效上限取约束交集；模型切换会重新物化目标模型上限，不继承前一模型窗口。仍需 Capability
  Manager 在 Turn 边界完成热刷新、上限缩小时的持久自动调整和非阻塞 UI Notice。

- [ ] `P1-03` **Token Meter 与 Context Policy。** Provider-aware Token Estimate、最大输入
  Guard、确定性 Tool Output Reduce、Surface Replace，以及不修改原 Event Log 的可选 Summary。
  `P0-11/P0-12` 先封死超窗，本项补 Provider-aware 精确计量、摘要和长期压缩策略。
  **已完成 Compact 抽象切片：** 新增 `xharness-compaction`；默认参数对齐上游
  `threshold=0.8 / retain=0.16 / maxTokens=8192 / retries=1 / overflowRetries=1`；实现精确
  Model Route 覆盖、Pressure/Overflow/Manual 规划、Tool Call/Result 安全切点、Unicode Tool
  Result Pruner、Checkpoint Frame 与 `CompactionSummarizer` Trait。Chat/Responses 的 Provider
  原生完整请求 Token 计数也已接入，不支持时回退保守 Meter。
  **已完成生产接线：** Session 强类型 `compaction/start|summary|end|prune`、Checkpoint
  `surfaceReplace`、当前 Surface 投影、Start/成功批次/End/Flush 事务、未闭合 Start 恢复、摘要
  变小校验、完成后重新计量、请求前 Pressure/Hard Overflow、Provider 400 Context Overflow
  恢复、正式 Durable Host 默认启用、Web `surfaceOp={op:replace,start,end}` 投影及回归测试。
  Compact 已使用独立 `compaction_reasoning_effort`，由精确模型能力列表解析最低成本档，不继承
  主对话 high/xhigh；摘要请求固定 `tools=[]`，并已回归覆盖思考档位与 Tool Schema 隔离。
  **剩余：** 手动 `/compact`、Purpose 路由到独立摘要模型、把 `DONE-68` 的请求侧 Tool Result
  Pruner 接入持久 Replace/内容引用缓存（不得恢复已撤回的工具参数占位投影）、Provider 结构化
  错误码优先于兼容文本分类、真实 SIGKILL/Flush 全切点矩阵、按模型本地精确 Tokenizer，以及把
  已解决 Question/Answer/Tool Result 作为不可拆分单元选择 Compact 安全切点；未决 Question
  始终留在当前开放 Step，不参与 Compact。还需增加基于 `source_revision + surface_fingerprint` 的
  Compact 幂等门：相同输入不得重复摘要，摘要后实际 Token/Byte 降幅不足 10% 时记录
  `no_progress` 并熔断，直到安全切点推进或压力显著增加；当前开放 Turn 中不可压缩的大 Tool Call
  不能触发逐 Step 摘要循环。摘要必须把 Tool Result/文件 SHA/副作用状态放在确定性 Fact Ledger，
  LLM 只能压缩叙述，禁止把未执行计划、Reasoning 推测写成已确认文件状态。精确 Tokenizer 必须同时
  报告 Tool Schema、Assistant Tool Arguments、Reasoning 与 Provider Opaque Items，不能只计
  `message.content`。

- [ ] `P1-04` **动态 Tool Projection。** 每个 Profile/Step 只发送相关工具，同时保持 Schema
  稳定。默认 Coding Bundle 为 `read/grep/glob/write/edit/bash`；Interaction、Job、Schedule、Web
  根据最新用户意图、活动 Job/Schedule 和前一步 Tool Result 确定性启用，并提供小型 Capability
  Catalog/Enable 兜底，防止 Router 漏判后永久失去工具。与始终发送全部工具进行多 Seed A/B，
  报告 Tool Schema Token、Cache、TTFT、错误工具选择率、完成率和额外 Enable Step。

- [ ] `P1-05` **更完整且不重复的 Tool Description。** Prompt Section 只保留跨工具路由原则，
  单工具 Description 只保留输入、输出和关键限制；消除 Job/Schedule 规则在 System、`bash` 和
  控制工具中的重复，修复 System 写 `web_search` 但正式模型面只有 `web_fetch` 的不一致。目标在
  不降低选择质量的前提下把 Schema 序列化体积降低 30%—50%；继续使用固定工具选择数据集和
  DeepSeek 的 PTY/nohup 提示做评估。

- [ ] `P1-06` **扩展 FS Tool。** 增加目录创建/列表、安全 Delete/Move/Copy、Binary/Image
  Read、Unified Diff/Patch、按行读取和显式 Spill Reference；继续保持 Observation CAS 和审批。

- [ ] `P1-07` **后台 Job 后续。** 第一阶段已完成 One-shot Bash `run_in_background`、Owner-scoped
  Job Registry、三个控制工具、内存 Tail、五态、Process-tree 清理与 Lifecycle Broadcast。
  剩余：Finished Notice 自动注入 Busy Agent 或唤醒 Idle Agent、全量 Spill 文件、Host 崩溃后的
  Outcome Unknown/Orphan Reconciliation（禁止自动重放命令）、Web Job List Projection，以及
  Subagent/Workflow 等新 Producer 接入同一 Registry。

- [ ] `P1-08` **专用交互 Terminal Profile。** 默认模型面已移除旧六工具。若 TUI/REPL 确有需求，
  重新设计仅按 Profile 投影的 PTY 能力：Resize、OSC 133 Prompt Marker、Foreground-pgid、
  Read-state Observation、Active-send 互斥和明确 Settle Reason；禁止再把持久 Shell 当后台 Job。

- [ ] `P1-09` **多模态 Message 与 Attachment。** 强类型 Text/Image/File Block、内容寻址
  Blob Store、Image Metadata/Budget、Provider Encoding，用持久 Reference 替代内联大数据。

- [ ] `P1-10` **Web 质量。** `DONE-68` 已完成脚本去噪、8,000 字符 Reader 抽取摘要与 Focus
  选段。剩余：更多 Search Provider、稳定 Source/Citation Object、跨请求内容去重、完整
  Readability/Cache，以及作为独立高信任 Capability 的可选登录态 Browser。

- [ ] `P1-11` **Session Branch 与 Projection。** 从 Revision Fork、不可变 Ancestry、命名
  Branch、Inspect/Query API 和确定性 Transcript Export/Import。Compaction Surface Event 与
  Web Replace 投影已经由 `DONE-57` 完成，不再属于本项缺口。

- [ ] `P1-12` **资源 Policy。** CPU/Memory/File/Process/Output Quota、Per-tool Policy、
  条件允许时接 Linux cgroup v2，并让 Quota Failure 可观测。

- [x] `P1-13` **Windows 原生执行层。** `DONE-76` 已完成 PowerShell 7、Job Object、Reparse
  Point 安全文件访问、ACL restricted token、ConPTY 与原生 CI；Windows x64 Tauri Release 同时
  打包 Host、固定版本 ripgrep 和 ACL runner，不发布 Windows 空壳。

- [ ] `P1-14` **Windows ARM64 与品牌签名。** 增加 Windows ARM64 原生执行/桌面矩阵、
  Authenticode 证书导入、安装/升级/回滚测试与 SmartScreen 发布运维。Tauri Updater 签名不能冒充
  Authenticode 代码签名。

## P2 — Host、API 与 UI

- [ ] `P2-01` **持久 Agent-backed Web API。** Carrier、52 方法目录、Start/Steer/Cancel/Approve、
  History Projection、Optional Capability Response 和 Export Body 已完成。正式 Host 的 Prompt
  Admission、模型历史、Agent Driver、Workspace 元数据/排序、Session 排序/归档、Settings、
  Durable Queue、权威 History Cursor 和 Pending Approval 均已由 Session/Inbox/Control Log 重建。
  **剩余：** Session Create/Fork/Cancel/Attachment、Preset Copy/Remove 等 RPC 的通用持久 Receipt，
  Credential Reference，以及 Health/Readiness；继续缩小 `BasicHost` 中仅用于兼容投影的内存缓存。

- [ ] `P2-02` **流式传输增强。** 提供带 Cursor Resume、Lag Detection、Reconnect 和
  Per-session Multiplexing 的 WebSocket/SSE 下行事件流。增加两级 Delta Coalescer：首个正文/
  Reasoning Delta 立即发送以保护 TTFT，随后按 20--50 ms 或 4--16 KiB 合并；Tool Arguments 默认只
  投影进度和最终结构，不把每个 token 作为独立 Web 卡片事件。Tool Arguments 的 Checkpoint 内相邻
  合并和真实模型验收已由 `DONE-75` 完成；剩余两级时间/字节下行合并与最终结构专用投影。Durable
  Journal 保存可恢复的合并帧
  和最终 Assistant/Tool Call，不为每个 Provider 微碎片追加一条 Event；Cancel、Finish、Tool Call
  边界必须强制 Flush。验收报告原始 Delta 数、下行 Frame 数、JSONL 增长、CPU、重放一致性和崩溃
  最多丢失的未 Flush 窗口。

- [ ] `P2-03` **Web UI 完整投影。** 继续把 DeepSeek Harness UI 作为 Client Projection：
  Session、流式 Reasoning/Text、Tool Card、Approval、Terminal、File、Web Source、Usage、
  Recovery State。模型性能字段按 [`specs/metrics-projection.md`](specs/metrics-projection.md)
  已完成 M1–M3：单次 Usage camelCase、`tokenUsage` 与 `sessionStats` 的 Live、History、
  Session List 和 Restart 等价投影均由 `DONE-61` 关闭，现有前端可以恢复 TTFT、Token/s、
  Token 总量和 Cache Hit。此项继续跟踪非模型指标的 Terminal/File/Web Source 等完整投影。
  Rust Host 已补齐上游 Bash Tool View 契约：`bash` 的运行中 Call 投影
  `callView.card="terminal"`（command/cwd/description），完成结果投影
  `resultView.card="terminal"`（stdout/stderr/exitCode/signal），成功、运行中、非零退出和截断结果均
  可沿上游 Bash 卡片展开；Live/History/Legacy/重启兼容由 `DONE-74` 关闭。**剩余：** 运行期间
  stdout 增量卡片、浏览器无鼠标键盘 E2E，以及 File/Web Source 等专用 View。`write/edit` 的大
  Content 不逐字符渲染，但完成后必须提供
  Path/Diff/Hash 和按需 Raw Inspect，不能以 Coalescing 为由永久隐藏工具详情。测试覆盖 Live、
  History、重启恢复、运行中 stdout 追加、失败退出码、输出截断与无鼠标键盘展开。

- [ ] `P2-04` **Host 认证与授权。** 默认仅本地；远程使用 Bearer/Session Auth、Workspace/
  Owner 隔离、CSRF/Origin Policy、Audit Log 和显式 Network Exposure。

- [ ] `P2-05` **可观测性。** 结构化 Tracing、Per-step Latency/TTFT/TPOT、Tool Duration、
  Retry/Cancel Reason、Token/Cache Accounting、OpenTelemetry 接口和 Secret-safe Diagnostic Bundle。
  **已完成 Debug Trace 抽象切片：** `xharness-debug` 提供默认零 I/O Noop、Full JSONL 单写者、
  全局 Sequence、64 KiB Content-addressed Blob、递归凭据脱敏、显式 `sync_data` Flush 和 Unix
  `0700/0600` 权限；Host App 已支持 `XHARNESS_DEBUG_TRACE=full`、`XHARNESS_DEBUG_DIR` 及
  Start/Restore/Listening/Exit；同一 Recorder 已贯通 Core Context/Loop、OpenAI Wire/SSE、Tool Pipeline、
  Process 原始输出、PTY、Sandbox、Web Search/Fetch 和 Server RPC/WebSocket，并补跨层测试。
  `DONE-61` 已完成 Web 兼容 `tokenUsage/sessionStats` 确定性聚合。**剩余：** Trace
  Rotation/Retention、TPOT、Diagnostic Bundle 和 OpenTelemetry Adapter。Provider 专有 Timing
  只进入诊断命名空间，不覆盖统一事件时间口径。

- [ ] `P2-06` **Settings 与 Profile。** Versioned YAML/TOML Profile、有序 Patch Layer、
  Validation/Dump、Migration，以及 Model/Tool/Policy Preset。

## P2 — 生态能力

- [ ] `P2-07` **MCP Client。** Stdio/HTTP Transport、Lifecycle、Capability/Schema Import、
  Cancellation、Approval/Policy Mapping、Namespace 和 Credential Isolation。

- [ ] `P2-08` **Skills。** 发现/加载有版本的 Instruction Package，显式 Scope 和 Token
  Budget；在 Request Header 中记录选中的 Skill Version。

- [ ] `P2-09` **LSP 集成。** Owner-scoped Language Server、Diagnostic、Definition/
  Reference/Symbol Tool、Restart/Backoff、有界输出和 Workspace Policy。

- [ ] `P2-10` **Git 工具。** 安全直接 Argv 的 Status/Diff/Log、Mutation Approval、
  Worktree Awareness，并禁止隐式 Push/转发 Credential。

- [ ] `P2-11` **本地代码索引。** Ignore-aware 增量 Search/Index 和确定性 Reference；必须
  与公共 Web Search 分开。

## P3 — 多 Agent 与 Workflow

- [x] `P3-01a` **单工具 Subagent 基础链路。** 仅注册 `agent`（start/send/inspect/stop），
  复用 Session/Inbox/Driver/Loop；父子鉴权、独立上下文、创建幂等、两路实际子轮并发、
  暂停不误唤醒、结果通知去重/恢复、取消及准备失败兜底。已做远程回归和 DeepSeek Flash
  实际编程/控制/追加需求测试；同时修复控制日志冲突与历史游标倒退；见 [单工具委派 Spec](specs/agent-delegation.md)。尚未发布安装包。
- [ ] `P3-01b` **Subagent 扩展与发布验收。** 独立 Tool/Provider/Profile Scope、外部后端、
  多层谱系、聚合 Waiting UI、配置化限额、跨权限文件隔离、投递退避与逐写入断点故障注入，
  以及 Web/Tauri CI 打包和端到端验收。不得将基于少数真实任务的通过等同于完整生产覆盖。

- [ ] `P3-02` **Workflow Graph。** 强类型 Sequential/Parallel/Join/Condition Node、
  Checkpointed Execution、Idempotency Key、Replay Inspection 和 Manual Gate。

- [x] `P3-03` **Scheduler/Automation。** 已由 `DONE-71` 完成 Session-owner 持久 Timer、
  Idle-only Agent Wakeup、一次性与固定相位 Recurring Schedule、离线 latest-only Missed-run
  Policy、`schedule/change` 可观测执行历史、重启恢复和 Web 实时投影。当前产品边界是进程常驻、
  会话本地提醒；操作系统级 Wake、跨设备通知和独立 Cron Worker 属于后续产品扩展，不回退本项。

- [ ] `P3-04` **远程执行。** 显式 Remote Platform Interface、Workspace Sync/内容寻址、
  Policy/Capability Attestation；受限远端不可意外回退为本地 Full Access。

## 持续发布门禁

- [x] `REL-01` 每次变更在 Linux 对整个 Workspace 执行 Fmt、`check --all-targets`、Test、
  Clippy `-D warnings`。
- [x] `REL-02` macOS 原生 CI，覆盖 Sandbox/PTY/FS 集成测试。
- [ ] `REL-03` SSE、JSONL Crash Tail、Event Lifecycle、Tool-call Assembly、Path Resolve、
  Schema Input 的 Property/Fuzz Test。
- [ ] `REL-04` 每个 Durability Barrier 和 Tool Side-effect Boundary 的 Fault Injection。
- [ ] `REL-05` TTFT Overhead、Event Throughput、JSONL Growth、Tool Scheduling、Long Context、
  PTY Scrollback、Web Extraction Benchmark。Long Context 必须报告 System/Message/Tool/Template/
  Output Reserve 分项，并包含多个并行大文件结果导致单 Step 暴涨的用例。Context P0 消融必须
  至少覆盖 32 个成功 `write` Tool Call、失败/未完成调用不投影、Responses `function_call` 同步、
  投影确定性、Call/Result 拓扑不变、请求 Byte/Token 降幅、Policy CPU 和真实 Provider TTFT/
  Prefill；不能用仅减少 Payload 的结果宣称端到端一定更快。增加单次 50 KiB Tool Arguments 被
  Provider 切成 1--5 字符碎片的回归，比较 Coalescing 前后的事件数、JSONL 体积、Web 渲染负载与
  TTFT；增加大型 `write` BlindOverwrite -> Read -> Retry、Host 重启恢复 Observation、Compact
  `no_progress` 熔断以及错误摘要不得覆盖确定性 Tool Fact 的真实失败路径。
- [ ] `REL-06` Semver/API Audit：Non-exhaustive Extensible Type、Builder、Deprecation Window、
  Changelog、Reproducible Lockfile、SBOM、License、Signed Artifact。
- [ ] `REL-07` Security Regression：Symlink Race、Sandbox Escape、Process Descendant、SSRF/
  Rebinding、Credential Leak、Approval Fail-open、Log Corruption、Cross-owner Access。
- [ ] `REL-08` **DeepSeek Flash 真实 Coding 验收闭环。** 按
  [`specs/live-deepseek-evaluation.md`](specs/live-deepseek-evaluation.md) 先过确定性/Debug/协议门禁，
  再让 Flash 在隔离 Workspace 完成固定真实编程任务；Harness 独立验收构建、测试、Diff、任务约束、
  Side Effect 和恢复语义，记录 TTFT、Decode、Cache、Tool 成功率、重试、Context/Compact、事件量、
  JSONL 增长和端到端时间。每个失败必须进入可复现 Fixture/回归测试后再修复，禁止只改 Prompt 掩盖
  Runtime Bug；连续三轮无回归且满足阈值后才提升默认版本。

### 会话模型控件补齐（2026-09-06）

- [x] Web / App 共用模型菜单：思考档位、上下文容量收进二级页面，一级不再重复显示；复用 ModelDirectory 与现有 RPC。
- [x] 修复客户端 Schema 丢弃上下文容量、上限及来源；打包资源与 boot graph 同步校验。
- [x] 增加刷新回读、切换大小模型、无能力声明、非法输入、取消、网络重试及异步竞争回归。
- [x] Chromium / WebKit 交互回归、WebKit 19 项 Context/Harness 布局回归，以及远程 Rust 模型切换/重启恢复测试。
- [x] 2026-09-07 使用 CI #34070303565 后端替换本机 App，保留 0.1.4 桌面壳、更新配置及对话；健康检查和包内页面加载通过。
- [ ] 二级模型菜单的正式 CI 包发布（本地 UI 更新不等于其他用户已收到更新）。

### 子 Agent 返回主会话回归（2026-09-07）

- [x] 修复子会话创建推送、会话摘要及重启恢复缺少 `origin=subagent` 的导航契约。
- [x] 补父面包屑鼠标/键盘/恢复导航的 Chromium 与 WebKit 测试，复用上游组件。
- [ ] 发布包含修复的新 Host 安装包，并在原生 App 验收子 Agent → 主 Agent 继续发送消息；不以隔离组件测试替代整包验收。

### 模型网络恢复（2026-09-07）

- [x] 核实默认每步额外重试 2 次，共 3 次请求；测试 0/1/4 次配置及 HTTP 状态码边界。
- [x] 修复无协议终态 EOF 的安全重试、Provider 完成后重复错误、取消/断网竞争的错误终态。
- [x] 增加真实 HTTP 故障注入，以及工具参数不提前执行、已完成工具不重复执行的回归。
- [x] WZU_Server 回归通过：网络测试连续运行 5 轮；全 Workspace / All Targets 共 415 项通过、4 项忽略、0 失败；Core 与 OpenAI Provider 的 Clippy（含测试，禁止警告）通过。测试为隔离 HTTP 故障注入，不代表真实 Wi-Fi/TLS 切换验收。
- [x] 指数退避、抖动、Retry-After、每步输出前恢复期限；等待可取消且复用 UI 倒计时。
- [x] 部分正文/思考以 interrupted 消息持久化，用户新消息“继续”开启新 Turn，提示可能额外计费，不重放未确认工具。
- [x] 轻量网络诊断：最近收块时间、收包统计、协议结束状态、脱敏 origin、请求 ID；不要求完整 Trace。
- [x] 隔离真实 TLS：校验证书，实际省略 close_notify，覆盖输出前、部分输出、协议已完成。
- [ ] 物理 Wi-Fi/代理路径切换与正式桌面更新包安装验收，不以隔离 TLS/HTTP 测试冒充。

### Linux 桌面升级演练（2026-09-07）

- [x] 隔离签名 AppImage 原生升级：0.0.901 → 0.0.902 连续 3 次通过，真实重启、目标文件 Hash、持久会话与数据保留验证。
- [x] 503、并发检查、篡改签名包、未下载及未确认安装的异常边界；现有桌面 Rust/前端更新器/签名回归通过。
- [x] 可重复运行的夹具和中文验收记录：`specs/linux-desktop-update-rehearsal.md`，不把自动驾驶入口加入正式产品。
- [ ] Linux 真实桌面点击更新及 GitHub 正式签名更新通道验收。
- [ ] `.deb` / `.rpm` 提权升级、FUSE 挂载模式、跨发行版和安装失败/回滚验收。
- [ ] AppImage 下真实 Coding Tool 环境回归，特别是 AppRun 注入的 PYTHONHOME/PYTHONPATH/动态库路径；不能用更新成功替代工具链可用性验收。

### 2026-09-07 · DeepSeek 旧配置思考选项缺失修复

- [x] Provider 组装层按官方端点＋精确上游型号补齐缺失档位，显式配置优先。
- [x] 旧配置恢复与实时模型目录共用解析，不改密钥、历史或预算。
- [x] 两协议请求映射、选择持久化、模型切换及未知/无效配置回归测试。
- [ ] 将可维护的已验证能力目录扩展到更多厂商；没有可靠依据的接口不得猜档位。

### 2026-09-07 · 会话自动标题（AUTO-TITLE-01）

- [x] 临时标题＋有意义的首轮任务结束后后台总结；同一会话只接受一次自动标题。
- [x] 旧会话启动补齐，保留人工/已有模型标题；复用 Session 标题事件和前端投影。
- [x] 独立最低推理档位、空工具、限长摘录、超时/取消、持久预约和最多三次尝试。
- [x] 人工改名、切模型、删除、重启、空/截断输出与 Host 新消息全链路回归；V100 新增 14 项专项＋全 Workspace 测试和 Clippy 通过。规范见 `specs/auto-titles.md`，记录见 `evidence/auto-titles-20260907.md`。
- [ ] 正式更新包安装及真实模型标题质量验收（不把 Fake Provider 回归算作发布）。
- [ ] 手动重新生成入口、专用标题模型/预算配置、大规模旧会话补齐进度、专用 Debug 指标。

### 2026-09-08 · 三平台稳定更新（DESKTOP-UPDATE-02）

- [x] 统一发布协议与四目标矩阵：Windows x64、Linux x64 AppImage、Mac ARM64/Intel；
  复用既有更新器、UI、Host 生命周期和 Windows 原生安装验收。
- [x] 单次完整清单聚合、公开构建收据、独立签名校验、同 SHA/Run/Attempt 绑定；
  沿用现有 Windows 公钥，禁止清单退化、错误包类型回退及覆盖已发布版本。
- [x] 候选 Draft 与正式 Promote 分离；Apple Developer ID/公证缺失硬失败，不降级
  ad-hoc；公开更新源只在全部正式验收通过后改变。
- [x] 新增原生 Unix 候选升级、Windows 当前稳定包单跳升级的验收脚本与来源绑定；
  文档明确临时基础包/真实候选包、Smoke/演练/正式发布的不同证据等级。
- [x] 核心改动 GitHub CI [34171760874](https://github.com/123123213weqw/x-harness-rs/actions/runs/34171760874)
  11/11 Job 成功；Linux AppImage、Mac ARM64、Mac Intel 各三轮真实升级，共 9/9。
  已在真实 UI 自动产生两个会话时验证完整 Journal 库存与重启恢复，不再硬编码单会话数量。
  详细证据见 [三平台更新回归验收](reports/unified-update-ci-2026-09-08.md)。
- [ ] 配置 Apple 凭据并完成正式四目标候选包构建、真实候选升级验收及发布。
  用户已确认当前无 Apple 证书，保留门禁；本项是真实外部依赖，不用测试包顶替。
- [ ] 旧 Mac 0.1.4 固定测试通道一次性基础包迁移与用户桌面点击验收。
- [ ] Linux DEB/RPM 独立包类型更新、提权/取消/失败恢复；Linux ARM64、Windows ARM64。
- 规范：[三平台稳定更新](specs/unified-desktop-updates.md)。现有 Windows 稳定通道继续保留
  （验收结束时独立发布流水线已更新至 `friends-v0.2.6`）；
  本次开发不改用户的应用安装、对话和生产模型服务。

## 2026-09-11 Goal 入口收敛

- [x] 常规 `goal` 工具：与 Bash 一样通过 ToolRegistry 暴露，复用 Host Goal RPC；create/get/update/pause/resume/report，不额外注册 goal_report。
- [x] 只保留原 GoalBar：状态、轮数、预算、确认在框内；移除下方展开区；空状态静默隐藏，模型通过常规 goal 工具创建后显示，源覆盖文件与部署 bundle 同步。
- [x] 参数隔离、取消、创建幂等、过期 ref、报告限制及多轮现有测试；Chromium/WebKit 单框与异步异常回归。
- [ ] 本次变更跨平台 CI、macOS/Windows/Linux 安装包发布和软件替换；尚未更新 0.2.16 已安装实例。
- [ ] 用真实模型额外验收“自然语言要求 → goal.create → 自动推进 → goal.report”；既有真实 DeepSeek 报告实验不代表本次新增入口已实测。

## 2026-09-11 问答软等待与低风险继续

- [x] Interaction/Session：Deferred 非答案结果、独立持久事件、一次性等待解除、保留迟答问题。
- [x] Host：60 秒持久截止时间、取消不唤醒、固定 RPC 身份的迟答 Steering outbox。
- [x] 原 Tool Guard 白名单已在 2026-09-13 移除：待答不改变工具权限，模型判断答案依赖；原审批与沙箱仍生效。
- [x] UI：同一问答卡片提示超时可继续、保持当前草稿、无自动选择。
- [x] 远程 333 项回归、Clippy、Chromium/WebKit；真实 DeepSeek 60.022 秒解除等待 → 只读侦查 → 重启 → 接收迟答 → 正常继续。
- [x] CI macOS 构建并部署本机 3082 Web 后端（42e72b9）；真实 DeepSeek 验收 60.039 秒解除等待，重启后迟答接回；会话与配置已备份保留。
- [x] 超时问答自动收起为小条、恢复普通输入框；展开草稿和审批隔离的 Chromium/WebKit 回归通过，已更新 3082 前端。
- [ ] 桌面安装包发布与各平台软件替换；本次只更新本机 Web 服务。
- [ ] 问答草稿跨页面重载的持久化：单独设计用户隐私、清理和会话隔离，不将未提交草稿当答案。

## 2026-09-11 Goal 与普通聊天隔离

- [x] Goal 依赖失败仅暂停自动推进，继续处理普通用户队列；非 active/enabled Goal 跳过旧依赖检查。
- [x] 远程 Goal runtime 20 项测试通过；新增异常、暂停、禁用、运行中依赖、重启两轮聊天回归。
- [x] 修复启动顺序：恢复配置并激活模型后再恢复队列；激活失败清空旧路由，保留设置修复入口。
- [ ] CI 构建并替换本机 Web 后端，验收原先排队的用户消息恢复。

## 2026-09-12 后台监听器生命周期

- [x] 修复 background turn listener 强引用环；Goal/background 监听器共享显式退出信号，Host 最后所有者释放自动唤醒。
- [x] 正式关闭路径接入停止信号；不通过取消已入队工作来伪装修复。
- [x] V100 验收：旧监听逻辑释放测试失败、修复版通过；5 个新生命周期测试，Host 119 项、Goal 20 项、Schedule 5 项通过，Clippy 无警告。
- [ ] 跨平台 CI、发布安装包及 Windows 长时间运行实测；源码修复不代表已安装软件已升级。

## 2026-09-12 Issue #58 输入缓存语义

- [x] Provider 分开归一化包含缓存总量与非缓存输入；保留 OpenAI/DeepSeek 原路径，补 Anthropic 形状。
- [x] 部署配置与可编辑设置接入 usage 语义覆盖，未知值拒绝；流内固定口径，旧历史不改写。
- [x] V100 155 项回归与 Clippy 通过；旧解析函数在新增矩阵测试失败、修复后通过，SSE 单字节分片及 HTTP/Host 配置接线通过。
- [ ] 跨平台 CI、推送发布及客户端更新；旧历史 usage 不自动回填。

## 2026-09-13 问答不改变工具权限

- [x] 删除 ExplorationGuard 和生产接线，保留 60 秒 deferred、持久化与迟答 Steering。
- [x] 同步工具描述、deferred notice、问答卡片文案及可重入前端补丁。
- [x] WZU_Server 94 项 Rust 回归通过（另 1 个子进程辅助测试按设计 ignored）：待答继续工具执行、原审批不被绕过、回答竞态与恢复；前端补丁一致性及 Chromium/WebKit 问答交互回归通过。
- [ ] CI 发布与已安装软件更新（本次源码修改不代表已部署）。

## 2026-09-13 历史消息 DOM 窗口化

- [x] 实测高度占位、前后各一屏缓冲、共享观察器、按帧更新、交互行和活动后缀保留。
- [x] 接入真实 ChatView 和静态 UI 重建流程，保留原锚点与滚动逻辑。
- [x] 服务器 Chromium 三次 DOM/JS 堆 A/B、真实 ChatView 滚动回归；本机 WebKit 通过，详见 `reports/transcript-windowing-20260913.md`。
- [ ] Linux WebKit 本地运行（浏览器下载失败/缓慢）；CI 已接入两个引擎，尚待远端 CI 验证。
- [ ] macOS 桌面真实长对话 footprint 对照与首次加载峰值优化。
- [ ] 跨组件轻量交互状态外置后，进一步释放大量已交互的历史行。
- [ ] 数据层全文检索替代依赖所有消息 DOM 的原生查找。
- [ ] CI 通过后才允许合并；尚未发布或替换生产软件。

## 2026-09-13 流式数学公式

- [x] `UI-MATH-01` 流式/最终解析器共享数学扩展，未闭合块公式保留原文，保留 frozen/tail 增量缓存。见 [规范](specs/streaming-math.md)。
- [x] `UI-MATH-02` 打包入口补丁、内容哈希、重建接线，真实 MarkdownText 在 WebKit / V100 Chromium 上 18 组检查通过。
- [ ] `UI-MATH-03` GitHub CI 通过后合并发布、更新软件并在真实流式回答验收。

## 用户中断提示（2026-09-14）

- [x] `INTERRUPT-CONTEXT-01` 显式用户停止来源、模型可见中断标记、实时/历史一致投影，复用取消机制；见 [规范](specs/user-interruption.md)。
- [x] `INTERRUPT-CONTEXT-02` V100 六个 crate 339 项通过、4 项既有忽略，四个核心 crate Clippy 零警告；见 [回归记录](reports/user-interruption-20260914.md)。
- [x] `INTERRUPT-CONTEXT-03` V100 真实 DeepSeek Flash/xhigh 三组打断 → 转向 → 恢复通过；发现并修复自动标题元数据日志竞态，保留模型先后顺序偏差记录。旧的 task/current-scope 实验已撤回。
- [ ] `INTERRUPT-CONTEXT-04` 长历史/Compact/快速连续转向行为评估、跨平台 CI 与发布安装；提示标记不保证工具依赖排序或回滚。

### 2026-09-14：停止后的观察状态收敛

- [x] 修复广播滞后被误判为模型失败，复用持久日志重新定位输入所属轮次。
- [x] 修复 Steering/删除队列输入后观察器等待不存在的独立轮次。
- [x] 增加旧轮次隔离和完整 Host 停止状态回归，内部回执不能突破停止门禁。
- [ ] 将上述修复合并、发布并安装到桌面软件；当前代码验证不等于已替换安装包。

### 内部回执队列隔离（2026-09-14）
- [x] 非用户输入统一投影为 context，复用 Web/Tauri 队列语义，移除用户编辑/Steer/删除入口。
- [x] session.updateQueue 后端拒绝内部消息变更，旧客户端无法误删回执；持久恢复保留部分元数据中的来源。
- [x] 增加回执递送/暂停/重启/不可变回归与已打包 UI 契约测试，接入 CI。
- [ ] 合并上述队列修复与停止观察器修复、发布并更新桌面安装包（源码修改不等于已部署）。

- [x] **P1 输出截断通知（源码及 Web 产物）**：中英文改为历史事实说明，不再无条件要求发送 continue。已补运行/空闲/暂停/历史恢复与前端重建、manifest 回归；未替换已安装软件。复现及验收见 docs/reports/max-tokens-notice-20260914.md。

- [x] **P1 Compact UI 协议一致性**：摘要映射内容块，replacement 携带 compact 来源/关联 ID，手动命令关联与零基 turn 修正；实时/历史/启动尾部共用投影；Context 检查页兼容新旧摘要格式。
- [x] 补自动/手动、刷新/分页、重复事件、摘要迟到、展开/收起、Unicode、统计、失败/取消不替换上下文回归；前端契约测试加入 CI。
- [ ] 发布安装包并部署本批停止/内部回执/截断提示/Compact 修复；当前安装软件不因源码提交自动替换。


## Compact 自身超限恢复（2026-09-18）

- [x] 摘要复用 Provider 完整请求计数和独立输出预算；所有分块/合并请求检查预算。
- [x] 超限按闭合工具事务分块，巨大单消息 UTF-8 安全文本分片；完整成功才原子替换。
- [x] 输出截断增额重计量、超限改输入、瞬时错误有限退避；永久错误不原样重试。
- [x] 压缩触发线绑定可用输入预算和近期增长；不缩短主对话的长思考预留。
- [x] 新增分块、截断、计数、取消和不丢历史回归用例。
- [ ] 跨平台 CI、软件重新打包替换后，在 `code5` 副本上真实模型验收（不修改原对话）。

### Compact 审核补修（2026-09-18）

- [x] 摘要实际输出受输入余量和窗口约束；4K/8K/16K 不再被固定 8192 下限卡住。
- [x] 截断后无法扩大实际额度时分块，不重复相同请求，不修改主对话输出预算。
- [x] 原子替换前检查完整候选上下文，复用主请求的准备与计数逻辑。
- [x] 补候选验收失败、取消、Steering、工具/System 投影一致性回归。
- [ ] 压缩后目标线与连续压缩次数的真实长会话评估；不能把“请求合法”当作“腾出足够工作空间”。
- [ ] 本次补修的跨平台 CI、发布部署及真实模型验收。
- [x] 审核补修：V100 全 Workspace 测试、Core/Compaction/Token 全目标 Clippy 通过；Core 111 项测试通过。


### Compact 大规模边界回归（2026-09-18）

- [x] 编写 13 个新增测试函数：预算极值/固定种子矩阵、Unicode 分块、闭合工具事务、摘要故障、候选取消/暂停/并发写入。
- [x] 新增矩阵远程执行通过：源码 `4dac706` 在 CI 35324269598 的 Linux/macOS/Windows 全仓测试通过，Core 120 项通过；V100 SSH 超时，未本机编译。
- [ ] 等待本批所有打包/更新演练 CI 完成后再决定合并发布；跨平台单元测试绿不等于整个工作流已完成。
- [ ] 真实模型长会话质量、真实 Provider 计数误差、桌面热切模型端到端验收仍独立执行，不能用 Fixture 代替。
