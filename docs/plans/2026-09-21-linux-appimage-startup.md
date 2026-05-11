# Linux AppImage 兼容与启动链路

## 问题

Ubuntu 22.04 构建的 Tauri 2.11 AppImage 会把一部分 Wayland、GLib、GIO、
GStreamer 基础设施库放进 `usr/lib`，并通过 `LD_LIBRARY_PATH` 优先加载。
RWKV Ubuntu 26.04（Mesa 25、GLib 2.88）因此同时使用旧的基础库和新的系统
图形／GIO 模块，出现以下真实故障：

- `Could not create default EGL display: EGL_BAD_PARAMETER`
- `libgvfscommon.so`、`libdconfsettings.so` 等系统模块符号不匹配
- `WebKitWebProcess` 退出，Host 仍存活但窗口白屏

这不是前端代码或 AMD 集显本身的问题，而是 AppImage 内外 ABI 栈混用。

## 修复

发布 CI 在 Tauri 生成 AppImage 后执行 `scripts/patch-linux-appimage.py`：

1. 保留 AppImage runtime 和 XHarness/WebKitGTK 应用库；
2. 删除封装的 Wayland、XKB/XCB、GLib/GIO、GStreamer 及其基础设施依赖；
3. 在 AppRun GTK hook 中撤销错误的 GIO/GStreamer 路径覆盖；
4. 重建 squashfs；
5. 删除已经失效的旧 updater 签名；
6. CI 使用既有 Tauri updater 私钥对**最终字节**重新签名；
7. `collect` 继续执行原有签名、哈希、架构和发布收据校验。

脚本采用封闭的库模式清单，重复执行幂等；不会把删除规则扩张成“为了减包体积
而任意删库”。单元测试确保 WebKitGTK 自身仍被保留。

## 四段启动协议

桌面状态新增单调时钟快照 `startup`，仅包含：

- `windowMappedMs`：GTK 原生 `map` 状态（若注册时已经映射则立即记录）；
- `hostReadyMs`：真实 `/health/ready` 成功；
- `frontendHydratedMs`：Host UI 已挂载到 `#root`；
- `firstFrameMs`：Hydrated 后双 `requestAnimationFrame` 完成。

浏览器只能通过封闭、幂等的 `desktop_report_startup_phase` 上报后两段，不接受
任意日志、URL、路径或用户数据。四段同时写入有界诊断事件，刷新或重试不会重复。

## 第二个 WebKitWebProcess

根因是启动页与 Host 页面跨 origin 导航后，WebKit 的 `WebBrowser` cache model
保留旧 renderer 作为备用进程。Linux 桌面改为 `DocumentBrowser`：保留正常文档／
资源缓存，但关闭 WebProcess cache。它不禁用 HTTP 缓存，也不改变 Host 或前端协议。

## RWKV 实机验收（2026-09-21）

在 Ubuntu 26.04 GNOME Wayland 的 RWKV 实机，用修正后的 AppDir 和当前远程编译
二进制执行：

- 页面正常渲染；未出现 EGL abort 或 GIO 符号错误；
- bootstrap → Host 导航后持续 30 秒均只有 **1 个** `WebKitWebProcess`；
- 四段相对 `DesktopStart`：映射 `0 ms`、Host Ready `103 ms`、Hydrated `326 ms`、
  首帧 `1223 ms`；
- 稳态进程树合计 PSS 约 `397160 KiB`（桌面、NetworkProcess、单一
  WebProcess、Host）；该数字受页面内容和 Mesa shader cache 影响，仅作为本次回归基线。

随后用两个隔离用户目录执行了 **2 次冷启动 + 3 次暖启动**，以 100 ms
间隔采样整个桌面进程树，并在首帧后继续观察 3 秒：

- 5/5 次完整记录四段启动，Host Ready 均为 `103 ms`，Hydrated 为
  `299–320 ms`，首帧为 `1173–1226 ms`；
- 全部运行从启动到稳态最多、最终都只有 **1 个** `WebKitWebProcess`；
- 未出现 EGL、GIO/GLib 符号或 WebKit renderer 退出错误；
- 冷启动峰值 PSS 为约 `414–420 MiB`，暖启动峰值 PSS 为约
  `391–394 MiB`；最高峰值没有再出现第二个 renderer；
- 另做一次原生 `WM_DELETE_WINDOW` 正常关闭验收：桌面退出码为 0，Host、
  NetworkProcess 和 WebProcess 在 3 秒观察窗内均已退出，无后代残留。

上述 PSS 是进程树比例分摊后的物理内存，不能与会重复计算共享页的 RSS 直接相加。
首次冷启动仍受 Mesa shader cache 与 WebKit 初始化影响，因此只把“第二个 renderer
不再出现”和“内存不随启动次数累计”作为硬门禁，不把单次 MiB 数值写成跨机器阈值。

另外对 0.2.23 的 99,834,360 字节 AppImage 做了完整提取、修补、重建验证；修补后
97,012,216 字节，runtime offset 保持 `944632`，36 个 ABI 敏感条目均被移除。

## 回归门禁

- `scripts/test-linux-appimage-compat.py`：删除范围、WebKit 保留、AppRun 修正、幂等；
- `scripts/test-desktop-startup.mjs`：浏览器无副作用、Hydrated/首帧顺序、去重；
- Rust 桌面测试：启动 phase 协议封闭，未知阶段拒绝；
- 发布工作流：修补后重新签名，缺少 `.sig` 立即失败；
- RWKV 实机：EGL/GIO 错误不得出现，Host 页面后 WebProcess 数必须为 1。
