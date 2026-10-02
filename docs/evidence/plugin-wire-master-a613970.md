# Plugin Center：真实主分支 wire 验收

基线：`a613970c78a36a024de56100078323df25b96004`。
只增加测试 fixture 和校正自有 TS helper；没有修改 Rust 生产协议。

## 实际发现

早期迁移 helper 残留未合并 WIP 的 `PackageSource.mirrors`、`SourcePreference`、
`CatalogRefresh` 以及 `plugins/setSourcePreference`、`plugins/refreshCatalog`。
当前 Rust 主分支不包含它们，第一轮远程 fixture 编译明确失败，不能算验收通过。
已删除这些臆测字段／端点。PluginHub 沿用当前主分支已有交互，不新增未实现功能。

## 验证结果

- WZU_Server：同步当前源码及未提交修改，排除 Git、target、node_modules、环境文件及密钥；
  在远程执行 `cargo test --locked -p xharness-host-app --test plugin_wire_contract`。
  实际结果：1 passed / 0 failed。完整日志留存，没有在本机编译 Rust。
- 实际 Native Host：13 个成功／失败响应，使用独立临时 PluginManager、真实
  NativePluginBackend 和 Host 动态调用；覆盖读取、导入、Skill/MCP 启停、预览、更新检测、
  卸载及两个错误路径。
- 网络安装：仅使用 1 个明确标注的真实 `InstalledPlugin` serde DTO fixture；
  未向公网下载，也不声称真实网络安装通过。
- 下载远程 JSON 后由严格编译的 TS helper 解码：11 个当前 Plugin Center 端点、
  6 个共享 DTO 字段集合、2 个错误响应通过；成功响应解码与实际 serde 数据逐项一致。
- 相关 TS 类型／异常回归 59 项通过；包括不支持端点、错误字段、异步并发隔离、
  端点／响应关联、非幂等操作不重试和真实 MCP `envSources` consent 元数据。

没有使用模型自评、手写 JS 数据代替 Rust 响应，或将一次 fixture 通过当作整图迁移完成。
测试不会读取用户聊天、运行 MCP 子进程、花模型额度、重启软件或更改部署。

## 复现

远程设置 `XHARNESS_PLUGIN_WIRE_FIXTURE` 输出独立 JSON 后，将该指定文件下载至测试目录，执行：

```sh
node scripts/test-plugin-wire-contract.mjs /path/to/actual-rust-fixture.json
node --test scripts/test-plugin-api-types.mjs scripts/test-plugin-api.mjs
```

完整收据位于本机独立目录
`/Users/wangyue/codex-build/xharness-plugin-migration/ui-full-source/merged-main-review/plugin-wire/`。
GitHub CI 已添加同一远程 Rust fixture → TS decoder 对照，但当前修改尚未提交，
不能声称新的 GitHub CI 已通过。

## 最终重跑

冻结前的当前修改再次同步到 WZU_Server 后，原生 Plugin wire 与 Goal remotes 各一个真实 Rust 集成测试通过。
Goal 测试不再依赖旧打包器的全局局部变量名，而从实际 public Remote contribution 捕获当前
strict result schemas；原全部正负断言保留，6 个真实 Host HTTP 响应通过。
Goal 远程完整输出 SHA-256：`58c15c872fb490c17508b3a56fe68b8ce259928e336559b2227e3099306d3650`；
实际响应 JSON SHA-256：`e4fe3db02b85603d2c4ef8ad6ea854f06e652d28bf661e93ee73a93bdcd95585`。
