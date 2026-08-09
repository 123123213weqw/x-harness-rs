import {useEffect,useId,useRef,useState} from 'react'
import type {KeyboardEvent} from 'react'
import {IconChevronDownOutline14,IconSearchOutline16,IconCheckOutline16} from '@xharness/dsh-client-ui-primitives'
import {repositoryGroups} from './preferences'
interface PickerProps {repository:string;repositories:readonly string[];recent:readonly string[];hasMore:boolean;busy:boolean;change(value:string):void;more():void;zh:boolean}
export function RepositoryPicker({repository,repositories,recent,hasMore,busy,change,more,zh}:PickerProps){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0)
 const root=useRef<HTMLDivElement|null>(null),trigger=useRef<HTMLButtonElement|null>(null),search=useRef<HTMLInputElement|null>(null),list=useRef<HTMLDivElement|null>(null)
 const id=useId(),groups=repositoryGroups(repositories,recent,query),items=groups.flatMap(group=>group.items),index=Math.min(active,Math.max(0,items.length-1))
 const words=(en:string,cn:string)=>zh?cn:en
 const dismiss=()=>{setOpen(false);trigger.current?.focus()}
 const choose=(value:string)=>{change(value);dismiss()}
 const show=()=>{setQuery('');setActive(Math.max(0,repositoryGroups(repositories,recent,'').flatMap(group=>group.items).indexOf(repository)));setOpen(true)}
 useEffect(()=>{if(!open)return;search.current?.focus();const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false)};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)},[open])
 useEffect(()=>{if(open)list.current?.querySelector('[data-highlighted=true]')?.scrollIntoView({block:'nearest'})},[open,index,query])
 function keys(event:KeyboardEvent<HTMLInputElement>):void{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss()}
  else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(value=>items.length?(Math.min(value,items.length-1)+(event.key==='ArrowDown'?1:-1)+items.length)%items.length:0)}
  else if(event.key==='Enter'){event.preventDefault();const item=items[index];if(item!==undefined)choose(item)}
 }
 const slash=repository.indexOf('/'),name=slash<0?repository:repository.slice(slash+1)
 return <div ref={root} className="xhreview-repository" onBlur={event=>{if(event.relatedTarget instanceof Node&&!event.currentTarget.contains(event.relatedTarget))setOpen(false)}}>
  <button ref={trigger} type="button" className="xhreview-repository-trigger" aria-label={`${words('Repository','仓库')}: ${repository||words('Select repository','选择仓库')}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} title={repository} onClick={()=>open?dismiss():show()} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();show()}}}><span>{name||words('Select repository','选择仓库')}</span><IconChevronDownOutline14 size={14}/></button>
  {open&&<section id={id} role="dialog" aria-label={words('Choose repository','选择仓库')} className="xhreview-repository-popover" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss()}}}>
   <label className="xhreview-repository-search"><IconSearchOutline16 size={16}/><input ref={search} type="search" role="combobox" aria-label={words('Search repositories','搜索仓库')} placeholder={words('Search repositories…','搜索仓库…')} value={query} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={items.length?`${id}-option-${index}`:undefined} onChange={event=>{setQuery(event.target.value);setActive(0)}} onKeyDown={keys}/></label>
   <div ref={list} id={`${id}-list`} className="xhreview-repository-options" role="listbox" aria-label={words('Repositories','仓库列表')}>
    {groups.map(group=><div key={group.label} role="group" aria-label={group.label==='recent'?words('Recently used','最近使用'):words('Repositories','仓库')}><div className="xhreview-repository-group" aria-hidden="true">{group.label==='recent'?words('Recently used','最近使用'):words('Repositories','仓库')}</div>{group.items.map(repo=>{const rowIndex=items.indexOf(repo),split=repo.indexOf('/');return <button key={repo} id={`${id}-option-${rowIndex}`} type="button" role="option" aria-label={repo} aria-selected={repo===repository} tabIndex={-1} data-highlighted={rowIndex===index} className="xhreview-repository-option" title={repo} onPointerMove={()=>setActive(rowIndex)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(repo)}><span><strong>{repo.slice(split+1)}</strong><small>{repo.slice(0,split)}</small></span>{repo===repository&&<IconCheckOutline16 size={16}/>}</button>})}</div>)}
    {!items.length&&<p role="status" className="xhreview-repository-none">{words('No matching repositories','没有匹配的仓库')}</p>}
   </div>
   {hasMore&&<button type="button" className="xhreview-repository-more" disabled={busy} onClick={more}>{busy?words('Loading…','加载中…'):words('Load more repositories','加载更多仓库')}</button>}
  </section>}
 </div>
}
export function AuthorFilter({mine,change,zh}:{mine:boolean;change(value:boolean):void;zh:boolean}){
 const all=useRef<HTMLButtonElement|null>(null),own=useRef<HTMLButtonElement|null>(null)
 function keys(event:KeyboardEvent<HTMLButtonElement>):void{const value=event.key==='ArrowLeft'||event.key==='Home'?false:event.key==='ArrowRight'||event.key==='End'?true:undefined;if(value!==undefined){event.preventDefault();change(value);(value?own:all).current?.focus()}}
 return <div className="xhreview-author-filter" role="radiogroup" aria-label={zh?'筛选当前仓库的开放 PR':'Filter open pull requests in this repository'}>
  <button ref={all} type="button" role="radio" aria-checked={!mine} tabIndex={!mine?0:-1} onKeyDown={keys} onClick={()=>change(false)}>{zh?'全部':'All'}</button>
  <button ref={own} type="button" role="radio" aria-checked={mine} tabIndex={mine?0:-1} onKeyDown={keys} onClick={()=>change(true)}>{zh?'由我创建':'Authored by me'}</button>
 </div>
}
