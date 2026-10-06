# 2026-10-06 已审核 PR 组合修复契约

## 范围

保留 #235、#236、#237、#238、#240、#241、#242、#243、#244 的原提交血缘，在 #245 的并行 CI 上组合验证。使用 merge commit，不通过 squash 隐藏来源；只有组合候选通过 required checks 才允许合入 master。

## 导航

- 插件／工作／Code Review 等本地页面不依赖 Host 首次 session.list 成功。
- 首次未知会话与用户主动打开空白页不同。首次权威列表仅绑定未知历史，不能清空当前页面、浏览历史或前进分支。
- Host 断线时同会话页面仍能前后导航，不调用会话 open／clear；切到未知或被删除的会话仍失败关闭。
- 宽／窄侧栏重挂载通过只读 route-requested／route-changed 投影恢复选中状态，不重放 feature:open，不重复启动 Agent。
- 浏览器 fixture 使用有订阅、有同步选择的 Session 端口，并消费真正 root registration 的 inject 结果，不 mock ShellNavigation。

## Unix 升级验收

- TOML 解析依赖与锁文件，只允许验收驱动所需 reqwest 0.13.4；不兼容、重定向依赖、多版本歧义明确拒绝。
- 已有兼容依赖及 features／default-features 保持原字节；缺失时仅在隔离副本补充。
- Desktop 锁文件依赖只添加一次；重复执行幂等。全部输入验证通过之后才写副本。
- 原源码、签名校验、TLS 证书与主机名校验、停止 Host／安装／重启／数据快照检查均不削弱。

## 回归约束

- 冻结迁移参考树不改动。仅准确列举 settings mask 选择器、子 Agent 删除提示文案、工具参数卡片 CSS／双语字段、16px header glyph 的已审核差异。
- 原 CI 290 次 argv／env 调用完整保留，另补七次新测试调用；不得以删除、跳过检查换取通过。
- Rust 编译和测试只在远程 WZU_Server 或 GitHub runner 上执行。Linux／Windows 原生超时先复验，不能在未确认根因时降低断言强度。
