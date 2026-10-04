# 用户插件运行时：目录、安装与能力边界

## 当前可用链路

1. **目录**：产品入口离线预置经校验的公开目录，ZIP／图标来自 `https://engine.xxdevs.com/plugins/`，Host Ready 不等待网络。已有目录仅在名称、版本、SHA-256 及公开仓库原始 URL 全部匹配时迁移来源；个人条目、自定义来源和不同版本不改写。通用 `PluginManager::open` 仍不预置目录。插件中心“添加目录”选择 `marketplace.json`；当前“公开／个人”标签决定导入目录归属。目录 JSON 是索引，不是可执行代码；私有 GitHub 仓库的访问凭据不进入软件和前端。
2. **安装**：用户在应用内 Modal 确认来源和摘要，不使用 WebView 可能不支持的 `window.confirm`。取消、Esc、关闭不发送变更；重复确认只发送一次，失败不自动重放。Host 复用 WebFetch 的严格公网解析：代理 Fake-IP 主机名须经独立加密 DNS 验证，再固定真实公网地址；不允许私网、混合私网 DNS 或直接 Fake-IP，且不继承会话 Full Access。解析最长 15 秒，下载最长 90 秒，禁用环境代理及重定向。限制压缩包 64 MiB / 解压 128 MiB / 2048 项、防路径穿越与符号链接，下载后核对 SHA-256；检查 `.zcode-plugin/plugin.json` 或 `.claude-plugin/plugin.json` 的名称匹配，再暂存并发布。安装后默认**停用**。
3. **启用与使用**：`skills/<name>/SKILL.md` 由 `plugin_skill` 按需列出、读取；每个文本文件不超过 64 KiB，插件脚本只作为文本返回、不由 Skill 运行时执行。`.mcp.json` 的本地 stdio 服务需**另行预览命令、参数、环境变量目标名及来源名（不显示值）并确认启用**；随后新一轮 Tool Registry 才注册 `plugin_mcp`。模型用 `list` 逐级列出插件、服务和简短 Tool 索引，再以 `describe` 读取单个 Tool Schema、`call` 调用；不把全部 Schema 塞入一个 Tool Result 或每个请求。旧轮次的 Tool 快照不被中途改写；执行前复核当前启用状态，并使用可撤销租约阻止禁用与进程启动之间的竞态。
4. **禁用、卸载、更新**：Skill 与 MCP 独立启停。禁用／卸载 MCP 会取消在途调用并关闭子进程；调用超时也会关闭对应子进程，空闲十分钟的会话连接自动回收，后续使用按需重连；Host 退出关闭全部 MCP 子进程。目录重新导入后按 SHA-256 比较产生更新提示。更新重新安装且默认停用，需再次检查、启用。
5. **恢复**：状态写入不可变快照，启动读取最后一个有效版本；单个最新文件损坏可回退。插件状态若完全不可读，只让插件后端不可用，不阻断 Agent Host 启动。

### 私有 `xharness-plugins` 仓库导入

不要把 GitHub token 或私有仓库内容编入公开安装包。已登录 GitHub CLI 的维护者可在本机执行：

```sh
gh api -H 'Accept: application/vnd.github.raw+json' \
  repos/123123213weqw/xharness-plugins/contents/marketplace.json \
  > marketplace.json
```

然后在插件页选“公开”或“个人”，点击“添加目录”，选择 `marketplace.json`。目录中的第三方 ZIP 仍由 Host 根据各自 SHA-256 校验。离线或无 GitHub 权限的客户端不会假装目录已连接。

## 明确未开放的能力

当前仅实现 `.mcp.json` 的**本地 stdio Tool**；HTTP/SSE Transport、MCP Resources/Prompts、OAuth、`commands/`、`agents/`、`hooks/` 仍不可运行，也不注入 JavaScript。stdio 进程按会话隔离，运行环境只含必要系统变量及配置显式引用的环境变量；服务发现、Schema、返回值和调用时间均有限额。普通权限模式下 `plugin_mcp` 仍须工具审批；Full Access 沿用全局免审批语义。用户若明确启用 `npx` 等命令，该命令自身仍可能联网下载依赖，不能把目录安装等同于进程执行授权。

## 协议

动态 Host RPC：`plugins/catalog`、`plugins/installed`、`plugins/updates`、`plugins/importCatalog`、`plugins/install`、`plugins/enable`、`plugins/disable`、`plugins/uninstall`、`plugins/skills`、`plugins/mcpPreview`、`plugins/mcpEnable`、`plugins/mcpDisable`。参数放在 `payload.args`。源状态在 Host 的 `state-dir/plugins/`，不是 Web LocalStorage。目录导入、安装和 MCP 启停均为用户操作，模型没有这些管理端点作为工具。

## 回归门槛

- Rust：目录校验、非法 URL/IP、ZIP 路径穿越、SHA-256 失败、安装/启停/读取/重启/卸载、动态 Host RPC、真实 CDN 固定包测试；MCP 的 stdio 握手、发现、调用、跨会话隔离、配置篡改、在途取消、禁用竞态、超时关闭、空闲回收和 Host 关闭。
- Web：插件页源码与出厂 Bundle 同步、boot graph 校验、分类/搜索/操作入口测试。
- **Rust 只在 WZU_Server 等远端运行 `cargo` 测试和检查**；本机只执行 `cargo fmt` 与 Node 测试。
- 发布通道契约：`python3 -B scripts/test-plugin-distribution.py`。覆盖来源／哈希／路径／符号链接／ZIP／SVG／库存绑定、不可变文件冲突、原子目录切换、重放、安装包路径隔离、受限 SSH 命令、固定跳板及实际下载校验。
- UI 使用真实页面 Dialog，Chromium／WebKit 均覆盖取消、Esc、关闭、重复确认、安装失败后恢复、MCP 预览失败及切页后迟到预览；参考旧 JS 的测试仅保留旧行为，不作为新实现验收。

## 公开插件的自动同步

见 [插件发布运维](../runbooks/plugin-distribution.md)。公开目录与软件更新通道独立；此同步不发布、覆盖或重启 XHarness 安装包，也不启动 MCP。

### 下载实现的职责边界

`xharness-plugins` 声明 `PackageClient` 注入接口，保留独立、严格的系统 DNS 默认实现；不依赖 WebFetch／Host／Tool 的 crate 或运行状态。产品组成层的 `open_product_plugin_manager` 注入共享公网验证客户端，以复用 WebFetch 的 Fake-IP 加密 DNS 验证与地址固定；没有放宽被冻结的架构依赖清单。通用插件库遇到无法验证的合成 DNS 仍失败关闭，不能通过目录配置绕过。

### 真实插件验收（隔离环境，手动触发）

`plugin_mcp_live` 使用公开 CDN 中固定 SHA-256 的 `cloudbase-skills@0.1.0` ZIP，在临时插件状态目录中实际走目录导入、安装、MCP 命令预览、独立启用、`npx` stdio 握手、40 个 Tool 的简短索引与单个 Schema 读取、只读 `searchKnowledgeBase(mode=docs, action=listModules)` 调用，以及停用后旧 Tool 快照拒绝访问。测试不会修改用户现有的 XHarness 状态或桌面安装；需要联网和 Node/npm，CI 默认忽略。V100 验收命令：

```sh
cargo test --locked -p xharness-host-app --test plugin_mcp_live -- --ignored --nocapture
```

此测试验证 Host/Tool 主链路，**不等于桌面端手工点击验收**；发布前仍需用新版桌面包检查预览弹窗、启停状态和错误呈现。
