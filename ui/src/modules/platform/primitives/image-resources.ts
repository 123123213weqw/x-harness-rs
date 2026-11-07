/** Shared platform singleton across attachment and workspace plugins. Accounting
 * is admitted RGBA demand, NOT a native RSS cap: retired engine caches can lag. */
export class DecodedImageBudget {
  private used = 0
  private readonly evictors = new Set<() => void>()
  onPressure(evict: () => void): () => void { this.evictors.add(evict); return () => { this.evictors.delete(evict) } }
  constructor(readonly limit = 128 * 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid decoded image budget')
  }
  reserve(width: number, height: number): { release(): void } | undefined {
    const bytes = width * height * 4
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || !Number.isSafeInteger(bytes)) return undefined
    if (bytes > this.limit - this.used) for (const evict of this.evictors) { evict(); if (bytes <= this.limit - this.used) break }
    if (bytes > this.limit - this.used) return undefined
    this.used += bytes
    let active = true
    return { release: () => { if (active) { active = false; this.used -= bytes } } }
  }
  get bytes(): number { return this.used }
}
export const decodedImageBudget = new DecodedImageBudget()
interface Job { start(): void; cancel(): void }
/** Serial thumbnail reads match the Host decoder's bounded slot; no burst of
 * full attachment bytes in transit. Cancellation removes queued work, rather
 * than merely ignoring its eventual React result. */
export class ThumbnailQueue {
  private active = false
  private readonly pending: Job[] = []
  run<T>(work: () => Promise<T>, signal: AbortSignal, interactive = false): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    if (this.pending.length >= 128) return Promise.reject(new Error('Thumbnail queue full; retry'))
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        cancel: () => {
          const index = this.pending.indexOf(job)
          if (index >= 0) this.pending.splice(index, 1)
          signal.removeEventListener('abort', job.cancel)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        start: () => {
          signal.removeEventListener('abort', job.cancel)
          this.active = true
          void Promise.resolve().then(() => { signal.throwIfAborted(); return work() })
            .then(resolve, reject).finally(() => { this.active = false; this.pump() })
        },
      }
      signal.addEventListener('abort', job.cancel, { once: true })
      if(interactive)this.pending.unshift(job);else this.pending.push(job)
      this.pump()
    })
  }
  private pump(): void {
    if (!this.active) this.pending.shift()?.start()
  }
}
export const imageReadQueue = new ThumbnailQueue()

interface CachedImage {
  owner: symbol; blob: Blob; url: string; active: number; touched: number
  lease: { release(): void }; alive: boolean
}
/** Retained tabs reuse a URL instead of creating another decoder on every show.
 * Inactive URLs remain charged until explicit close or LRU eviction; pressure
 * from any image consumer evicts them before refusing a new visible original. */
export class ImageUrlPool {
  private readonly entries: CachedImage[] = []
  constructor(private readonly budget: DecodedImageBudget, readonly byteLimit = 32*1024*1024, readonly countLimit = 12) {
    budget.onPressure(() => this.evictInactive())
  }
  private remove(entry: CachedImage): void {
    if (!entry.alive) return
    entry.alive=false;URL.revokeObjectURL(entry.url);entry.lease.release()
    const index=this.entries.indexOf(entry);if(index>=0)this.entries.splice(index,1)
  }
  evictInactive(): void { for(const entry of [...this.entries].sort((a,b)=>a.touched-b.touched)) if(entry.active===0)this.remove(entry) }
  dispose(owner: symbol): void { for(const entry of [...this.entries]) if(entry.owner===owner)this.remove(entry) }
  acquire(owner: symbol, blob: Blob, width: number, height: number): {url:string;release():void}|undefined {
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(width*height*4)||width*height*4>this.budget.limit)return undefined
    let entry=this.entries.find(entry=>entry.owner===owner&&entry.blob===blob&&entry.alive)
    if(!entry){
      if(blob.size>this.byteLimit)return undefined
      const bytes=()=>this.entries.reduce((sum,entry)=>sum+entry.blob.size,0)
      for(const old of [...this.entries].sort((a,b)=>a.touched-b.touched)){
        if(this.entries.length<this.countLimit&&bytes()+blob.size<=this.byteLimit)break
        if(old.active===0)this.remove(old)
      }
      if(this.entries.length>=this.countLimit||bytes()+blob.size>this.byteLimit)return undefined
      const lease=this.budget.reserve(width,height);if(!lease)return undefined
      let url:string
      try{url=URL.createObjectURL(blob)}catch(error){lease.release();throw error}
      entry={owner,blob,url,active:0,touched:0,lease,alive:true};this.entries.push(entry)
    }
    const held=entry;held.active++;held.touched=Date.now();let active=true
    return {url:held.url,release:()=>{if(active){active=false;held.active--;held.touched=Date.now()}}}
  }
  get size():number{return this.entries.length}
}
export const imageUrlPool = new ImageUrlPool(decodedImageBudget)
