# 上游候选增量：141eb6fef8 → b150a551b8

**审计日期：** 2026-08-21  
**当前冻结基线：** `141eb6fef834`（0.1.0-rc.8）  
**候选上游：** `b150a551b8d4`（0.1.1-rc.2）  
**结论：** 暂不移动冻结基线；先迁移新增 Authorization Seam 并完成新版 Web 双版本测试。

候选树由独立浅克隆读取，没有 Fetch/Merge 当前上游工作树。候选机器目录保存在
[`candidate-b150a551b8.json`](candidate-b150a551b8.json)。

## 自动目录差异

| 目录 | 差异 |
| --- | --- |
| 固定 RPC | 仍为 52 个；名称集合无变化 |
| Session Event | 仍为 48 个；事件集合无变化 |
| Tool 注册点 | 仍为 63 个；Literal 名称集合无变化，只有源码行移动 |
| Prompt Section 注册点 | 仍为 28 个；名称集合无变化，只有源码行移动 |
| Agent Preset | 仍为 4 个；元数据无变化 |
| Package | 233 → 234；新增 `@deepseek-ai/dsh-authorization` |

`rpc-map.ts` 和 `known-event-types.ts` 文件内容逐字相同，因此本次候选不会要求 Rust 修改固定
RPC 名称或 Session Event 判别词。但“目录无变化”不等于业务语义全部无变化，仍需新版 Web
Fixture 和行为测试。

## 新增 Authorization Seam

候选新增 `packages/credentials/authorization`，用于“必须与人交互才能取得的凭据”，例如 OAuth、
打开页面、粘贴 Code 或选择账号。其核心语义：

1. Provider/插件按 `CredentialKey` 注册 Authorization Flow，一个 Key 只能有一个 Flow。
2. 同一个 Key 同时只允许一次授权；第二次请求返回 `ALREADY_IN_FLIGHT`，不能合并两个人的交互。
3. `begin()` 的 Interaction 随调用请求传入，不是全局 UI 单例。
4. Interaction 只有 `notify` 与 `prompt(text | secret | select)`；Secret 仅改变展示，禁止进入日志。
5. Flow 自己通过 Credential Store 提交记录；Flow 返回后 Seam 必须证明本次尝试确实发生了 Commit。
6. 人拒绝或请求取消得到 `cancelled`，不是系统故障；其他异常仍是失败。
7. `authorization/settled` 在 Key 释放之后发布 `authorized | cancelled | failed`。
8. Authorization 完全不进入模型 Prompt，也不应造成 KV Cache 失效。
9. 当前上游 Flow 本身不可恢复；刷新或进程退出后需要重新发起。

## Rust 映射

该变化并不要求复制 Cordis Service。Rust 计划增加：

```text
xharness-credentials
  CredentialKey / CredentialStore / Secret-safe reference

xharness-authorization
  AuthorizationRegistry
  AuthorizationFlow
  AuthorizationInteraction
  one-in-flight-per-key gate
  cancellation + settlement events

xharness-host
  Authorization RPC/Remote adapter
  Web prompt/notice projection
```

Authorization 必须建立在 `P0-09 配置与凭据边界` 之上；在 Secret Reference、Redacted Debug 和
Event Log Secret 禁止规则完成前不得直接存储 Token。

## 升级门槛

- [ ] Rust 兼容目录能提取新版 Authorization Service/事件/动态 Remote。
- [ ] Credential Store 与 Authorization Registry 有独立中文 Spec。
- [ ] Secret Prompt 不进入 Session、Tracing、错误和 Debug。
- [ ] 同 Key 并发、取消、拒绝、Flow Dispose、未 Commit 返回均有测试。
- [ ] 旧 Web dist 与候选 Web dist 都能连接同一个 Rust Host。
- [ ] 完成后再更新 `UPSTREAM_CONTRACT_REVISION` 和冻结 Catalog。
