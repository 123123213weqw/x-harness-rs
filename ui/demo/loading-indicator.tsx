import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LoadingIndicator } from '../src/modules/conversation/chat/LoadingIndicator'
import './loading-indicator.css'

type Stage = 'waiting' | 'tool' | 'approval' | 'done'
const labels: Record<Stage, string> = { waiting: '等待回复', tool: '准备工具', approval: '等待确认', done: '完成' }

function App() {
  const [stage, setStage] = useState<Stage>('waiting')
  const [iteration, setIteration] = useState(0)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  function theme() {
    const next = !dark
    document.body.toggleAttribute('data-ds-dark-theme', next)
    document.documentElement.style.colorScheme = next ? 'dark' : 'light'
    setDark(next)
  }
  return (
    <main className="loading-preview">
      <header className="preview-controls">
        <span>XHarness · 等待动效</span>
        <div>
          <button type="button" onClick={() => setIteration(value => value + 1)}>重播淡入</button>
          <button type="button" aria-label="切换预览配色" onClick={theme}>{dark ? '浅色' : '深色'}</button>
        </div>
      </header>
      <nav className="stage-picker" aria-label="预览状态">
        {(Object.keys(labels) as Stage[]).map(value => <button key={value} type="button"
          aria-pressed={stage === value} onClick={() => setStage(value)}>{labels[value]}</button>)}
      </nav>
      <section className="chat-preview" aria-label="聊天动效预览">
        <header className="chat-header"><span className="wordmark">XHarness</span><span>Coding Agent</span></header>
        <div className="chat-body">
          <div className="user-bubble">帮我检查一下项目的启动问题。</div>
          <div className="assistant-row">
            <p>我先查看项目结构和启动配置。</p>
            <div className="activity-seat" key={iteration}>
              {stage === 'waiting' && <LoadingIndicator active label="正在等待模型回复" />}
              {stage === 'tool' && <details className="tool-preview">
                <summary><span className="tool-title">Bash</span><span>读取启动配置</span><LoadingIndicator active label="正在准备工具参数" /></summary>
                <pre><code>{'{"command":"cat package.json"}'}</code></pre>
              </details>}
              {stage === 'approval' && <section className="approval-preview" aria-label="等待确认">
                <div>需要你确认</div><p>允许执行只读检查命令？</p>
                <div className="approval-actions"><button type="button" onClick={() => setStage('tool')}>允许一次</button><button type="button" onClick={() => setStage('done')}>取消</button></div>
              </section>}
              {stage === 'done' && <div className="done-preview">检查已完成。</div>}
            </div>
          </div>
        </div>
        <div className="composer-preview">
          <div className="composer-placeholder">Message the agent</div>
          <div className="composer-toolbar"><span>＋</span><span>Workspace write</span><span className="composer-model">DeepSeek Flash</span><button type="button" disabled aria-label="演示中不发送消息">↑</button></div>
        </div>
      </section>
      <footer className="preview-note">演示数据 · 不连接模型，不执行命令，不保存会话</footer>
    </main>
  )
}

document.body.toggleAttribute('data-ds-dark-theme', matchMedia('(prefers-color-scheme: dark)').matches)
createRoot(document.getElementById('root')!).render(<App />)
