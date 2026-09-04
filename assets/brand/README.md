# XHarness 品牌资产

这组资产把参考图中的深色金属折叠 `X` 重构为可维护的矢量图形，不直接裁切或嵌入参考位图。

## 文件

- `xharness-mark.svg`：透明背景的高精度金属标志，用于大尺寸品牌展示。
- `xharness-mark-flat.svg`：无滤镜、无细线的小尺寸标志，用于 16–32 px 场景。
- `xharness-app-icon.svg`：桌面应用图标母版，包含深色圆角底板。
- `xharness-app-icon.png`：1024×1024 桌面图标导出。
- `xharness-brand-hero.svg/png`：1536×1024 品牌展示图。

## 设计约束

- 标志的四个外端保持高亮，中心收暗，缩小后仍能形成完整 `X` 轮廓。
- 中心不使用“裂缝”或额外贴片，四个折面在同一交点闭合。
- 桌面图标保留安全边距和圆角底板；网页小图标使用更简单的几何与更强对比度。
- 主色为石墨黑、枪灰和冷银，不再使用旧图标的大面积蓝色箭头与下划线。

## 重新导出桌面图标

在 macOS 上执行：

```bash
./scripts/generate-brand-assets-macos.sh
```

脚本会更新 Tauri 所需的 PNG、ICNS 和 ICO。该过程只处理图像，不会触发 Rust 编译。
