# Linux `.deb` 安装与沙箱自配置规范

**组成：** `packaging/deb/*`、`scripts/build-deb.sh`、`scripts/remote-build-deb.sh`
**状态：** 安装 Helper、维护脚本和打包流程已实现；真实 WZU_4080 安装需要管理员授权。

## 产品目标

Ubuntu 用户不需要理解 Bubblewrap、AppArmor、User Namespace 或 UID Map。`.deb` 在
`postinst` 阶段完成依赖安装后的系统检测、专用 Profile 安装、真实隔离验证和状态保存。
产品禁止为了安装成功而全局关闭 User Namespace 加固，也禁止自动降级到
`Full access`。

## 包依赖

Debian Control 必须声明：

```text
bubblewrap
apparmor
apparmor-utils
apparmor-profiles
util-linux
bash
ripgrep
ca-certificates
libc6
```

Profile 必须来自当前 Ubuntu/AppArmor 包提供的
`/usr/share/apparmor/extra-profiles/bwrap-userns-restrict`，禁止在构建时从网络下载 master
版本，避免 AppArmor ABI 与目标系统不匹配。

## 安装状态机

```text
检测 Linux/Bwrap/Sysctl/AppArmor
  -> AppArmor 开启：校验并安装/复用专用 Profile
  -> AppArmor 关闭：不伪造 Profile，仅继续真实 Probe
  -> 校验 Profile 语法（apparmor_parser -Q）
  -> 加载 Profile（apparmor_parser -r）
  -> 使用非特权用户运行四项真实隔离测试
  -> 原子保存状态与 Hash
```

`kernel.unprivileged_userns_clone=0` 或 `user.max_user_namespaces=0` 时必须失败，不得自动改
全局 Sysctl。任何隔离测试失败都会让 `postinst` 返回失败，防止“包已安装但 Coding Tool
实际裸跑”的假成功。

## Profile 所有权

目标为 `/etc/apparmor.d/bwrap-userns-restrict`：

- 文件不存在：安装官方 Profile，并记录 XHarness ownership hash。
- 文件内容与官方来源相同：直接复用，不夺取已有文件所有权。
- 文件由 XHarness 管理且当前 Hash 与记录一致：升级时允许替换成新包版本。
- 文件由管理员创建/修改：保留原内容，只校验、加载并运行真实 Probe；禁止覆盖。
- 卸载时只删除 Hash 仍与 ownership marker 一致的文件；管理员修改过的文件必须保留。

## 真实隔离测试

安装 Helper 必须以 `nobody` 或显式 `XHARNESS_VERIFY_USER` 执行 Bubblewrap，而不是以 root
得到假阳性：

1. Workspace Bind 内能够创建文件。
2. Workspace 外路径可见但写入被拒绝，且宿主没有出现目标文件。
3. 子进程 Network Namespace inode 与宿主不同，且没有默认 Route。
4. 子进程调用 `setsid` 后延迟写 Marker；Sandbox Root 退出后 Marker 永远不出现。

测试命令与 Runtime 使用相同关键参数：`--unshare-all`、`--unshare-pid`、只读根、独立
`/proc`/`/dev`、临时 `/tmp`、最后挂载可写 Workspace 和 `--die-with-parent`。

## 状态文件

成功或失败状态写入：

```text
/var/lib/xharness/setup/sandbox-state.json
```

至少记录 Bwrap 路径/版本、AppArmor 状态、三个 User Namespace Sysctl、Profile 来源与安装
SHA-256、加载状态、四项 Probe 结果和 UTC 检查时间。写入使用临时文件加原子 Rename。
状态同时标记 `profileManagedByXHarness`。Profile ownership hash 单独保存为
`bwrap-profile.owned`，权限为 `0600`。

## 命令

安装后的固定入口：

```bash
xharness-sandbox-setup detect
sudo xharness-sandbox-setup install
xharness-sandbox-setup verify
xharness-sandbox-setup status
sudo xharness-sandbox-setup remove
```

`install/remove` 要求 root；其他命令无权修改系统。普通用户执行 `verify` 时会真实运行
四项探针，但不会覆盖 root 所有的状态文件；安装阶段由 root 执行的结果仍是持久化真源。
普通用户无权读取内核 Profile 集合时，`detect/status` 将 `profile_loaded` 显示为
`unknown`，而不是误报 `false`，并同时展示上次安装阶段保存的加载结果。Helper 只接受
固定子命令，不执行任意调用方提供的 Shell。

## 构建

Mac 禁止编译 Rust。完整远程构建：

```bash
scripts/remote-build-deb.sh WZU_Server
```

脚本先同步源码，在 Linux 执行 Workspace fmt/check/test/clippy，再构建 release Host 和
`xharness_<version>_<arch>.deb`，最后只把 `dist/*.deb` 拉回本地。

## 当前限制

- 还没有 Polkit/GUI 的“一键授权” Helper；`.deb postinst` 使用标准 apt/dpkg 管理员授权。
- 当前运行中的 WZU_4080 是用户级 systemd 部署，不会因本地生成 `.deb` 自动迁移。
- 尚无 Debian Repository 签名、SBOM、Reproducible Build 或 Ubuntu 多版本安装矩阵。
- Profile 允许系统上所有 `/usr/bin/bwrap` 使用 User Namespace；范围小于全局放开，但不是
  XHarness 进程独占。后续可增加专用 Launcher/Profile Transition。

## 验收标准

Shell 测试必须覆盖四项真实隔离、首次安装、受管 Profile 升级、卸载、管理员文件不覆盖和
状态 Hash。发布测试必须在干净 Ubuntu 24.04 VM 中执行 `dpkg -i`，验证普通 `unshare`
仍被拒绝、Bwrap 成功，并完成安装/升级/卸载/回滚。WZU_4080 必须在获得管理员授权后作为
真实 AppArmor Restriction 回归环境。
