/** Isolated, zero-API demo using the actual production reasoning and Markdown components. */
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownText } from '../src/modules/platform/primitives/markdown/MarkdownText'
import { ReasoningRow } from '../src/modules/conversation/chat/ReasoningRow'
import '../overrides/motion-tokens.css'
import './stream-motion.css'

const examples = {
  reasoningFast: '思考收拢时，高速输出改成单行滚页。\n\n每页停留 800ms，切换时轻轻向上淡入淡出。**完整思考仍然实时保留，点击 Think 就能展开。**\n\n结束时不会继续播放积压的动画，正文开始正常输出。',
  reasoningSlow: '慢速输出没有触发翻页，保持普通的实时预览。\n\n展开后看到的内容始终完整，动画不会改变模型输出。',
  prose: '让文字自然出现，而不是一块一块跳出来。\n\n已显示的内容保持不动，只有新增的文字轻轻淡入。**没有逐字排队，也不会反复闪烁整段内容。**\n\n- 零碎输出短暂合并，阅读节奏更稳定。\n- 大块内容及时展示，不人为拖慢回复。\n- 结束或停止时，立即显示完整内容。\n\n中文与 English 都保留原来的排版，emoji 👩‍💻 也不会被拆坏。',
  structured: '自然淡入只作用于普通文字。代码、表格和公式仍然及时展示，不逐字动画。\n\n```rust\nfn main() {\n    println!("Hello, XHarness!");\n}\n```\n\n| 模式 | 显示方式 |\n| --- | --- |\n| 普通文字 | 新增尾部淡入 |\n| 代码与表格 | 直接显示 |\n\n公式 $E = mc^2$ 使用现有渲染器，完成后不会丢失。',
  burst: '先收到一些零碎文字，然后网络一次送来一大块内容。\n\n' + '这部分是同一批抵达的内容，不需要等打字机慢慢播放。'.repeat(96) + '\n\n积压已经追上；结束时显示的内容与原文完全一致。',
}
type Example = keyof typeof examples
const thoughtLines = [
  '先检查当前实现：收拢摘要逐片段更新，并不断滚到末尾；高速输出时，读者来不及看清文字。',
  '把显示节奏和模型速度分开。只调整预览，不修改消息、持久记录、上下文或工具调用。',
  '观察最近一秒的新增字符速度。超过阈值后采用单行滚页，低速时恢复普通显示。',
  '每次直接取最新片段，不积压中间页。网络突发大段，也不需要慢慢播放完才能继续。',
  '两行共享固定高度；旧行向上淡出，新行从下方进入，其他内容保持不动。',
  '用户展开时立即显示完整文本。隐藏页面停止定时器；开启减少动态效果后不做位移动画。',
  '结束和替换内容都立即刷新，不保留旧页。随后正文使用短合批和轻淡入，完整呈现结果。',
]
const fastThought = Array.from({ length: 40 }, () => thoughtLines.join('\n')).join('\n')
const slowThought = thoughtLines.slice(0, 3).join('\n')

function Demo() {
  const [natural, setNatural] = useState(true)
  const [example, setExample] = useState<Example>('reasoningFast')
  const [iteration, setIteration] = useState(0)
  const [text, setText] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [thinking, setThinking] = useState(true)
  const [streaming, setStreaming] = useState(true)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sample = examples[example]
  const withReasoning = example === 'reasoningFast' || example === 'reasoningSlow'
  const thought = example === 'reasoningFast' ? fastThought : slowThought
  useEffect(() => {
    let stopped = false, offset = 0, chunk = 0
    let phase: 'reasoning' | 'reply' = withReasoning ? 'reasoning' : 'reply'
    setText(''); setReasoning(''); setThinking(withReasoning); setStreaming(true); setPaused(false); follow.current = true
    const tick = (): void => {
      if (stopped) return
      if (pausedRef.current) { timer.current = setTimeout(tick, 100); return }
      if (phase === 'reasoning') {
        offset = Math.min(offset + (example === 'reasoningFast' ? 18 : 2), thought.length)
        setReasoning(thought.slice(0, offset))
        if (offset >= thought.length) { phase = 'reply'; offset = 0; setThinking(false) }
        timer.current = setTimeout(tick, example === 'reasoningFast' ? 40 : 65)
        return
      }
      const length = example === 'burst' && offset >= 35 && offset < 1200 ? 1400 : [1, 2, 3, 1, 4, 2, 6][chunk % 7] ?? 2
      offset = Math.min(offset + length, sample.length)
      // Do not synthesize broken surrogate pairs in the network fixture.
      if (offset < sample.length && /[\uD800-\uDBFF]/.test(sample[offset - 1] ?? '')) offset++
      setText(sample.slice(0, offset)); chunk++
      if (offset >= sample.length) { setStreaming(false); return }
      timer.current = setTimeout(tick, [15, 25, 80, 12, 65, 90, 40][chunk % 7] ?? 30)
    }
    timer.current = setTimeout(tick, 300)
    return () => { stopped = true; if (timer.current !== null) clearTimeout(timer.current); timer.current = null }
  }, [iteration, example, natural, sample, withReasoning, thought])
  // Production-style follow ownership: only follow when the reader is at the end.
  useEffect(() => {
    const element = scroll.current
    if (element === null) return
    const observer = new ResizeObserver(() => { if (follow.current) element.scrollTop = element.scrollHeight })
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [])
  const finish = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null; setPaused(false); setReasoning(withReasoning ? thought : ''); setThinking(false); setText(sample); setStreaming(false)
  }
  return <main>
    <header><a href="http://127.0.0.1:3266/">← 返回聊天</a><span>本地模拟 · 不调用 API</span></header>
    <h1>让思考慢一拍，让文字自然出现</h1>
    <p className="intro">高速思考收拢成单行滚页，正文轻轻淡入。点击 Think 查看完整思考。</p>
    {!withReasoning && <nav aria-label="显示方式">
      <button aria-pressed={natural} onClick={() => setNatural(true)}>自然淡入</button>
      <button aria-pressed={!natural} onClick={() => setNatural(false)}>原始流式</button>
    </nav>}
    <div className="options"><label>示例 <select value={example} onChange={event => setExample(event.target.value as Example)}><option value="reasoningFast">高速思考 → 正文</option><option value="reasoningSlow">低速思考 → 正文</option><option value="prose">普通回答</option><option value="structured">代码、表格与公式</option><option value="burst">网络突发大段</option></select></label><button onClick={() => setIteration(value => value + 1)}>重播</button></div>
    <section className="chat" aria-label="流式回复演示">
      <div className="status" role="status"><span className={streaming && !paused ? 'dot active' : 'dot'} />{!streaming ? '输出完成' : paused ? '演示已暂停' : thinking ? '正在思考' : '正在输出'}<span className="mode">{thinking ? '自动阈值 120 字符/s · 800ms/页 · 180ms 切换' : natural ? '50ms 合批 · 150ms 淡入' : '收到即显示 · 无动画'}</span></div>
      <div ref={scroll} className="reply" onWheel={event => { if (event.deltaY < 0) follow.current = false }} onScroll={event => { const element = event.currentTarget; if (element.scrollHeight - element.scrollTop - element.clientHeight < 20) follow.current = true }}>
        <div>
          {withReasoning && <div className="reasoning"><ReasoningRow key={`thinking:${iteration}:${example}:${natural}`} text={reasoning} running={thinking} t={key => key === 'row.running' ? '正在思考' : key} /></div>}
          <MarkdownText key={`${iteration}:${example}:${natural}`} text={text} streaming={streaming && !thinking} smoothStreaming={natural} codeLabels={{ copyLabel: '复制', copiedLabel: '已复制' }} />
        </div>
      </div>
      <footer><button disabled={!streaming} onClick={() => setPaused(value => !value)}>{paused ? '继续演示' : '暂停演示'}</button><button disabled={!streaming} onClick={finish}>立即完成</button><small>{thinking ? reasoning.length : text.length} 字符</small></footer>
    </section>
    <p className="note">这是实际前端渲染组件，不是视频或假截图。系统开启「减少动态效果」时自动关闭动画。</p>
  </main>
}

createRoot(document.getElementById('root')!).render(<Demo />)
