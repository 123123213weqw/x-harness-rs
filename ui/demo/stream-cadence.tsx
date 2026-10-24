/** Isolated A/B preview: both columns receive the same synthetic source batches. */
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownText } from '../src/modules/platform/primitives/markdown/MarkdownText'
import { MarkdownText as BaselineMarkdownText } from './baseline-stream-markdown'
import '../overrides/motion-tokens.css'
import './stream-cadence.css'

const prose = `先解决等待，再让文字自然出现。\n\n以前，文字已经抵达，但显示仍在等下一批数据。一旦批量发布，整段内容就会同时跳出来。现在分成两个环节：\n\n- **后台按时发布**：暂时没有新片段，也不会一直扣着已收到的文字。\n- **前端短暂缓冲**：把同一批内容分成几个小帧，让阅读更连贯。\n- **随时追上进度**：积压越多，显示越快，不做漫长的打字机动画。\n\n这不是让模型想得更快，而是减少“憋住、突然涌出”的感觉。完整原文、工具操作和结束状态都保持不变。\n\n最后一小段会快速收尾；你按下停止时，则立即显示已经收到的全部内容。`
const structured = `## 不只测试普通文字\n\n中文、English、emoji 👩‍💻 和组合字符 é 都不能拆坏。\n\n\`\`\`ts\nconst pending = source.length - visible.length\nconst speed = pending / remainingTime\n// More backlog → faster catch-up.\n\`\`\`\n\n| 场景 | 行为 |\n| --- | --- |\n| 正常输出 | 小帧追赶 |\n| 停止 / 后台 | 立即完整显示 |\n| 已有历史 | 不重播 |\n\n公式 $E=mc^2$ 依然由原来的 Markdown 渲染器处理。\n\n**完成后，两侧内容完全一致。**`
const cases = [
  { id: 'paced', title: '分批到达', text: prose, chunk: 48, interval: 260 },
  { id: 'burst', title: '突发大段', text: prose + '\n\n' + prose, chunk: 180, interval: 520 },
  { id: 'structured', title: '代码与公式', text: structured, chunk: 38, interval: 220 },
]
function Demo() {
  const [selected, setSelected] = useState('paced')
  const [iteration, setIteration] = useState(0)
  const [text, setText] = useState('')
  const [streaming, setStreaming] = useState(true)
  const [interrupted, setInterrupted] = useState(false)
  const [received, setReceived] = useState(0)
  const interruptedRef = useRef(interrupted)
  interruptedRef.current = interrupted
  const sample = cases.find(item => item.id === selected) ?? cases[0]
  useEffect(() => {
    if (sample === undefined) return
    let offset = 0
    setText(''); setReceived(0); setStreaming(true); setInterrupted(false)
    const timer = setInterval(() => {
      if (interruptedRef.current) { clearInterval(timer); return }
      offset = Math.min(sample.text.length, offset + sample.chunk)
      if (offset < sample.text.length && /[\uD800-\uDBFF]/.test(sample.text[offset - 1] ?? '')) offset++
      setText(sample.text.slice(0, offset)); setReceived(value => value + 1)
      if (offset === sample.text.length) { clearInterval(timer); setStreaming(false) }
    }, sample.interval)
    return () => clearInterval(timer)
  }, [sample, iteration])
  useEffect(() => {
    if (!interrupted) return
    setStreaming(false)
  }, [interrupted])
  // Stopping the fixture freezes the source too, rather than only its animation.
  const shown = text
  return <main data-source={text} data-running={streaming && !interrupted}>
    <header><div className="brand"><span className="mark">X</span> XHarness <span className="divider"/> Stream preview</div><span className="pill">隔离演示 · 不调用模型</span></header>
    <section className="heading"><div className="eyebrow">STREAMING, WITHOUT THE BURST.</div><h1>不憋住，也不一股脑涌出来。</h1><p>同一段原文，同一批到达时间。左侧是原来的实现，右侧运行修改后的真实组件。</p></section>
    <nav aria-label="演示场景">{cases.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{item.title}</button>)}<span className="spacer"/><button className="replay" onClick={() => setIteration(value => value + 1)}>↻ 重播</button><button className="stop" disabled={!streaming || interrupted} onClick={() => setInterrupted(true)}>停止回放</button></nav>
    <div className="comparison" key={`${selected}:${iteration}`}>
      <article data-side="before"><div className="card-head"><div><span className="tag old">BEFORE</span><h2>原来的显示</h2></div><span className="caption">50ms 合批 · 整块出现</span></div><div className="body"><BaselineMarkdownText text={shown} streaming={streaming} smoothStreaming /></div></article>
      <article data-side="after"><div className="card-head"><div><span className="tag new">AFTER</span><h2>自适应追赶</h2></div><span className="caption">32ms 小帧 · 有积压就加速</span></div><div className="body"><MarkdownText text={shown} streaming={streaming} smoothStreaming interrupted={interrupted}/></div></article>
    </div>
    <footer><span className={streaming && !interrupted ? 'status live' : 'status'}/><span data-status>{interrupted ? '已停止动画' : streaming ? '正在回放相同输入' : '回放完成 · 原文一致'}</span><span className="spacer"/><span data-count>{received} 批 · {text.length} 字符</span></footer>
    <div className="details"><span><b>192ms</b> 正常追赶窗口</span><span><b>96ms</b> 完成时快速收尾</span><span><b>立即</b> 停止 / 后台 / 减少动态效果</span></div>
    <p className="note">展示节奏优化，不代表模型生成速度提升。这里回放前端批次；后台静默发布另有真实 Host 回归。</p>
  </main>
}
const root = document.getElementById('root')
if (root !== null) createRoot(root).render(<Demo />)
