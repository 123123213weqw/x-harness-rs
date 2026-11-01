// Subscribe at spawn time: awaiting a later once('exit') misses early exits.
export function childLifecycle(child) {
 let finished=false
 const exited=new Promise(resolve=>{
  child.once('exit',(code,signal)=>{finished=true;resolve({code,signal})})
  child.once('error',error=>{finished=true;resolve({code:null,signal:null,error})})
 })
 child.stdin?.on('error',()=>{}) // An already-exited child can close stdin first.
 return {exited,async close(){
  if(!finished)child.stdin?.end()
  let timer
  try{return await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('Test-owned child did not exit after stdin EOF within 5 seconds'))},5000)})])}
  finally{clearTimeout(timer)}
 }}
}
export async function waitUntil(predicate,label,timeout=5000) {
 const deadline=Date.now()+timeout
 while(!predicate()){
  if(Date.now()>=deadline)throw Error(label+' did not complete before its test deadline')
  await new Promise(resolve=>setTimeout(resolve,5))
 }
}
