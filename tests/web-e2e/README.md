# Web 黑盒 E2E

这组测试直接驱动真实 Chromium、编译后的 `xharness-host` 和实际发布的
DeepSeek Harness Web 静态资源，不使用模拟 Host。

覆盖范围：

- 页面可加载默认 Workspace，访问模式按钮可点击；
- 选择 Full access 必须经过风险确认，取消不改变权限，确认后投影为
  Full access；
- 创建真实 Session 后，切断承载层 TCP 代理并连续制造至少 8 次重连失败；
- 恢复连接后，Web 必须重新请求 Host、Workspace、Session、History 和
  Settings 基线，并恢复 Full access 投影；
- 真实 Host 进程重启由 Rust 集成测试
  `xharness-host-app/tests/restart.rs` 覆盖，避免把“网络抖动”和“进程内状态
  丢失”混成一个场景。

## 运行

```bash
cd tests/web-e2e
npm ci
npx playwright install chromium

XHARNESS_HOST_BIN=/absolute/path/to/xharness-host \
XHARNESS_WEB_DIST=/absolute/path/to/ui/dist \
npm test
```

测试会自己选择空闲端口、创建临时 Workspace、启动和停止 Host。请勿让
`XHARNESS_HOST_BIN` 指向当前正在为用户服务的 LaunchAgent 进程。
