# 输出截断提示与后续运行冲突：复现报告

## 结论

确认可复现。不是 max_steps 阶段预算问题，而是旧轮 max-tokens 通知的文案不读取会话运行状态。它保留在历史里没有问题，但其“发送继续”指令在后台已经处理下一条消息时会误导用户。

核对时远端 master 为 09b452f；实验 Host 包含已提交的 df08d77/cd48f75 停止与内部回执队列修复。本机安装包版本 0.2.18。没有更改、重启或发送消息到真实用户会话。

## 可控复现

Fake Provider 前三次返回 finish_reason=length，第四次保持 pending；使用默认 LoopConfig（max_steps=usize::MAX，max_output_continuations=2）。输出只是小段文本，测试的是接口终止语义，不需要实际烧满 token。

1. 无后续消息：同一轮自动续写两次后 turn/end=max-tokens，running=false，共 3 次 Provider 调用。
2. 提前排入独立后续消息：同样截断结束，随后下一轮 turn/start，running=true，共 4 次 Provider 调用。
3. 在第二个场景发送 continue：成为新的 queued 用户输入，确认会多排一条消息。
4. 两个场景均没有 max-steps 结束事件。

注意：第四次请求是在执行独立后续消息，不等于自动续写被截断的原回答。不能把这两件事统一描述成“回答正在续写”。

## UI 证据

将实际 Host session.history 导出的 turn/start、turn/end 事件交给已打包 UI 的 turnMaxTokensDefinition，执行其视图节点构建和 TurnMaxTokensItem 渲染函数（VM 中模拟 JSX 元素创建，不是浏览器截图）。

仓库产物和本机安装包均表现为：
- 下一轮开始不匹配/清除 max-tokens 通知；节点仍存在。
- 提示组件只读取 t 翻译函数，不读取 running/轮次状态。
- running=false/true 的渲染结果完全相同。
- 中文始终为“回答被截断，已有输出保留在对话中。发送‘继续’可让模型接着输出。”，英文行为相同。

本机 bundle SHA-256：d20545946e3cd1d3b58fe5a1b6110f27c432430256315c25c565382b9e0a3455。
仓库 bundle SHA-256：13100b7e4afbe6a66d3682d06c5291840841873450c353052e27c4bde03519ef。

## 重跑

Rust 必须先同步源码至 WZU_Server，再远程执行：

```sh
cargo test -p xharness-host diagnostic_max_tokens_notice_survives_next_turn_start -- --ignored --nocapture
```

该诊断断言当前错误行为，默认 ignored，不将其作为修复后应保留的功能契约。修复时应替换为正确文案的回归断言。

```sh
node scripts/diagnose-max-tokens-notice.mjs docs/evidence/max-tokens-notice-20260914/host-events.json ui/dist/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js
```

## 修复边界（本次未修改生产逻辑）

保留历史截断事实，去掉无条件操作建议。若保留继续引导，需要根据当前运行、后续轮次、明确停止等状态选择文案，不应修改 max_steps，也不能把队列工作误称为回答续写。

远程重复复现：3/3 通过（每次含空队列与有队列两个场景）。完整输出见 docs/evidence/max-tokens-notice-20260914/remote-repeat.log。

## 修复验收

2026-09-14 源码与仓库 Web 产物已修复（未部署安装包）。采用与状态无关的历史事实说明，不再指示用户无条件发送 continue，也不误称独立后续任务为原回答的续写：

- 中文：本轮输出达到上限，已生成的内容已保留。
- 英文：This turn reached its output limit. The generated content has been preserved.

保留标题与旧轮截断节点；不修改输出预算、自动续写次数、max_steps、用户停止或队列调度。

`ui/overrides/max-tokens-notice.json` 保存产品双语文案；`scripts/patch-max-tokens-notice.mjs` 在静态 UI 构建时应用，锚点变化报错，不静默漏补丁。已提交 dist 插件、client-graph 和 index boot manifest 更新，供 Web/Tauri 共用。

`node scripts/test-max-tokens-notice.mjs` 已通过并接入 CI：用上述真实 Host 事件 fixture 执行已打包通知构建/渲染，覆盖无队列、有后续轮次、running、idle、用户暂停、历史恢复；验证双语不含继续操作指令、补丁幂等及上游旧文案替换、产物 hash/boot 一致。

相邻检查也通过：test-execution-checkpoints、test-internal-queue、test-context-plugin、test-brand-headline。此次仅改前端文案与构建脚本，未修改 Rust 生产代码，没有执行本机 Rust 编译。此前远程复现日志是修复前证据，保留不重写；当前正确行为以新 test-max-tokens-notice 为准。
