# XHarness 品牌资产

应用图标以用户选定的第一张设计图为唯一母版。`xharness-app-icon.png` 保留原始 1254×1254 像素，不重绘或修改母版；各平台尺寸仅由它缩放导出。

## 文件

- `xharness-mark.svg`：透明背景的高精度金属标志，用于大尺寸品牌展示。
- `xharness-mark-flat.svg`：无滤镜、无细线的小尺寸标志，用于 16–32 px 场景。
- `xharness-app-icon.png`：1254×1254 应用图标母版，四臂白色 `X` 与黑色圆角底板。
- `xharness-app-icon.svg`：旧版金属图标留档；不再作为应用图标母版。
- `xharness-brand-hero.svg/png`：1536×1024 品牌展示图。

## 设计约束

- 应用图标保留母版四臂、中心留白、阴影和圆角，不用另一版连续 `X` 替换。
- 桌面 PNG、ICNS、ICO、网页 favicon 和 Web Manifest 图标均从同一母版生成。
- 小尺寸是母版的采样结果；不能单独重画，否则桌面和网页会不一致。

## 重新导出桌面图标

在 macOS 上执行：

```bash
./scripts/generate-brand-assets-macos.sh
```

脚本会更新 Tauri 所需的 PNG、ICNS、ICO 和网页 PNG 图标，并修改当前 `ui/dist` 的图标引用。之后重新构建网页时，`rebuild-ui.sh` 会再次应用同一引用。该过程只处理图像，不会触发 Rust 编译。
