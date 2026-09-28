# 用户插件运行时：目录、安装与能力边界

## 当前可用链路

1. **导入目录**：插件中心“添加目录”选择 `marketplace.json`；当前“公开／个人”标签决定导入目录归属，两个目录分别保存。Host 校验条目名称、`https` ZIP 来源、固定 SHA-256 和重复项，再以版本化状态快照保存。目录 JSON 是索引，不是可执行代码；私有 GitHub 仓库的访问凭据不进入软件和前端。
2. **安装**：用户选条目并确认来源和摘要。Host 检查 DNS 公网地址、禁用重定向、限制压缩包 64 MiB / 解压 128 MiB / 2048 项、防路径穿越与符号链接，下载后核对 SHA-256；检查 `.zcode-plugin/plugin.json` 或 `.claude-plugin/plugin.json` 的名称匹配，再暂存并发布。安装后默认**停用**。
3. **启用与使用**：当前只有 `skills/<name>/SKILL.md` 是可运行能力。启用后，新一轮 Tool Registry 才注册一个 `plugin_skill` 工具，工具描述保持简短；模型先用 `action=list` 按需列出名称与简介，再用 `action=read` 读取 `SKILL.md`，需要引用资料时以 `action=resource` 读取包内文本资产；每个文件不超过 64 KiB，插件脚本只作为文本返回、不由插件运行时执行。旧轮次的 Tool 快照不被中途改写。`skill.list` 同步显示已启用的技能。
4. **禁用、卸载、更新**：状态持久化；禁用会阻止后续按需读取，卸载移除当前安装包。目录重新导入后按 SHA-256 比较产生更新提示。更新重新安装且默认停用，需再次检查、启用。
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

`.mcp.json`、`commands/`、`agents/`、`hooks/` 只可见为包能力元数据，**不会启动进程、注册 MCP Tool、执行 Hook 或注入 JavaScript**。这些能力需要独立的显式权限审批、进程监督/取消、输入输出限额、密钥引用、跨平台退出清理、Session 级归属与真实集成测试；不能把“ZIP 能安装”误称为“插件全功能可运行”。特别是 `.mcp.json` 可能启动 `npx` 等会下载执行代码的命令，不应在普通 Skill 启用时隐式运行。

## 协议

动态 Host RPC：`plugins/catalog`、`plugins/installed`、`plugins/updates`、`plugins/importCatalog`、`plugins/install`、`plugins/enable`、`plugins/disable`、`plugins/uninstall`、`plugins/skills`。参数放在 `payload.args`。源状态在 Host 的 `state-dir/plugins/`，不是 Web LocalStorage。目录导入和安装均为用户操作，模型没有这些管理端点作为工具。

## 回归门槛

- Rust：目录校验、非法 URL/IP、ZIP 路径穿越、SHA-256 失败、安装/启停/读取/重启/卸载、动态 Host RPC、真实 CDN 固定包测试。
- Web：插件页源码与出厂 Bundle 同步、boot graph 校验、分类/搜索/操作入口测试。
- **Rust 只在 WZU_Server 等远端运行 `cargo` 测试和检查**；本机只执行 `cargo fmt` 与 Node 测试。
