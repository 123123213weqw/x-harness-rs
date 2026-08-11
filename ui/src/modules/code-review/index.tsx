import {observeShellPage} from '../shared/shell-route'
/// <reference path="../shared/assets.d.ts" />
import {useEffect,useState,useRef} from 'react'
import type {KeyboardEvent} from 'react'
import type {ClientContext} from '../views-types'
import type {ClientConnectionRpc} from '../client-connection/rpc-contracts'
import {IconBranchOutline16,IconSearchOutline16,IconCheckOutline16,IconCloseOutline16,Tooltip,MarkdownText} from '@xharness/dsh-client-ui-primitives'
import CSS from './CodeReview.css'
import {EvidencePanel} from './EvidencePanel'
import type {DiffLocation} from './EvidencePanel'
import {openAssistant} from '../assistant/contracts'
import {pullReference} from './assistant-reference'
import {ReviewPanel} from './ReviewPanel'
import {diffLines} from './structured'
import {diffRows} from './diff-rows'
import {GitHubClient,GitHubError} from './client'
import {ReviewCache} from './cache'
import {BrowserReviewStorage} from './storage'
import {ReviewPreferences} from './preferences'
import {RepositoryPicker,AuthorFilter} from './RepositoryPicker'
import {BrowserIdleEnvironment} from './idle'
import type {PullSummary,PullDetail,Identity,ReviewFile} from './client'
import {recordKey,filterPulls,parsePullLink,checkState,age,RequestLane,checkSourceUrl} from './data'
import type {PullLink,CheckState} from './data'
const zh=navigator.language.startsWith('zh')
function text(en:string,cn:string):string{return zh?cn:en}
function message(error:unknown):string{return error instanceof GitHubError?`${error.message} (${error.kind})`:error instanceof Error?error.message:text('GitHub request failed','GitHub 请求失败')}
function ReviewNavigation({wide}:{wide:boolean}){
 const [active,setActive]=useState(false)
 useEffect(()=>observeShellPage('review',setActive),[])
 return <Tooltip label="Code Review" side="right"><button type="button" className="xhreview-nav" data-xharness-review-nav aria-label="Code Review" aria-current={active?'page':undefined} onClick={()=>window.dispatchEvent(new Event('xharness:review:open'))}><IconBranchOutline16 size={22}/>{wide&&<span>Code Review</span>}</button></Tooltip>
}
function Avatar({author}:{author:string}){return <span className="xhreview-avatar" aria-hidden="true">{author.slice(0,1).toUpperCase()}</span>}
function StatusIcon({state}:{state:CheckState}){return <span className={`xhreview-state ${state}`} aria-label={state}>{state==='failed'?<IconCloseOutline16 size={14}/>:state==='passed'?<IconCheckOutline16 size={14}/>:'·'}</span>}
/** Keep closed notes/diffs out of the DOM, not merely hidden inside details. */
function ReadonlyNote({label,body}:{label:string;body:string}){const [open,setOpen]=useState(false);return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{label}</summary>{open&&<div className="xhreview-comment"><MarkdownText text={body}/></div>}</details>}
function FileDiff({file,initiallyOpen,focus,reference}:{file:ReviewFile;initiallyOpen:boolean;focus:DiffLocation|null;reference?:((location:DiffLocation)=>void)|undefined}){
 const [open,setOpen]=useState(initiallyOpen),node=useRef<HTMLDetailsElement|null>(null)
 useEffect(()=>{if(focus?.path===file.path)setOpen(true)},[focus,file.path])
 useEffect(()=>{if(!open||focus?.path!==file.path)return;const frame=requestAnimationFrame(()=>{const line=node.current?.querySelector(`[data-side="${focus.side}"][data-line="${focus.line}"]`);if(line instanceof HTMLElement){line.scrollIntoView({block:'center'});line.focus()}});return()=>cancelAnimationFrame(frame)},[open,focus,file.path])
 const lines=diffRows(file.patch)
 return <details ref={node} open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{file.path} <span className="xhreview-add">+{file.additions}</span> <span className="xhreview-remove">−{file.deletions}</span></summary>{open&&(file.patch!==null?<pre>{lines.length?lines.map((line,index)=><span key={index} className={`xhreview-diff-line ${line.kind==='added'?'xhreview-added':line.kind==='removed'?'xhreview-removed':''}`}><span className="xhreview-line-number" data-side="left" data-line={line.left??undefined} tabIndex={-1}>{line.left??' '}</span><span className="xhreview-line-number" data-side="right" data-line={line.right??undefined} tabIndex={-1}>{line.right??' '}</span>{line.text}{reference&&(line.left!==null||line.right!==null)&&<button type="button" className="xhreview-code-reference" aria-label={`${text('Reference line','引用行')} ${line.right??line.left}`} onClick={()=>{const n=line.right??line.left;if(n!==null)reference({path:file.path,side:line.right!==null?'right':'left',line:n})}}>↗</button>}{'\n'}</span>):file.patch}</pre>:<p className="xhreview-muted">{text('Diff unavailable (binary or large file). Open GitHub.','Diff 未提供（二进制或大文件），请在 GitHub 查看。')}</p>)}</details>
}
function Metadata({record,more,busy,client,account,jump,revision}:{record:PullDetail;more(kind:'comments'|'reviews'):void;busy:boolean;client:GitHubClient;account:string;revision:number;jump(location:DiffLocation):void}){return <aside className="xhreview-metadata" aria-label={text('Pull request status','PR 状态')}>
 <section><h3>{text('Merge status','合并状态')}</h3><p>{record.mergeable===null?text('GitHub is calculating mergeability','GitHub 正在计算合并状态'):record.mergeable?text('No merge conflicts','无合并冲突'):text('Merge conflicts','存在合并冲突')}</p><small className="xhreview-muted">{record.mergeableState}</small></section>
 <section><h3>{text('Comments','评论')} · {record.commentCount}</h3>{record.comments.length?record.comments.map(item=><ReadonlyNote key={item.id} label={item.author} body={item.body}/>):<p className="xhreview-muted">{text('No conversation comments','暂无对话评论')}</p>}{record.commentsHasMore&&<button disabled={busy} onClick={()=>more('comments')}>{text('Load more','加载更多')}</button>}</section>
 <section><h3>{text('Reviews','审核')}</h3>{record.reviews.length?record.reviews.map(item=><ReadonlyNote key={item.id} label={`${item.author} · ${item.state}`} body={item.body}/>):<p className="xhreview-muted">{text('No submitted reviews','暂无审核记录')}</p>}{record.reviewsHasMore&&<button disabled={busy} onClick={()=>more('reviews')}>{text('Load more','加载更多')}</button>}</section>
 <section><h3>{text('Checks','检查')}</h3><small className="xhreview-sha" title={record.headSha}>{record.headSha.slice(0,8)}</small>{record.checks.map(item=>{const url=checkSourceUrl(item.url);return <details className="xhreview-check" key={item.id}><summary><StatusIcon state={checkState(item)}/><span>{item.name}</span></summary><p>{item.conclusion??item.status}</p>{item.description&&<p>{item.description}</p>}{url&&<a href={url} target="_blank" rel="noopener noreferrer">{text('Open check','查看检查')} ↗</a>}</details>})}{!record.checks.length&&<p className="xhreview-muted">{text('No reported checks','暂无检查结果')}</p>}{record.checksTruncated&&<p role="status">{text('Check list incomplete. Open GitHub for all checks.','检查列表不完整，请在 GitHub 查看全部检查。')}</p>}</section>
 <EvidencePanel key={`${account}:${recordKey(record)}:${record.headSha}:${revision}`} client={client} account={account} record={record} zh={zh} jump={jump}/></aside>}
interface ReviewProps {close():void;client:GitHubClient;cache:ReviewCache;preferences:ReviewPreferences}
/** GitHub reads plus explicit handoff to the global assistant; no PR chat binding. */
export function CodeReview({close,client,cache,preferences}:ReviewProps){
 const [identity,setIdentity]=useState<Identity|null>(null),[repos,setRepos]=useState<string[]>([]),[repository,setRepository]=useState(''),[repoMore,setRepoMore]=useState(false),[repoPage,setRepoPage]=useState(1)
 const [query,setQuery]=useState(''),[mine,setMine]=useState(false),[pulls,setPulls]=useState<PullSummary[]>([]),[pullMore,setPullMore]=useState(false),[pullPage,setPullPage]=useState(1)
 const [selected,setSelected]=useState<PullLink|null>(null),[record,setRecord]=useState<PullDetail|null>(null),[tab,setTab]=useState<'summary'|'changes'|'review'>('summary')
 const [epoch,setEpoch]=useState(0),[authEpoch,setAuthEpoch]=useState(0),[loading,setLoading]=useState(''),[listBusy,setListBusy]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[listError,setListError]=useState(''),[repoError,setRepoError]=useState(''),[detailError,setDetailError]=useState(''),[stale,setStale]=useState(false)
 const [focus,setFocus]=useState<DiffLocation|null>(null)
 const [recent,setRecent]=useState<string[]>([])
 const [pages,setPages]=useState({files:1,comments:1,reviews:1})
 const listRefreshEpoch=useRef(0),detailRefreshEpoch=useRef(0)
 const [authLane]=useState(()=>new RequestLane()),[listLane]=useState(()=>new RequestLane()),[detailLane]=useState(()=>new RequestLane()),[moreLane]=useState(()=>new RequestLane())
 useEffect(()=>{const request=authLane.start();setLoading(text('Connecting to GitHub…','连接 GitHub…'));setError('');setRepoError('');setIdentity(null);setRepository('');setRepos([]);setRecent([]);setMine(false);setPulls([]);setSelected(null);setRecord(null);listLane.cancel();detailLane.cancel();moreLane.cancel();setBusy(false)
  async function connect(){try{
   const user=await client.auth(request.signal);if(!request.current())return
   await cache.activate(user.account);if(!request.current())return
   const choice=await preferences.activate(user.account);if(!request.current())return
   setMine(choice.mine);setRecent(choice.recent)
   const cached=cache.bootstrap(user.account)
   const show=(data:{items:string[];hasMore:boolean})=>{setIdentity(user);setRepos(choice.repository&&!data.items.includes(choice.repository)?[choice.repository,...data.items]:data.items);setRepoPage(1);setRepoMore(data.hasMore);setRepository(old=>old||choice.repository||data.items[0]||'')}
   if(cached){show(cached.repos);setLoading('')}
   if(!cached||!cache.bootstrapFresh(user.account)){try{const data=await client.repos(user.account,1,request.signal);if(request.current()){cache.putBootstrap(user,data);show(data);setRepoError('')}}catch(e:unknown){if(!cached)throw e;if(request.current())setRepoError(message(e))}}
  }catch(e:unknown){if(request.current()){setError(message(e));if(e instanceof GitHubError&&['authentication','permission','account_changed'].includes(e.kind))cache.clear()}}finally{if(request.current())setLoading('')}}
  void connect();return()=>authLane.cancel()
 },[client,cache,preferences,authEpoch,authLane,listLane,detailLane,moreLane])
 useEffect(()=>{
  if(!identity||!repository)return
  const account=identity.account,request=listLane.start();moreLane.cancel();setBusy(false);setListError('')
  const force=epoch!==listRefreshEpoch.current;listRefreshEpoch.current=epoch
  const cached=cache.list(account,repository)
  if(cached){setPulls(cached.items);setPullPage(1);setPullMore(cached.hasMore);cache.scheduleDetails(account,cached.items)}
  if(!force&&cache.listFresh(account,repository)){setListBusy(false);return()=>listLane.cancel()}
  setListBusy(true)
  async function read(){try{const page=await client.pulls(account,repository,1,request.signal);if(request.current()){cache.putList(account,repository,page);cache.scheduleDetails(account,page.items);setPulls(page.items);setPullPage(1);setPullMore(page.hasMore)}}catch(e:unknown){if(request.current()){setListError(message(e));if(e instanceof GitHubError&&['authentication','permission','account_changed'].includes(e.kind)){cache.clear();setPulls([]);setRecord(null)}}}finally{if(request.current())setListBusy(false)}}
  void read();return()=>listLane.cancel()
 },[client,cache,identity,repository,epoch,listLane,moreLane])
 const selectedHead=selected?pulls.find(item=>recordKey(item)===`${selected.repository.toLowerCase()}#${selected.id}`)?.headSha:undefined
 useEffect(()=>{
  if(!identity||!selected)return
  const account=identity.account,link=selected,request=detailLane.start();setDetailError('');moreLane.cancel();setBusy(false)
  const force=epoch!==detailRefreshEpoch.current;detailRefreshEpoch.current=epoch
  const cached=cache.detail(account,link,selectedHead)
  setRecord(old=>cached??(old&&old.repository.toLowerCase()===link.repository.toLowerCase()&&old.id===link.id&&(selectedHead===undefined||selectedHead===old.headSha)?old:null));setPages({files:1,comments:1,reviews:1})
  if(cached&&!force&&cache.detailFresh(account,link,selectedHead)){setLoading('');setStale(false);return()=>detailLane.cancel()}
  setLoading(text('Loading pull request…','加载 PR…'));setStale(true)
  async function read(){try{const data=await client.detail(account,link.repository,link.id,request.signal);if(request.current()){cache.putDetail(account,data);setPulls(items=>items.map(item=>item.id===data.id&&item.repository.toLowerCase()===data.repository.toLowerCase()?{...item,headSha:data.headSha}:item));setRecord(data);setStale(false);setPages({files:1,comments:1,reviews:1})}}catch(e:unknown){if(request.current()){setDetailError(message(e));if(e instanceof GitHubError&&['authentication','permission','account_changed','not_found'].includes(e.kind)){cache.clear();setRecord(null)}}}finally{if(request.current())setLoading('')}}
  void read();return()=>detailLane.cancel()
 },[client,cache,identity,selected,selectedHead,epoch,detailLane,moreLane])

 function choose(item:PullLink):void{if(identity)cache.viewed(identity.account,item);detailLane.cancel();moreLane.cancel();cache.cancelPrefetch();const listed=pulls.find(pull=>recordKey(pull)===`${item.repository.toLowerCase()}#${item.id}`);setRecord(identity?cache.detail(identity.account,item,listed?.headSha)??null:null);setStale(true);setDetailError('');setBusy(false);setSelected(item);setTab('summary')}
 function changeRepository(value:string):void{if(identity)setRecent(preferences.select(identity.account,value,mine).recent);if(value===repository)return;cache.cancelPrefetch();listLane.cancel();detailLane.cancel();moreLane.cancel();setPulls([]);setSelected(null);setRecord(null);setLoading('');setDetailError('');setBusy(false);setRepository(value)}
 function changeAuthor(value:boolean):void{setMine(value);if(identity)setRecent(preferences.select(identity.account,repository,value).recent)}
 function openLink():void{if(!identity)return;const link=parsePullLink(query);if(!link)return;changeRepository(link.repository);setRepos(items=>items.includes(link.repository)?items:[link.repository,...items]);choose(link)}
 async function more(kind:'repos'|'pulls'|'files'|'comments'|'reviews'):Promise<void>{if(!identity||busy)return;const request=moreLane.start();setBusy(true);setError('');try{
  if(kind==='repos'){const page=await client.repos(identity.account,repoPage+1,request.signal);if(request.current()){setRepos(items=>[...new Set([...items,...page.items])]);setRepoPage(index=>index+1);setRepoMore(page.hasMore)}}
  else if(kind==='pulls'){const page=await client.pulls(identity.account,repository,pullPage+1,request.signal);if(request.current()){setPulls(items=>{const keys=new Set(items.map(recordKey));return [...items,...page.items.filter(item=>!keys.has(recordKey(item)))]});setPullPage(index=>index+1);setPullMore(page.hasMore)}}
  else if(record){const index=pages[kind]+1;if(index>60)throw new GitHubError('limit',text('Pagination limit reached; open GitHub for more','分页上限已到，请在 GitHub 查看更多'))
   if(kind==='files'){const page=await client.files(identity.account,record,index,request.signal);if(request.current())setRecord(old=>old?{...old,files:[...old.files,...page.items.filter(item=>!old.files.some(file=>file.path===item.path))],filesHasMore:page.hasMore}:old)}
   if(kind==='comments'){const page=await client.comments(identity.account,record,index,request.signal);if(request.current())setRecord(old=>old?{...old,comments:[...old.comments,...page.items.filter(item=>!old.comments.some(comment=>comment.id===item.id))],commentsHasMore:page.hasMore}:old)}
   if(kind==='reviews'){const page=await client.reviews(identity.account,record,index,request.signal);if(request.current())setRecord(old=>old?{...old,reviews:[...old.reviews,...page.items.filter(item=>!old.reviews.some(review=>review.id===item.id))],reviewsHasMore:page.hasMore}:old)}
   if(request.current())setPages(old=>({...old,[kind]:index}))
  }
 }catch(e:unknown){if(request.current()){setError(message(e));if(e instanceof GitHubError&&['head_changed','account_changed'].includes(e.kind))setStale(true)}}finally{if(request.current())setBusy(false)}}
 useEffect(()=>()=>{authLane.cancel();listLane.cancel();detailLane.cancel();moreLane.cancel();cache.cancelPrefetch()},[cache,authLane,listLane,detailLane,moreLane])
 const filtered=filterPulls(pulls,query,mine?identity?.account??'':null)
 const selectedSummary=selected?pulls.find(item=>recordKey(item)===`${selected.repository.toLowerCase()}#${selected.id}`):undefined
 function jump(location:DiffLocation):void{const file=record?.files.find(f=>f.path===location.path);if(!file||!diffLines(file.patch).some(line=>line.side===location.side&&line.line===location.line)){setDetailError(text('Location is outside the loaded diff. Load more files or open GitHub.','位置不在已加载 Diff 内，请加载更多文件或在 GitHub 查看。'));return}setFocus(location);setTab('changes')}
 function switchTab(event:KeyboardEvent<HTMLButtonElement>):void{const tabs:['summary','changes','review']=['summary','changes','review'];const offset=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0;const next=event.key==='Home'?'summary':event.key==='End'?'review':offset?tabs[(tabs.indexOf(tab)+offset+3)%3]:undefined;if(next!==undefined){event.preventDefault();setTab(next);document.getElementById(`xhreview-tab-${next}`)?.focus()}}

 return <main className="xhreview" data-selected={selected!==null} aria-label="Code Review workspace">
 <nav className="xhreview-list" aria-label={text('Pull requests','PR 列表')}>
 <header><h1>Code Review</h1><button className="xhreview-close" type="button" aria-label={text('Back to chat','返回对话')} onClick={close}><IconCloseOutline16 size={18}/></button></header>
 <label className="xhreview-search"><IconSearchOutline16 size={18}/><input type="search" aria-label={text('Search or paste a PR link','搜索或粘贴 PR 链接')} placeholder={text('Search or paste a PR link','搜索或粘贴 PR 链接')} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')openLink()}}/></label>
 {parsePullLink(query)&&<button className="xhreview-action" disabled={!identity} onClick={openLink}>{text('Open PR','打开 PR')}</button>}
 {identity&&<div className="xhreview-filters"><RepositoryPicker repository={repository} repositories={repos} recent={recent} hasMore={repoMore} busy={busy} change={changeRepository} more={()=>void more('repos')} zh={zh}/><AuthorFilter mine={mine} change={changeAuthor} zh={zh}/></div>}
 <div className="xhreview-rows">{!identity&&<div className="xhreview-connect"><p>{loading||text("Uses GitHub CLI login on the Host computer.","使用 Host 所在电脑的 GitHub CLI 登录。")}</p>{error&&<p role="alert" className="xhreview-error">{error}</p>}</div>}{repoError&&<p role="alert" className="xhreview-error">{repoError}</p>}{listBusy&&<p role="status" className="xhreview-muted">{pulls.length?text('Refreshing…','刷新中…'):text('Loading…','加载中…')}</p>}{listError&&<p role="alert" className="xhreview-error">{listError} {text('List may be stale.','列表可能过期。')}</p>}{filtered.map(item=><button type="button" key={recordKey(item)} className="xhreview-row" aria-current={selected?.repository===item.repository&&selected.id===item.id?'true':undefined} onMouseEnter={()=>identity&&cache.prefetch(client,identity.account,item)} onFocus={()=>identity&&cache.prefetch(client,identity.account,item)} onMouseLeave={()=>cache.cancelPrefetch()} onBlur={()=>cache.cancelPrefetch()} onClick={()=>choose({repository:item.repository,id:item.id})}><span className="xhreview-row-title">{item.title}</span><span className="xhreview-row-meta"><Avatar author={item.author}/><span>#{item.id} · {age(item.updatedAt)}</span></span></button>)}{identity&&!listBusy&&filtered.length===0&&<p className="xhreview-empty-list" role="status">{text('No matching pull requests','没有匹配的 PR')}</p>}{pullMore&&<button className="xhreview-action" disabled={busy||listBusy} onClick={()=>void more('pulls')}>{text('Load more','加载更多')}</button>}</div>
 <footer className="xhreview-account"><span>{identity?.account??'GitHub'}</span><button type="button" disabled={!!loading} onClick={()=>identity?setEpoch(value=>value+1):setAuthEpoch(value=>value+1)}>{text('Refresh','刷新')}</button>{identity&&<button type="button" onClick={()=>{cache.clear();setAuthEpoch(value=>value+1)}}>{text('Reconnect','重新连接')}</button>}</footer></nav>
 <div className="xhreview-detail">{(error||detailError)&&<div role="alert" className="xhreview-error">{error||detailError}</div>}{loading&&<div role="status" className="xhreview-loading">{loading}</div>}{record?<>
 <header className="xhreview-toolbar"><button type="button" className="xhreview-list-back" onClick={()=>{detailLane.cancel();moreLane.cancel();setSelected(null);setRecord(null);setLoading('')}}>{text('Pull requests','PR 列表')}</button><div className="xhreview-tabs" role="tablist" aria-label={text('Pull request content','PR 内容')}>
 <button type="button" id="xhreview-tab-summary" role="tab" aria-selected={tab==='summary'} aria-controls="xhreview-panel" tabIndex={tab==='summary'?0:-1} onKeyDown={switchTab} onClick={()=>setTab('summary')}>{text('Summary','概述')}</button>
 <button type="button" id="xhreview-tab-changes" role="tab" aria-selected={tab==='changes'} aria-controls="xhreview-panel" tabIndex={tab==='changes'?0:-1} onKeyDown={switchTab} onClick={()=>setTab('changes')}>{text('Changes','变更')} <span className="xhreview-add">+{record.additions}</span> <span className="xhreview-remove">−{record.deletions}</span></button><button type="button" id="xhreview-tab-review" role="tab" aria-selected={tab==='review'} aria-controls="xhreview-panel" tabIndex={tab==='review'?0:-1} onKeyDown={switchTab} onClick={()=>setTab('review')}>{text('Review','审核')}</button></div><button type="button" className="xhreview-handoff" disabled={stale} onClick={()=>{try{openAssistant(pullReference(record))}catch(e:unknown){setError(message(e))}}}>{text('Ask Little X','交给小 X')}</button><a className="xhreview-github" href={`https://github.com/${record.repository}/pull/${record.id}`} target="_blank" rel="noopener noreferrer">GitHub ↗</a></header>
 {stale&&<p className="xhreview-error" role="status">{loading?text('Refreshing cached data…','正在刷新缓存数据…'):text('Cached data. Refresh required.','缓存数据，需要刷新。')}</p>}
 <div className="xhreview-content"><section id="xhreview-panel" className="xhreview-body" role="tabpanel" aria-labelledby={`xhreview-tab-${tab}`} key={`${recordKey(record)}:${tab}`}>
 <div className="xhreview-identity"><span className="xhreview-open"><IconBranchOutline16 size={16}/> {record.draft?text('Draft','草稿'):record.state}</span><span>{record.repository} #{record.id}</span></div>
 <h2>{record.title}</h2><div className="xhreview-author"><Avatar author={record.author}/><strong>{record.author}</strong><span>{age(record.updatedAt)}</span><span className="xhreview-branch" title={record.branch}>· {record.branch} → {record.baseBranch}</span></div>
 {tab==='summary'?<article className="xhreview-description">{record.body?<div className="xhreview-description-body"><MarkdownText text={record.body}/></div>:<p className="xhreview-muted">{text('No description','暂无说明')}</p>}</article>:tab==='review'?<ReviewPanel key={`${identity?.account}:${recordKey(record)}`} account={identity?.account??''} client={client} record={record} zh={zh} disabled={stale} jump={jump} reference={(location)=>{try{openAssistant(pullReference(record,location))}catch(e:unknown){setError(message(e))}}}/>:<div className="xhreview-files"><p className="xhreview-muted">{record.files.length} / {record.changedFiles} {text('files','个文件')}</p>{record.files.map((file,index)=><FileDiff key={file.path} file={file} initiallyOpen={index===0} focus={focus} reference={!stale?(location)=>{try{openAssistant(pullReference(record,location))}catch(e:unknown){setError(message(e))}}:undefined}/>)}{record.filesHasMore&&<button disabled={busy||stale} onClick={()=>void more('files')}>{text('Load more files','加载更多文件')}</button>}{!record.filesHasMore&&record.files.length<record.changedFiles&&<p role="status">{text('GitHub file limit reached. Open GitHub for the remaining files.','GitHub 文件上限已到，请在 GitHub 查看其余文件。')}</p>}</div>}
 </section><Metadata revision={epoch} record={record} more={kind=>void more(kind)} busy={busy||stale} account={identity?.account??''} client={client} jump={jump}/></div>
 </>:selectedSummary?<section className="xhreview-pending" aria-busy={!!loading}><div className="xhreview-identity"><span>{selectedSummary.repository} #{selectedSummary.id}</span></div><h2>{selectedSummary.title}</h2><div className="xhreview-author"><Avatar author={selectedSummary.author}/><strong>{selectedSummary.author}</strong><span>{selectedSummary.branch}</span></div><p className="xhreview-muted">{loading?text('Loading description and changes…','正在加载说明和变更…'):text('Details unavailable. Retry refresh.','详情暂不可用，请刷新重试。')}</p></section>:<div className="xhreview-empty"><IconBranchOutline16 size={32}/><h2>{identity?text('Select a pull request','选择一个 PR'):text('Connect GitHub','连接 GitHub')}</h2><p>{identity?text('Choose one from the sidebar to review its changes','从左侧选择 PR 查看变更'):text('Uses GitHub CLI login on the Host computer.','使用 Host 所在电脑的 GitHub CLI 登录。')}</p>{!identity&&!loading&&<button type="button" onClick={()=>{cache.clear();setAuthEpoch(value=>value+1)}}>{text('Retry connection','重试连接')}</button>}{selected&&<button className="xhreview-list-back" onClick={()=>{setSelected(null);setLoading('')}}>{text('Pull requests','PR 列表')}</button>}</div>}</div></main>
}
interface ReviewContext extends Pick<ClientContext,'effect'|'slots'> {get(name:'connection'):{rpc:ClientConnectionRpc}}
export const inject=['slots','connection']
export function apply(ctx:ReviewContext):void{
 ctx.effect(()=>{const style=document.createElement('style');style.dataset.xharnessCodeReview='';style.textContent=CSS;document.head.append(style);return()=>style.remove()},'code-review: scoped styles')
 const rpc=ctx.get('connection').rpc,cache=new ReviewCache(Date.now,typeof indexedDB==='undefined'?undefined:new BrowserReviewStorage(indexedDB))
 const preferences=new ReviewPreferences(typeof indexedDB==='undefined'?undefined:new BrowserReviewStorage(indexedDB,'preferences'))
 const client=new GitHubClient(rpc,()=>cache.foreground()),backgroundClient=new GitHubClient(rpc)
 ctx.effect(()=>{cache.startIdle(backgroundClient,new BrowserIdleEnvironment());return()=>cache.dispose()},'code-review: cooperative idle preloading')
 ctx.slots.inject('review.center',()=>ctx.slots.register({name:'review.center',id:'code-review',inject:()=>({client,cache,preferences})},CodeReview))
 ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'code-review-navigation',order:0},ReviewNavigation))
}
export {decodeReviewReport,diffLines,reportIsStale} from './structured'
export type {ReviewFinding,ReviewReport,ReviewSnapshot,ReviewTarget} from './structured'
