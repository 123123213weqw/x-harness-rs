# 统一发布任务入口

日期：2026-09-18。入口与离线回归已实现；真实 CI 发布验收单独进行，不表示新版已经发布。

## 设计

发布使用确定的状态机，不让模型临时拼接四个 Workflow、猜 Run ID 或跳过验收。
`scripts/release.py` 仅协调既有流程，不重新实现签名、原生安装验收或更新清单校验：

```text
锁定 master SHA → 等待该 SHA 的 CI → Desktop Release → 完整 Draft
                                                     ↓
                                  Unix / Windows 原生升级验收
                                                     ↓
                                   等待维护者确认具体版本
                                                     ↓
                                      Desktop Promote → published
```

默认完成候选包和验收后停止，不修改线上 latest。确认后才调用原有 Promote；后者仍独立
检查来源、最新运行次数、资产收据、签名、验收和当前通道基线。不替换本机软件，不在本机编译 Rust。

## 用法

本实现必须先合入 `master` 并通过 CI。需要 Python 3.10+、已登录的 GitHub CLI，以及仓库
Actions 触发和仓库变量读取权限；发布仓库仍需配置原有 opt-in 变量与签名 Secrets。
在仓库根目录运行，Windows 可将 `python3` 替换为 `python`。版本号仅为示例：

```sh
# 自动准备候选版本、跟踪所有 Run ID；最多等待四小时
python3 -B scripts/release.py 0.2.20

# 不触发任何工作流，只刷新状态
python3 -B scripts/release.py 0.2.20 --status

# 中断后用原命令恢复；也可只推进一次、不持续等待
python3 -B scripts/release.py 0.2.20 --no-wait

# 检查失败原因后显式重试已确认失败的阶段
python3 -B scripts/release.py 0.2.20 --retry

# 必须先到 awaiting_confirmation，再由维护者确认
python3 -B scripts/release.py 0.2.20 --confirm-publish 0.2.20
```

默认 `--platforms all-macos-preview`：Windows、Linux 和两种 Mac 架构。Mac 为未公证内测版，
但仍要求原有更新签名。`all` 要求正式 Apple 凭据；`windows-linux` 不包含 Mac。
范围创建后不能改变；既有稳定通道不允许静默丢失平台，仍由 Promote 拦截。
`--repo owner/repository` 显式指定仓库，`--poll` / `--timeout` 调整等待间隔与时限。

## 持久化和恢复

- 状态文件：`~/.xharness/release-tasks/<owner>--<repository>/<version>.json`。
- 保存版本、范围、精确 SHA、关联 ID、Run ID、attempt 和失败历史；不保存密钥。
- 原子替换文件，写入前 fsync；使用操作系统锁，进程退出自动释放。
- 请求前先落盘意图。网络超时或进程被杀后，通过唯一关联 ID 的 Run 名找回请求，不重复 POST。
- 退出 CLI 只停止等待，不取消远程工作。重复运行同版本继续已有任务。
- 不同电脑不共享本地锁，应指定一台发布控制机；远端不可变标签、Draft 与发布门禁继续防止覆盖，
  不承诺全局 exactly-once。

| 异常 | 行为 |
| --- | --- |
| CI 未完成 | 等待，不创建标签 |
| CI 失败或跳过必需 Job | 阻断，不用旧成功结果顶替 |
| master 在派发构建前变化 | 阻断，不偷偷更换候选代码 |
| 派发响应丢失 | 查关联 ID，查不到保持 unknown；`--retry` 也不盲目重发 |
| 验收失败 | 不发布；检查后 `--retry` 创建新尝试并保留旧记录 |
| 构建/发布失败且已有同版本 Draft/Release | 不删除、不覆盖，人工检查收据与线上状态 |
| 已验证 Run 被外部重新运行 | 拒绝沿用旧 attempt 的下游证据 |
| 提前确认或版本不匹配 | 拒绝发布 |
| 状态文件丢失 | 不猜测接管已有版本，不自动删除重建 |

未知请求和丢失状态需要维护者介入，不应让模型删除状态/标签/Draft 强行重试。
master 变化需重新审查，确认旧任务没有已派发操作后人工处理记录，或使用新版本任务。

## Workflow 边界

四个既有 Workflow 增加可选关联 ID，仅用来定位运行，不是信任凭据。
Desktop Release 增加 `prepare_tag` 和 `expected_sha`：托管运行先校验 SHA 与 CI，再用
`GITHUB_TOKEN` 创建标签并继续原流程。该 Token 创建标签不会额外触发标签 push 构建。
已有标签必须指向相同提交，不能强制覆盖。仅 plan 增加标签写权限，矩阵构建仍只读。
本地协调器没有上传资产、移动 latest 或删除 Release 的实现。

## 测试与交付边界

离线测试覆盖成功流程、确认、进程中断、持久意图、未知网络响应、延迟可见、重复关联 ID、
来源不匹配、master 变化、CI/Job 门禁、显式重试、不可变 Draft、原子保存及跨进程锁。
测试已加入 Linux / Windows / macOS 的 update-channel-contract CI。

后续真实发布单独验收：关联 Run 发现、托管创建标签无重复构建、签名包生成、原生升级验收、
确认后 Promote。离线测试通过不代表远程发布已发生。

## 2026-10-06：服务器托管与同机平台流水线

新发布的推荐入口（必须先合入 master 并通过 CI，版本仅为示例）：

```sh
# 只交接一次；关电脑不影响 GitHub 上的构建/验收。默认只准备，不发布。
python3 -B scripts/release.py 0.2.38 --hosted --platforms all-macos-preview

# 已明确授权这一版发布时，在首次交接时记录版本绑定的发布意图。
python3 -B scripts/release.py 0.2.38 --hosted --platforms all-macos-preview \
  --publish-after-acceptance 0.2.38
```

同一个版本的两种命令不能交替使用：版本、SHA、范围、模式、发布意图首次创建后锁定。
已开始的旧任务（例如 0.2.37）继续用旧命令，不转换、不重复构建。

### 流水线和完整性

```text
托管协调器：锁定源码 → 精确 SHA CI
                         ↓
四台原生机器：构建/签名 → 上传不可变包 → 同机准备原生升级验收
                         ↓                       ↓
汇总机器：等全部包 → 独立验签/收据/符号 → 完整 Draft/候选清单
                                                 ↓
四台原生机器：验证同一份完整候选 → 实际升级/重启/数据保留验收
                                                 ↓
托管协调器：整个构建运行全绿 → 独立 Promote 重新校验 → 验证公开资源
```

- 汇总 job **只依赖 plan**，不依赖等待它的 build jobs；否则会形成环路。
  包和符号先上传，汇总只写 Draft，不能改变线上 latest。
- Unix BASE 的准备和编译在本平台签名包上传后立即开始，可与较慢平台构建重叠。
  不重新编译 Host；复用已经 staging 的同源码 Host 和同机热 Cargo target。
- 运行前必须下载**全部平台的完整候选**，验证签名、精确源码、构建 attempt 和清单。
  不使用单平台临时清单，不事后改写验收的 manifest hash，也不改动目标签名包。
- Unix 仍进行三轮生产 updater handler 安装/重启/保留数据验收；Windows 仍用真实稳定版
  安装程序升级到新候选。并未把 smoke test 当成升级验收。
- `acceptance_mode=in-build` 是计划和包收据中的显式绑定，验收来源必须是**同一个构建
  run/attempt**。旧计划缺省仍使用原来的独立 Unix/Windows 验收来源。不能混用。
- Promote 仍是唯一线上发布者；只接收全绿构建和完整四平台验收，重验 CI、原生收据、
  签名、未变更 Draft、现网基线和匿名可读更新资源。Mac 公证策略不改变。

### 持久状态、网络与失败

`Desktop Release Service` 不占用子工作流的发布并发锁。协调器无更新私钥，只有 GitHub
调度权限。源码变动不会自动换 SHA；失败不会自动重试编译或重发发布。

每次非幂等 dispatch 之前，先把状态保存为同一个服务 run 下的不可变 artifact：
`release-task-<version>-<run-id>-<attempt>-<revision>/task.json`。它只含公开版本、源码和
关联 Run ID，不包含密钥、用户配置或聊天。相同状态不重复上传。

维护者恢复**同一个服务 run**（Actions → Re-run failed jobs），协调器从最高 attempt/
revision 的认证 checkpoint 恢复。未知 POST 仅查关联 Run，绝不盲目重派。没有状态的
rerun、已过期/重复/来源错误的 checkpoint 都停止，需要人工审查，不新建同版任务。
GitHub 读/连接故障最多六次退避；原生失败、签名失败、来源冲突、未知 checkpoint 上传
不自动重试。总等待有四小时时限，失败保留证据，现网版本不动。

准备模式停在 awaiting_confirmation 后，可下载最新 task.json 到原有本机状态目录，
核实 SHA/范围后用旧入口 `--confirm-publish <version>` 确认；不能把 hosted 交接文件直接
当作 ReleaseTask 状态。日常已批准的整版发布应使用首次交接的版本绑定授权，避免这步。

### 验收边界

离线回归覆盖状态交接、未知 dispatch、checkpoint 先写后发、异常恢复边界、DAG 环路、
完整清单/签名/来源绑定和失败不得发布。现有跨平台 CI 继续测试生产 updater 驱动。
**不能据此声称已经测出全平台发布耗时下降**；新流水线合入后首次准备候选时，还需用
真实签名包验证托管 checkpoint 和完整 native pipeline，记录构建/等待/验收四段耗时。
