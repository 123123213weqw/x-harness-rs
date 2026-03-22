# 历史消息内容窗口化验收（2026-09-13）

## 测试环境和口径

WZU_Server（Linux）执行 Chromium 浏览器回归，使用仓库打包的 React 和 ChatView。
350 条合成历史消息，每条 40 行代码文本，两个路径保留完全相同的消息数据。
通过 CDP 显式 GC 后采集 JS 堆和 DOM 节点数，连续 3 次。不是模型上下文裁剪实验，
也不是 macOS 桌面物理内存或初次打开峰值的度量。

| 指标 | 全挂载 | 内容窗口化 |
|---|---:|---:|
| DOM 节点数（三次一致） | 29,766 | 450 |
| GC 后 JS 堆中位数 | 12.76 MiB | 7.66 MiB |

堆减少约 5.10 MiB（40.0%）；DOM 节点减少约 98.5%。
不能将上述百分比外推到真实软件约 600 MB 的 WebKit footprint。

## 已通过

- 严格补丁锚点、幂等、实现更新迁移、脚本语法、构建 hash/index 一致性。
- 等高占位（包括原来的 :empty 隐藏规则）、远处卸载、滚动总高度不变。
- 点击展开后滚出屏幕仍保留状态；活动节点保留、结束后可卸载。
- 改变宽度重新测量，容器/会话清理。
- 真实打包 ChatView 的底部打开、读历史时追加不抢位置、加载更早历史锚点稳定。
- 服务器 Chromium 的已有消息编辑、问答交互回归及投影/补丁静态测试。
- 本机 Playwright WebKit 的同一组窗口化与真实 ChatView 回归通过。DOM 元素数 15,409 → 402；该指标只计元素，不能直接和 CDP 的所有节点数混用。

## 尚未完成

- Linux WebKit 下载遇到 ECONNRESET，重试后持续缓慢；停止了本次下载进程，没有假报服务器 WebKit 通过。CI 已增加 Chromium/WebKit 两个引擎的窗口化回归。
- macOS 安装包的真实对话绝对内存与滚动帧时延对照；本次未部署、更换或重启用户软件。
- 首次加载峰值仍存在（先实测高度），所有已交互行与运行后缀保守保留，不宣称完全 O(可见行数) 内存。
- CI 全通过才允许合并；本次未合并。

## 三次原始指标

```json
[
  {
    "engine": "chromium",
    "baseline": {
      "dom": 29766,
      "heapBytes": 13381308
    },
    "optimized": {
      "dom": 450,
      "heapBytes": 8034160
    },
    "checks": "extent, offscreen eviction, interaction state, active row, resize, cleanup, shipped ChatView bottom/append/prepend anchors",
    "note": "synthetic 350-row fixture; JS heap/DOM only, not macOS physical footprint"
  },
  {
    "engine": "chromium",
    "baseline": {
      "dom": 29766,
      "heapBytes": 13383340
    },
    "optimized": {
      "dom": 450,
      "heapBytes": 8030948
    },
    "checks": "extent, offscreen eviction, interaction state, active row, resize, cleanup, shipped ChatView bottom/append/prepend anchors",
    "note": "synthetic 350-row fixture; JS heap/DOM only, not macOS physical footprint"
  },
  {
    "engine": "chromium",
    "baseline": {
      "dom": 29766,
      "heapBytes": 13380500
    },
    "optimized": {
      "dom": 450,
      "heapBytes": 8028164
    },
    "checks": "extent, offscreen eviction, interaction state, active row, resize, cleanup, shipped ChatView bottom/append/prepend anchors",
    "note": "synthetic 350-row fixture; JS heap/DOM only, not macOS physical footprint"
  }
]
```
