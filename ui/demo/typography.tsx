/** Zero-API typography fixture: production Markdown/Reasoning, no user data. */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownText } from '../src/modules/platform/primitives/markdown/MarkdownText'
import { ReasoningRow } from '../src/modules/conversation/chat/ReasoningRow'
import '../src/modules/theme/base.css'
import '../src/modules/theme/design-platform.css'
import '../src/modules/theme/gradient-shadow-text.css'
import '../src/modules/theme/typography.css'
import '../src/modules/theme/shiki.css'
import '../overrides/monochrome.css'
import './typography.css'

const explanation = `这是整个方案里最容易误解的一步。**旋转改变的是观察方向，不是数据本身。**

## 1. 旋转不是改变信息，而是换一个角度

把一组权重想成空间里的点。旋转就是给所有点乘一个正交矩阵：内容一点没变，只是观察角度变了。它保留三个关键性质：**信息不丢失、距离不改变、变换可逆**。

### 为什么它能帮助量化？

离群值会拉大数值范围。INT8 用 **256 个离散格子**表示连续数值；范围越大，每一个格子就越粗，小数值的细节就越容易丢失。

\`\`\`text
旋转前：
  通道 A：100.0  ← 离群值
  通道 B：  0.5

量化步长 = 100 / 127 ≈ 0.79
小数值被压进同一个格子，细节丢失。
\`\`\`

## 2. 让数值分布更均匀

把坐标系旋转 45°，可以把极端值分摊到多个维度：$x' = (x + y)/\\sqrt{2}$。**目标是改善量化分辨率，而不是提高浮点模型的精度。**

- 保留原始的数学关系。
- 让不同维度分担幅值。
- 在量化后，用同一套测试验证质量。

> 验证不能只看平均误差，还要看真实任务中的结果是否稳定。

| 检查项 | 方法 | 结论 |
| --- | --- | --- |
| 信息保留 | 正交变换前后对照 | 浮点计算一致 |
| 量化误差 | 测量绝对误差 | 需要实测 |
| 任务质量 | 同一任务 A/B | 不预设结论 |

#### 实施建议

先跑小规模对照，再扩大测试范围。阅读 [Rust 官方文档](https://www.rust-lang.org/) 或使用 \`cargo test\` 验证实现。
`
const boundary = `# 排版边界检查

## 中文、English 与局部 **强调**

正文保持常规字重，**关键结论单独突出**。API endpoint、UTF-8、数字 123456 和中文应自然混排，不额外插入字符。

### 很长的标题也需要自然换行，不挤出内容区域：这是一个跨平台阅读与布局测试

#### 四级标题

##### 五级标题

###### 六级标题

- 列表项包含 **局部加粗**、\`inline_code\` 与公式 $E=mc^2$。
  - 嵌套列表保留缩进。
- [x] 已检查字重
- [ ] 还需用户确认视觉偏好

\`\`\`rust
fn main() {
    let message = "中文与 English 都清晰";
    println!("{message}");
}
\`\`\`

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

| 模式 | 稳定显示 | 说明 |
| --- | --- | --- |
| 流式 | **是** | 新增尾部更新 |
| 完成 | 是 | 内容保持完整 |
`
function Demo() {
  const [dark, setDark] = useState(true)
  const [sample, setSample] = useState(false)
  const [length, setLength] = useState<number | null>(null)
  const text = sample ? boundary : explanation
  useEffect(() => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, [dark])
  useEffect(() => {
    if (length === null) return
    if (length >= text.length) { setLength(null); return }
    const timer = setTimeout(() => setLength(value => value === null ? null : value + 24), 50)
    return () => clearTimeout(timer)
  }, [length, text])
  return <main className="typography-preview">
    <header className="preview-toolbar"><span>实际渲染组件 · {new URLSearchParams(location.search).get('label') ?? '改进后'}</span><div><button onClick={() => setDark(value => !value)}>{dark ? '浅色' : '深色'}</button><button aria-pressed={sample} onClick={() => { setSample(value => !value); setLength(null) }}>边界示例</button><button onClick={() => setLength(length === null ? 0 : null)}>{length === null ? '流式演示' : '立即完成'}</button></div></header>
    <section className="preview-chat"><ReasoningRow text="检查正交变换与量化误差，用对照实验验证结论。" running={false} t={key => key === 'row.label' ? '思考' : key} /><MarkdownText text={length === null ? text : text.slice(0, length)} streaming={length !== null} codeLabels={{copyLabel:'复制',copiedLabel:'已复制'}} /></section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Demo />)
