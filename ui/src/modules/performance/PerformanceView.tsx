import { useEffect, useMemo, useState } from 'react'
import type { UseProjection } from '../client-runtime/index'
import type { Translation } from '../shared/runtime-types'
import { readTimeline, type PhaseKind } from './contract'
import { nearest, reportedTps, sampleTps, series, type Track } from './chart'
export interface PerformanceProps { useProjection: UseProjection; t: Translation }
const tracks: readonly [Track, 'text'|'reasoning'|'arguments'][] = [['textUnits','text'],['reasoningUnits','reasoning'],['argumentUnits','arguments']]
const format = (n: number): string => n.toFixed(1)
export function PerformanceView({ useProjection, t }: PerformanceProps) {
  const raw = useProjection('performanceTimeline')
  const timeline = useMemo(()=>readTimeline(raw),[raw])
  const [selected,setSelected] = useState<number | null>(null), [smooth,setSmooth] = useState(false), [hover,setHover] = useState<number | null>(null), [showTable,setShowTable] = useState(false)
  const turn = timeline?.turns.find(turn=>turn.turn===selected) ?? timeline?.turns.at(-1)
  useEffect(()=>{setHover(null)},[turn?.turn])
  if (timeline === null || turn === undefined) return <section data-conversation-composer-overlay="" className="xhperf"><h2>{t('title')}</h2><p role="status">{t(raw === undefined ? 'unavailable' : timeline === null ? 'invalid' : 'empty')}</p></section>
  const firstSample = turn.samples[0]
  const start = firstSample !== undefined && turn.truncated ? Math.max(turn.startMs,firstSample.timeMs) : turn.startMs
  const end = Math.max(start+1000,turn.endMs ?? turn.lastMs, (turn.samples.at(-1)?.timeMs ?? start)+1000)
  const x = (time: number) => 46+Math.max(0,Math.min(1,(time-start)/(end-start)))*690
  const requestFor = (sample: typeof turn.samples[number]) => turn.requests.find(r=>r.step===sample.step&&r.attempt===sample.attempt)
  const rate = (sample: typeof turn.samples[number], track?: Track) => sampleTps(sample,track,requestFor(sample))
  const max = Math.max(5,...turn.samples.map(sample=>rate(sample)))
  const y = (value: number) => 230-Math.min(1,value/max)*190
  const sample = hover === null ? undefined : turn.samples[hover]
  const request = sample === undefined ? undefined : turn.requests.find(r=>r.step===sample.step&&r.attempt===sample.attempt)
  const avg = reportedTps(turn)
  const phaseClass = (kind: PhaseKind) => kind === 'reasoning' || kind === 'arguments' ? kind+'Band' : kind
  return <section data-conversation-composer-overlay="" className="xhperf" data-performance-view="">
    <header><h2>{t('title')}</h2><select aria-label={t('turn')} value={turn.turn} onChange={e=>{setSelected(Number(e.target.value));setHover(null)}}>{timeline.turns.map(item=><option key={item.turn} value={item.turn}>{t('turn')} {item.turn+1} · {t(item.endMs===null?'live':'done')}</option>)}</select>
      <button aria-pressed={!smooth} onClick={()=>setSmooth(false)}>{t('raw')}</button><button aria-pressed={smooth} onClick={()=>setSmooth(true)}>{t('smooth')}</button></header>
    <p>{t(turn.requests.length > 0 && turn.requests.every(r=>r.receptionMs !== undefined) ? 'receptionEstimate' : 'estimate')}</p>{turn.truncated && <p role="status">{t('retention')}</p>}
    {turn.samples.length === 0 ? <p>{t('empty')}</p> : <figure>
      <svg viewBox="0 0 760 300" role="img" aria-label={`${t('rate')} · tok/s`} tabIndex={0}
        onPointerMove={e=>{const rect=e.currentTarget.getBoundingClientRect();const found=nearest(turn,start+Math.max(0,Math.min(1,((e.clientX-rect.left)/rect.width*760-46)/690))*(end-start)-500);setHover(found===undefined?null:turn.samples.indexOf(found))}}
        onPointerLeave={()=>setHover(null)} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const index=hover??-1;const next=Math.max(0,Math.min(turn.samples.length-1,index+(e.key==='ArrowRight'?1:-1)));if(turn.samples[next]!==undefined)setHover(next)}}}>
        <title>{t('rate')}</title>
        {[0,0.5,1].map(f=><g key={f}><line className="grid" x1="46" x2="736" y1={y(f*max)} y2={y(f*max)}/><text className="axis" x="38" y={y(f*max)+4} textAnchor="end">{format(f*max)}</text></g>)}
        <text className="axis" x="46" y="22">tok/s ≈</text>
        {tracks.flatMap(([track,cls])=>series(turn,track,smooth).map((segment,i)=>{const first=segment[0];return <g key={`${track}-${i}`} className={cls} fill="none"><polyline data-tps-track={cls} points={segment.map(s=>`${x(s.timeMs+500)},${y(rate(s,track))}`).join(' ')} strokeWidth="2" strokeLinejoin="round"/>{segment.length===1&&first!==undefined&&<circle cx={x(first.timeMs+500)} cy={y(rate(first,track))} r="2" fill="currentColor"/>}</g>}))}
        {turn.phases.filter(phase=>(phase.endMs??turn.lastMs)>=start).map((phase,i)=><rect key={i} className={phaseClass(phase.kind)} x={x(phase.startMs)} y="250" width={Math.max(1,x(phase.endMs??turn.lastMs)-x(phase.startMs))} height="10" rx="2"><title>{t(phase.kind)} · {format(Math.max(0,phase.startMs-turn.startMs)/1000)}{t('seconds')}</title></rect>)}
        {[0,0.5,1].map(f=><text key={f} className="axis" x={46+f*690} y="285" textAnchor={f===0?'start':f===1?'end':'middle'}>{format((start-turn.startMs+f*(end-start))/1000)}{t('seconds')}</text>)}
        {sample!==undefined&&<line x1={x(sample.timeMs+500)} x2={x(sample.timeMs+500)} y1="35" y2="260" stroke="currentColor" strokeDasharray="3 4" opacity=".4"/>}
      </svg>
      <figcaption className="legend">{tracks.map(([,cls])=><span key={cls} className={cls}><i/>{t(cls)}</span>)}<span>{[...new Set(turn.phases.map(phase=>phase.kind))].map(kind=>t(kind)).join(' · ')}</span></figcaption>
    </figure>}
    <p>{t('hint')}</p>{avg !== null && <dl><dt>{t('reported')}</dt><dd>{format(avg)} tok/s</dd></dl>}
    {sample !== undefined && <dl aria-label={t('details')}><dt>{t('time')}</dt><dd>{format(Math.max(0,sample.timeMs-turn.startMs)/1000)}–{format(Math.max(0,sample.timeMs+1000-turn.startMs)/1000)}{t('seconds')}</dd><dt>{t('rate')}</dt><dd>≈ {format(rate(sample))} tok/s</dd><dt>{t('step')} / {t('attempt')}</dt><dd>{sample.step} / {sample.attempt+1}</dd><dt>{t('model')}</dt><dd>{request?.model??t('missing')}</dd><dt>{t('source')}</dt><dd>{t(request?.receptionMs === undefined ? 'estimate' : 'receptionEstimate')}</dd></dl>}
    <details onToggle={event=>setShowTable(event.currentTarget.open)}><summary>{t('table')}</summary>{showTable && <div><table><thead><tr>{['time','step','attempt','text','reasoning','arguments'].map(key=><th key={key}>{t(key)}</th>)}</tr></thead><tbody>{turn.samples.map((s,i)=><tr key={i}><td>{format(Math.max(0,s.timeMs-turn.startMs)/1000)}{t('seconds')}</td><td>{s.step}</td><td>{s.attempt+1}</td>{tracks.map(([track])=><td key={track}>≈ {format(rate(s,track))}</td>)}</tr>)}</tbody></table></div>}</details>
  </section>
}
