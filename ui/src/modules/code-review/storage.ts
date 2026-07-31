/** One bounded, origin-local snapshot. Contains PR data, never credentials.
 * All transactions close their database handle; storage failure is non-fatal.
 */
export interface ReviewStorage {read():Promise<string|undefined>;write(value:string|undefined):Promise<void>}
export class BrowserReviewStorage implements ReviewStorage {
 constructor(private readonly factory:IDBFactory){}
 private async transaction(write:boolean,value?:string):Promise<string|undefined>{
  return new Promise((resolve,reject)=>{
   const opening=this.factory.open('xharness-code-review-v1',1)
   let settled=false
   let database:IDBDatabase|undefined,transaction:IDBTransaction|undefined
   const timer=setTimeout(()=>fail(),1000)
   const fail=()=>{if(!settled){settled=true;clearTimeout(timer);try{transaction?.abort()}catch{/* Already completed. */}database?.close();reject(new Error('Review cache unavailable'))}}
   opening.onerror=fail
   opening.onblocked=fail
   opening.onupgradeneeded=()=>{if(!opening.result.objectStoreNames.contains('cache'))opening.result.createObjectStore('cache')}
   opening.onsuccess=()=>{
    const db=opening.result;database=db
    if(settled){db.close();return}
    db.onversionchange=()=>db.close()
    try{
     const tx=db.transaction('cache',write?'readwrite':'readonly'),store=tx.objectStore('cache');transaction=tx
     let result:string|undefined
     if(write){if(value===undefined)store.delete('snapshot');else store.put(value,'snapshot')}
     else {const request:IDBRequest<unknown>=store.get('snapshot');request.onsuccess=()=>{const data:unknown=request.result;if(typeof data==='string')result=data}}
     tx.oncomplete=()=>{db.close();if(!settled){settled=true;clearTimeout(timer);resolve(result)}}
     tx.onerror=tx.onabort=()=>{db.close();fail()}
    }catch{db.close();fail()}
   }
  })
 }
 read():Promise<string|undefined>{return this.transaction(false)}
 async write(value:string|undefined):Promise<void>{await this.transaction(true,value)}
}
