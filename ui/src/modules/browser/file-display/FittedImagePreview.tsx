import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import {imageReadQueue,imageUrlPool} from '@xharness/dsh-client-ui-primitives'
import {FileDisplayClient,imageResource} from './client'
import {ImagePreview} from './ImagePreview'
type Raster={blob:Blob;path:string;width:number;height:number;decodedWidth:number;decodedHeight:number;canSuspend:boolean;sourceId?:string;original:boolean}
/** Fit reads are physically sized for the panel AND DPR. Explicit zoom is never
 * synthesized by enlarging the derivative; it requests the byte-exact original.
 * Only bounded compressed snapshots/URLs survive hiding, not raster DOM. */
export function FittedImagePreview({path,sessionId,client,open,zoom,ready,zh}:{path:string;sessionId:string;client:FileDisplayClient;open:boolean;zoom:number;ready():void;zh:boolean}){
  const frame=useRef<HTMLDivElement>(null),[owner]=useState(()=>Symbol('workspace-raster-snapshot'))
  const [size,setSize]=useState({width:0,height:0,dpr:1}),[fit,setFit]=useState<Raster>(),[original,setOriginal]=useState<Raster>(),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[forceOriginal,setForceOriginal]=useState(false),[loading,setLoading]=useState(false)
  useEffect(()=>()=>imageUrlPool.dispose(owner),[owner])
  useLayoutEffect(()=>{
    const parent=frame.current?.parentElement;if(!parent||!open)return
    let timer:number|undefined
    const measure=()=>{const width=Math.floor(parent.clientWidth-40),height=Math.floor(parent.clientHeight-76);if(width<1||height<1)return;const dpr=window.devicePixelRatio||1;setSize({width,height,dpr})}
    const later=()=>{window.clearTimeout(timer);timer=window.setTimeout(measure,180)}
    const observer=new ResizeObserver(later);observer.observe(parent);window.addEventListener('resize',later)
    const density=window.matchMedia(`(resolution: ${size.dpr}dppx)`);density.addEventListener('change',later);measure()
    return()=>{window.clearTimeout(timer);observer.disconnect();window.removeEventListener('resize',later);density.removeEventListener('change',later)}
  },[open,size.dpr])
  const physicalWidth=Math.max(1,Math.ceil(size.width*size.dpr)),physicalHeight=Math.max(1,Math.ceil(size.height*size.dpr))
  const wantsOriginal=forceOriginal||zoom>0||physicalWidth>4096||physicalHeight>4096||physicalWidth*physicalHeight>4*1024*1024
  const width=wantsOriginal?1:physicalWidth,height=wantsOriginal?1:physicalHeight
  useEffect(()=>{
    if(!open||!size.width)return
    const source=fit??original,scale=source?Math.min(1,width/source.width,height/source.height):0
    if(wantsOriginal?original!==undefined:fit!==undefined&&fit.decodedWidth+1>=fit.width*scale&&fit.decodedHeight+1>=fit.height*scale){setError('');setLoading(false);return}
    const controller=new AbortController();setLoading(true);setError('')
    void imageReadQueue.run(async()=>{
      try{
        const response=await client.imagePreview(sessionId,path,controller.signal,{width,height},wantsOriginal,source?.sourceId)
        const resource=imageResource({kind:'image',path:response.path,mediaType:response.mediaType,dataBase64:response.dataBase64,width:response.width,height:response.height})
        return {...resource,path:response.path,width:response.sourceWidth,height:response.sourceHeight,decodedWidth:response.width,decodedHeight:response.height,sourceId:response.sourceId,original:response.original} satisfies Raster
      }catch(error){
        // An older Host or unsupported color/animation keeps an explicit
        // original-open action. Never silently load it as a small fit preview.
        if(!wantsOriginal||source?.sourceId||controller.signal.aborted)throw error
        const file=await client.read(sessionId,path,controller.signal)
        if(file.kind!=='image')throw Error('Not an image')
        return {...imageResource(file),path:file.path,width:file.width,height:file.height,decodedWidth:file.width,decodedHeight:file.height,original:true} satisfies Raster
      }
    },controller.signal,true).then(image=>{
      if(controller.signal.aborted)return
      if(image.original)setOriginal(image);else setFit(image)
      setLoading(false)
    }).catch((error:unknown)=>{if(!controller.signal.aborted){setError(error instanceof Error?error.message:String(error));setLoading(false)}})
    return()=>controller.abort()
  },[client,sessionId,path,open,width,height,wantsOriginal,attempt,fit,original,size.width])
  const selected=wantsOriginal?(original??fit):(fit??original)
  const show=open||selected?.canSuspend===false
  // Physical derivative pixels must not become CSS pixels for height-limited
  // portrait images on Retina. Keep small originals at their intrinsic CSS size.
  const display=selected?{...selected,displayWidth:selected.width*Math.min(1,size.width/selected.width,size.height/selected.height)}:undefined
  return <div ref={frame} className="xhfile-raster-stage" data-raster-quality={selected?.original?'original':'fit'}>
    {selected&&display&&<ImagePreview image={display} zoom={selected.original?zoom:0} ready={ready} zh={zh} active={show} owner={owner}/>}
    {open&&loading&&<p role="status">{zh?'加载清晰预览…':'Loading sharp preview…'}</p>}
    {open&&error&&<div role="alert"><p>{error}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>{zh?'重试':'Retry'}</button> <button type="button" onClick={()=>{setForceOriginal(true);setAttempt(value=>value+1)}}>{zh?'查看原图':'Open original'}</button></div>}
  </div>
}
