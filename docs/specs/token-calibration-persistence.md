# Token 校准持久化与重启恢复

## 故障与范围

2026-09-17 桌面重启后，同一真实会话从校准估算约 55 万跳到保守估算约 145 万，触发预算拦截和失败的 Compact。三次历史 Compact 已生效，问题不是完整历史复活。

本次只修校准持久化；不放宽硬上下文上限、不修改历史、不改变 Compact 摘要预算。

## 数据与隔离

- `xharness-token::Calibration` 提供版本化快照与校验，保留原来的相似分布判断、至少 8 个样本、1.25 安全系数和 256 额外预留。
- 文件：Host state 目录下的 `token-calibration-v1.json`。
- 只存 SHA-256 scope/request 标识、三类字节特征、结构开销、图片计数、真实输入 Token 数和采样时间；不存接口原文、模型名称、API Key、对话、工具 Schema 或请求正文。
- scope 包含实际接口 endpoint、模型、协议编码/请求控制参数、工具 Schema、思考参数、usage 输入统计口径；这些信息先哈希再入缓存。
- 修改输出上限不改变 scope；轮换 API Key 不改变相同部署的计数 scope。相同地址/模型背后发生不可见部署变化时仍需靠过期、分布检查、低估反馈和服务端超限失效兜底，缓存不是准确 tokenizer。
- 最多 64 个 scope、每 scope 32 条样本、文件 2 MiB、样本有效期 7 天；未来时间样本不采信。

## 生命周期

1. Host 已取得 state 目录独占权后，在阻塞线程读取和校验快照。
2. 所有动态注册的模型共享一个 store，配置刷新/重建 Provider 不丢样本。
3. 两种协议在 `Completed` 有有效 usage 时，用适配后的非缓存输入 + 缓存读取 + 缓存写入总量学习。
4. 每次完整响应更新一次，不随流式 delta 写盘。阻塞线程内串行修改并写临时文件，sync 后原子 rename；Unix 文件权限 0600。
5. 服务端上下文超限时使对应 scope 失效并落盘；真实用量突破估算时复用原有样本重置规则。
6. 文件损坏/未知版本/越界/过期/符号链接时退回保守估算；磁盘写入失败保留内存校准并输出不含敏感数据的告警，不把正常响应改成失败。

共享 store 依赖生产 Host 已有的 state 目录独占锁；不支持多个独立进程绕过 ownership 同时写同一缓存。

## 测试

- 暖态 → 快照 → 新实例恢复，估算完全一致，模拟 145 万冷估算/约 55 万暖估算的预算边界。
- scope 隔离、模型/接口/协议/工具/思考/统计口径变更；输出预算和 API Key 轮换不误清缓存。
- TTL/未来时间、坏 JSON、版本、文件上限、非法样本、失效持久化。
- 并发完整响应写入、恢复两个 scope、0600、写入失败、符号链接保护。
- 模拟 HTTP Chat Completions/Responses 各 8 次成功响应，重建 Provider 后恢复；随后 HTTP 上下文超限清掉持久化 scope；检查文件不含正文/密钥/模型/URL。
- Rust 测试与 Clippy 在 WZU_Server 运行，不在 Mac 编译。

## 发布边界

旧版本未保存过的内存样本不会凭空恢复。本补丁不在启动时自动反推旧历史；另提供显式离线回填脚本，当前未修改现有用户 state。首次升级没有快照时仍需要有效样本；已卡住的旧会话可按下述维护流程恢复；不能伪造真实计数或直接跳过预算。

源码回归通过不等于已安装桌面更新；Mac/Windows 文件替换语义仍需跨平台 CI 验收。

## 本次验收记录

- WZU_Server：`xharness-token`、`xharness-provider-openai`、`xharness-host-app` 共 **119 passed / 0 failed / 1 ignored**。
- WZU_Server：`xharness-core`、`xharness-compaction`、`xharness-agent`、`xharness-host` 回归 **288 passed / 0 failed / 4 ignored**。
- 三个直接修改 crate 的 `cargo clippy --all-targets -- -D warnings` 通过。
- 合计 **407 passed / 0 failed / 5 个既有 ignored**。HTTP 回归为可控模拟服务，不冒充真实 DeepSeek 或 Mac/Windows 安装验收。


## 旧版样本回填（显式维护流程）

工具：`scripts/backfill-token-calibration.py`；默认只生成新的候选文件，拒绝覆盖文件，不写运行中 Host 的 state。

1. 操作者指定会话、Provider/模型及已确认的旧版 usage 统计口径；只支持能够重建的 `openai-wire/v2` 文本 Chat 审计。Responses/图片/浮点 wire 结构/旧内联日志不猜测迁移。
2. 按 turn/step 配对 request/header 与完整 assistant/message 的归一化 usage；重复请求头或缺失 usage 不采纳。只检查最近最多 64 个完整请求，保留最多 32 个样本。
3. 使用现有数值特征提取器，校验内容寻址 blob SHA-256；重建旧版 wire 控制参数，必须精确匹配 journal 中的 scope 指纹。由此验证接口、实际模型、工具/思考参数和编码版本，没有可靠匹配就跳过。
4. 显式确认的旧 usage 口径加入新版 scope，保留响应原时间戳，不把旧样本续期。参数/正文只在本机读入内存，输出仍只有数字和哈希。
5. Python 旧版迁移编码器用固定合成 fixture 与实际 Rust Provider 的 scope、request hash、WireFeatures 交叉验证；运行期继续只用 Rust 编码器。
6. 在 Host 停止、数据目录独占的安装维护窗口，备份现有缓存后再应用验证过的候选文件；若已有新缓存，不应直接覆盖，需重新评估合并/时效。运行中不热塞。

当前真实会话提取到 32 条同 scope 样本，无跳过。最后一个成功请求的服务端输入 439,242，冷估算 1,480,652，恢复估算 549,870。这里是**最后一个成功请求**的离线验算，不是当前失败请求的服务端计数，也不代表已经自动继续了用户任务。

旧 scope 本身不包含 usage 口径，不能证明历史配置从未变化。因此旧口径必须由维护人员依据当时部署明确确认，不能无人值守推断。脚本不读取 API Key，也不进行任何网络请求。
