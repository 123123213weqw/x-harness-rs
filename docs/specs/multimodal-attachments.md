# 多模态消息与持久附件

状态：2026-09-09，源码实现；尚未发布到桌面安装包。

## 为什么改

旧链路把上传图片转换为 `[attached image: ID]` 文本，图片数据只在 Host 内存中。
网页显示图片不代表 Provider 收到了图片；模型只能猜测和尝试文件工具，重启后附件也无法恢复。
本次不增加读图工具，不要求模型调用 Bash、OCR 或搜索附件路径。

## 边界

```text
Web / Desktop 上传（沿用 SessionPrompt）
  → Host 校验并存储图片
  → Message.content_blocks = 有序 Text / Image(AttachmentRef)
  → Session JSONL / ContextPolicy（保存和传递引用）
  → Provider 解析附件 → Chat 或 Responses 的原生图片输入
```

- `xharness-session`：定义 `AttachmentRef` 和 `ContentBlock`。保留 `content: String` 兼容旧日志；有 blocks 时以 blocks 为准，content 只是文本投影。
- `xharness-attachments`：`AttachmentStore.put/resolve`，提供 Memory / File 实现。正式 Host 使用 `<state_dir>/attachments`，嵌入 Host 默认 Memory，宿主可注入自己的 Store。
- `xharness-host`：接收上传、产生规范消息、提供原有 SessionAttachment 预览接口；不决定某家模型的 wire 格式。
- `xharness-provider-openai`：Chat 输出 `text + image_url`；Responses 输出 `input_text + input_image`。生成和原生 token count 共用同一附件编码路径。
- `xharness-token` / Core budget：估算包含图像开销，而非只数引用 JSON。无原生计数时按尺寸估算，有真实计数则采用 Provider 结果。

图片不作为 base64 混入历史文本。请求发送时才物化；请求 Debug Trace 对图片 data URL 脱敏。
图片-only 输入、多张图片与文本交错、后续轮次重复查看均保留语义。

## 持久化与权限

File Store 按会话哈希和内容 SHA-256 存放原始图片与元数据，临时目录写完后原子改名；
Unix 目录 0700、文件 0600。解析时验证归属、内容哈希与大小，拒绝损坏、路径穿越和检测到的符号链接。
相同会话同一图片去重；跨会话不靠猜 ID 获取图片。
分叉会话只能通过自身已有历史中保存的祖先引用获取继承图片，不接受客户端指定任意 owner。

Store 是可信宿主边界，不是一个独立的多租户身份认证系统；继续依赖 Host 的原有访问控制。
图片验证与文件操作在 blocking pool 执行，Provider 附件解析支持协作取消。

旧日志仍可读取，但旧版仅存元数据、没有图片字节的附件不能凭空恢复；继续发送此类排队输入时明确提示重新上传。

## 能力与限制

配置 `imageInput`（部署模型文件为 `image_input`）：
- `true`：声明支持图片。
- `false`：请求发送前明确拒绝，提示切换视觉模型，不静默丢图片。
- 未知/省略：保留图片交给接口判断，不按模型名字臆测能力。

当前支持 PNG/JPEG/WebP/GIF，校验真实格式、尺寸和可解码性。
当前资源保护上限：单图 20 MiB、16 MiPixels、解码分配 128 MiB；单请求最多 16 张、图片原始字节合计 40 MiB。
这些是实现的安全限制，不是模型上下文容量；超过会明确报错，不偷偷裁剪。
图片 token fallback 为 `max(4096, ceil(width/16) × ceil(height/16) × 4)`。
这是启发式估算，不保证覆盖所有模型，也不应把它宣传为真实 tokenizer。

## 验收

- Store：重启恢复、去重、归属、哈希损坏、非法 MIME/base64、超限、符号链接。
- Session/Context：JSONL 重启保留引用，Identity 与工具结果投影不破坏图片 blocks。
- Host：图片-only 上传进入模型输入，真实尺寸，原会话/分叉预览与跨会话拒绝。
- Provider：两协议有序多图、原生计数一致性、opaque items 的位置、未知/不支持能力、取消、日志脱敏。
- HTTP：输出前断线重试仍发送相同图片正文，不降级为占位文本。
- 真实 DeepSeek：远端运行 `vision_smoke`，使用合成红蓝测试图，不上传用户截图；File Store 重建后连续两轮均回答 `left=red, right=blue`，实测完成耗时 529 ms / 632 ms（单次验证，不是基准性能承诺）。

远程 WZU_Server 完整 workspace 回归：473 passed、4 ignored；Clippy `-D warnings` 通过。
Mac/Windows 打包与安装后的 UI 验收仍需 CI 和发布阶段执行。

## 后续范围

附件 GC 必须考虑分叉、compact 后历史引用和未完成 admission，不能简单按父会话删除目录。
工具产生图片、PDF/音频、Provider 专有图片 token 校准与能力发现、自动缩图/裁剪另行设计。
本次未修 Bash 进程 exit code 与外层工具 outcome 之间的语义差异，也未修改模型的探索权限。
