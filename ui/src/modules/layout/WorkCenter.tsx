import {useState} from 'react'
import type {KeyboardEvent, ReactNode} from 'react'
import styles from './WorkCenter.css'
import {installStyles} from '../views-types'
installStyles('@xharness/dsh-client-ui-layout/WorkCenter.css', '@xharness/dsh-client-ui-layout', styles)

/** Presentation only: occupants retain their existing data/runtime ownership. */
export function WorkCenter({close, renderTasks, renderAutomations, renderExecutions}: {
  close(): void; renderTasks(): ReactNode; renderAutomations(): ReactNode; renderExecutions?:()=>ReactNode
}) {
  const tabs=renderExecutions ? ['tasks','automations','executions'] as const : ['tasks','automations'] as const
  const [tab, setTab] = useState<'tasks' | 'automations' | 'executions'>('tasks')
  const zh = document.documentElement.lang.startsWith('zh')
  const switchTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index=tabs.findIndex(t=>t===tab)
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? (tabs[tabs.length-1]??'tasks') : (tabs[(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length]??'tasks')
    setTab(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }
  return <main className="xhwork-page" aria-label={zh ? '任务与自动化' : 'Tasks and automations'}>
    <div className="xhwork-page-inner">
      <button className="xhwork-back" type="button" onClick={close} aria-label={zh ? '返回对话' : 'Back to chat'}>← {zh ? '返回对话' : 'Back to chat'}</button>
      <h1>{zh ? '任务与自动化' : 'Tasks & automations'}</h1>
      <div className="xhwork-tabs" role="tablist" aria-label={zh ? '任务视图' : 'Work views'}>
        <button type="button" role="tab" data-tab="tasks" id="xhwork-tab-tasks" aria-controls="xhwork-content" aria-selected={tab === 'tasks'} tabIndex={tab === 'tasks' ? 0 : -1} onKeyDown={switchTab} onClick={() => setTab('tasks')}>{zh ? '任务' : 'Tasks'}</button>
        <button type="button" role="tab" data-tab="automations" id="xhwork-tab-automations" aria-controls="xhwork-content" aria-selected={tab === 'automations'} tabIndex={tab === 'automations' ? 0 : -1} onKeyDown={switchTab} onClick={() => setTab('automations')}>{zh ? '自动化' : 'Automations'}</button>
        {renderExecutions&&<button type="button" role="tab" data-tab="executions" id="xhwork-tab-executions" aria-controls="xhwork-content" aria-selected={tab==='executions'} tabIndex={tab==='executions'?0:-1} onKeyDown={switchTab} onClick={()=>setTab('executions')}>{zh?'执行':'Executions'}</button>}
      </div>
      <section id="xhwork-content" role="tabpanel" aria-labelledby={`xhwork-tab-${tab}`}>
        {tab === 'tasks' ? renderTasks() : tab==='automations' ? renderAutomations() : renderExecutions?.()}
      </section>
    </div>
  </main>
}
