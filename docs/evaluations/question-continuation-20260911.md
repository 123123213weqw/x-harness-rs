# 问答 60 秒继续：真实模型验收

## 环境

- WZU_Server，远程 Rust debug 构建，无本机 Rust 编译。
- 隔离 Host、端口、会话和临时工作区，测试文件仅 README.md；未修改生产服务。
- DeepSeek 官方 `deepseek-flash`，关闭思考，仅测试工具与生命周期。
- 密钥只通过 stdin 传至测试进程，继承给隔离 Host；不写入源码/配置/验收日志。

## 已观察结果

1. 模型实际调用 `ask_user_question`，询问测试标签 Alpha/Beta。
2. 60.022 秒后产生 `question/deferred` 和成功工具结果；`answers=[]`，没有推荐项自动选择。
3. 模型调用 read：首次传绝对路径被原有沙箱校验拒绝；模型改为 README.md 相对路径后成功。
4. 模型结束原轮等待，没有创建 Goal、Job、子 Agent，没有反复提问或写文件。
5. 停止并重启隔离 Host，提交同问题的 Beta 答案，服务返回 `accepted:true`。
6. 模型在后续轮确认 Beta，完成两轮交互。
7. 第二次独立实验测得 60.018 秒，并在答案交付后再次重启，确认没有重复生成新轮或重复投递答案。

结论：超时继续、真实只读工具、原路径权限、待答持久化、重启后的迟答与后续轮均可工作。
此测试不代表原生桌面安装包已更新；当前仍需要 CI 构建与部署。

## 回归

远程 333 项 Rust 测试通过（19 组），Clippy `-D warnings` 通过；Chromium/WebKit 验证同问题超时不清空草稿、重复帧不生成重复卡片、切换问题不继承草稿；补丁有语法、哈希、幂等与锚点漂移拒绝检查。

可复跑驱动：`scripts/eval-question-continuation.py`。需要调用者显式通过 stdin 提供测试凭据；只在远程构建完成后运行。后端二进制可由 `XHARNESS_TEST_HOST_BIN` 指定。
