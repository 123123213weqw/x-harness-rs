# 用户插件运行时：目录、安装与能力边界

## 当前可用链路

1. **导入目录**：插件中心“添加目录”选择 `marketplace.json`；当前“公开／个人”标签决定导入目录归属，两个目录分别保存。Host 校验条目名称、`https` ZIP 来源、固定 SHA-256 和重复项，再以版本化状态快照保存。目录 JSON 是索引，不是可执行代码；私有 GitHub 仓库的访问凭据不进入软件和前端。
2. **安装**：用户选条目并确认来源和摘要。Host 检查 DNS 公网地址、禁用重定向、限制压缩包 64 MiB / 解压 128 MiB / 2048 项、防路径穿越与符号链接，下载后核对 SHA-256；检查 `.zcode-plugin/plugin.json` 或 `.claude-plugin/plugin.json` 的名称匹配，再暂存并发布。安装后默认**停用**。
3. **启用与使用**：`skills/<name>/SKILL.md` 由 `plugin_skill` 按需列出、读取；每个文本文件不超过 64 KiB，插件脚本只作为文本返回、不由 Skill 运行时执行。`.mcp.json` 的本地 stdio 服务需**另行预览命令、参数、环境变量名并确认启用**；随后新一轮 Tool Registry 才注册 `plugin_mcp`。模型先列出已启用插件／服务，再按需取 Tool Schema 和调用，不把全部 Schema 塞入每个请求。旧轮次的 Tool 快照不被中途改写；执行前仍复核当前启用状态。
4. **禁用、卸载、更新**：Skill 与 MCP 独立启停。禁用／卸载 MCP 会取消在途调用并关闭子进程；Host 退出也关闭全部 MCP 子进程。目录重新导入后按 SHA-256 比较产生更新提示。更新重新安装且默认停用，需再次检查、启用。
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

- Rust：目录校验、非法 URL/IP、ZIP 路径穿越、SHA-256 失败、安装/启停/读取/重启/卸载、动态 Host RPC、真实 CDN 固定包测试；MCP 的 stdio 握手、发现、调用、跨会话隔离、配置篡改、在途取消和 Host 关闭。
- Web：插件页源码与出厂 Bundle 同步、boot graph 校验、分类/搜索/操作入口测试。
- **Rust 只在 WZU_Server 等远端运行 `cargo` 测试和检查**；本机只执行 `cargo fmt` 与 Node 测试。

### 真实插件验收（隔离环境，手动触发）

`plugin_mcp_live` 使用公开 CDN 中固定 SHA-256 的 `cloudbase-skills@0.1.0` ZIP，在临时插件状态目录中实际走目录导入、安装、MCP 命令预览、独立启用、`npx` stdio 握手、40 个 Tool 发现、只读 `searchKnowledgeBase(mode=docs, action=listModules)` 调用，以及停用后旧 Tool 快照拒绝访问。测试不会修改用户现有的 XHarness 状态或桌面安装；需要联网和 Node/npm，CI 默认忽略。V100 验收命令：

```sh
cargo test --locked -p xharness-host-app --test plugin_mcp_live -- --ignored --nocapture
```

此测试验证 Host/Tool 主链路，**不等于桌面端手工点击验收**；发布前仍需用新版桌面包检查预览弹窗、启停状态和错误呈现。
