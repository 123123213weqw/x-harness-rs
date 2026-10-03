import type {ToolCallBlock} from '../tool/types'
import {toolRowModel} from '../tool/tool/models/tool-call-model'
import {JobRunPanel,JobToolPanel} from './RunPanel'
import type {JobClient} from './client'
export function JobToolCard({client,sessionId,block,toolName,inspect}:{client:JobClient;sessionId:string;block:ToolCallBlock;toolName:string;inspect?:(()=>void)|undefined}) {
  const model=toolRowModel(toolName,block)
  return <section className="xhauto-card"><header><span>{toolName}</span>{inspect&&<button onClick={inspect}>Inspect</button>}</header>
    {model.state==='running'&&<p role="status">{document.documentElement.lang.startsWith('zh')?'工具执行中…':'Tool in progress…'}</p>}
    {model.state==='error'&&<p className="xhauto-card-error" role="alert">{model.errorSummary??'Tool failed'}</p>}
    {toolName==='job_list'?<JobRunPanel client={client} sessionId={sessionId}/>:<JobToolPanel client={client} sessionId={sessionId} block={block}/>}</section>
}
