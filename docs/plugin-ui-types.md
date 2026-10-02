# 插件中心 TypeScript 迁移：第一阶段

## 范围与边界

这一阶段不改布局，不换框架或模块加载器，也不把全部上游产物一次性重写。

- `ui/src/plugin-api/contracts.ts` 定义插件中心 13 个 RPC 的请求、响应、DTO 和成功／失败联合类型。
- `ui/src/plugin-api/client.ts` 把网络返回值视为 `unknown`，先校验 envelope 和嵌套字段，再交给页面。
- 现有插件中心 `client.js` 通过 `checkJs`、JSDoc 和严格模式参与检查；不是只检查新增 TS 文件。
- TypeScript、React 类型声明只属于开发依赖。没有增加运行时 npm 依赖、第三方校验库或一份 React。
- TS 编译后的普通 JS 沿用 `window.__ModuleLoader__`；客户端依赖图明确声明 helper 在页面之前加载。

依赖图用 `external` 声明代码到达依赖；`inject` 仅描述 Cordis 服务，数组排列先后也不能约束并发下载。
浏览器回归强制延迟 helper 脚本响应，检查页面冷启动不会提前 `require` 尚未注册的模块。

类型覆盖目前仅限插件中心和它的连接边界。其他页面、上游 bundle 和 Host 协议未全部迁移到 TS。

## 更新代码与生成资产

在仓库根目录运行（只涉及 JS/TS，不编译 Rust）：

```sh
npm ci --prefix ui --ignore-scripts
npm run typecheck --prefix ui
npm run build:plugin-api --prefix ui
node scripts/refresh-plugin-hub-ui.mjs
```

`ui/plugins/@xlang/xharness-client-plugin-api/client.js` 是生成文件，不手工编辑。
刷新脚本同时更新 `ui/dist` 内的两个模块、SHA-256 revision、client graph 和 HTML boot graph，避免页面与依赖图版本不同。
完整 `scripts/rebuild-ui.sh` 是无参数的本仓库构建入口，也安装锁定开发依赖，并在组装阶段重新校验／编译该边界。
安装包仍使用已提交的 JS 产物，终端用户不需要 npm 或 TypeScript。

## 错误与兼容行为

- 缺失 `plugins`、错误字段类型或 malformed envelope 明确报错，不能伪装成空列表。
- 只对 Rust 声明的默认字段以及已知旧 Host 缺少 `sourcePreference` 做兼容；不宽松接受任意缺字段。
- 增加服务端字段不会令运行时解码失败；删除或改错现有字段会失败。
- 自动后台刷新只静默处理旧 Host 的精确 `unsupported plugin endpoint plugins/refreshCatalog` 错误。
- 刷新失败保留上一份成功数据，操作结束释放 busy 状态。
- 不自动重试安装、启用或卸载，避免网络断开后重复产生副作用。
- 响应错误不插入 HTML，校验失败消息不包含原始响应正文。

## 回归门禁

```sh
npm run check:plugin-api --prefix ui
node scripts/refresh-plugin-hub-ui.mjs --check
node --test scripts/test-plugin-api.mjs
node scripts/test-plugin-center.mjs
UI_TEST_DEPS=/path/to/isolated-ui-test-deps UI_TEST_BROWSER=chromium node scripts/test-plugin-hub-functional.mjs
UI_TEST_DEPS=/path/to/isolated-ui-test-deps UI_TEST_BROWSER=webkit node scripts/test-plugin-hub-functional.mjs
```

编译负例使用 `@ts-expect-error`，验证端点拼写、参数和返回字段确实被检查；它不是绕过生产类型检查的注解。
浏览器用隔离 fixture 验证导入、安装、Skill 启用、MCP 同意、取消、离线和格式异常，不触碰真实用户数据。

Rust 按仓库策略在远程服务器运行，先同步包括未提交修改的源码并排除环境文件、密钥、`.git`、`target` 和 `node_modules`：

```sh
# 在远程同步目录内执行；不得在本机运行这一条。
XHARNESS_PLUGIN_WIRE_FIXTURE=/tmp/plugin-wire-replies.json \
  cargo test --locked -p xharness-host-app --test plugin_wire_contract
```

取回 fixture 后，本机执行 `node scripts/test-plugin-wire-contract.mjs /path/to/plugin-wire-replies.json`。
测试对照 Rust **实际序列化**字段，验证 13 个端点。安装／刷新成功回复使用同一共享 Rust DTO 构造，其余来自真实 NativePluginBackend 调用；不把这些 fixture 宣称为公网下载或真实 MCP 进程验收。

CI 在现有 UI job 增加严格类型、生成资产一致性和两种浏览器门禁；Linux Rust job 对照真实 serde fixture，不另开一轮完整 workspace 编译。

## 下一阶段

门禁稳定后，把插件中心组件迁为 TS/TSX，复用现有 typed client，再按页面迁移其他自有模块。
旧 UI 的源码迁移仍待逐模块完成。新的独立构建已停止调用字符串补丁链，旧修复作为固定基线保留。

## 当前验收限制

本阶段的严格检查、接口单测、真实 Rust 回复契约、Chromium/WebKit 操作和实际静态模块加载均已验证。
类型层第一阶段验收时，旧组装链报过 `Composer plus trigger signature changed`，改动前也可复现。
随后独立构建改为只读取本仓库输入，移除了那条组装／补丁链，不再将修复外部构建兼容作为前置条件。
当前构建方式与门禁见 `docs/standalone-ui-build.md`。未替换软件或发布安装包，也未宣称 GitHub CI 已运行。
