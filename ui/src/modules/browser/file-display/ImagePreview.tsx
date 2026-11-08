import {useEffect,useState} from 'react'
import {imageUrlPool} from '@xharness/dsh-client-ui-primitives'

/** A retained tab owns the URL, not each hide/show cycle. Inactive raster URLs
 * are globally bounded/evictable and stay charged until actual URL disposal. */
export function ImagePreview({image,zoom,ready,zh,active=true,owner:externalOwner}:{
  image:{blob:Blob;path:string;width:number;height:number;decodedWidth?:number;decodedHeight?:number;displayWidth?:number};zoom:number;ready():void;zh:boolean;active?:boolean;owner?:symbol
}){
  const [localOwner]=useState(()=>Symbol('workspace-image'))
  const owner=externalOwner??localOwner
  const [url,setUrl]=useState<string>(),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
  useEffect(()=>()=>{if(!externalOwner)imageUrlPool.dispose(owner)},[owner,externalOwner])
  useEffect(()=>{
    setUrl(undefined);setError('')
    if(!active)return
    try{
      const lease=imageUrlPool.acquire(owner,image.blob,image.decodedWidth??image.width,image.decodedHeight??image.height)
      if(!lease){setError(zh?'图片预览预算已满，关闭其他预览后重试':'Image preview budget reached; close other previews and retry');return}
      setUrl(lease.url);return()=>lease.release()
    }catch(error:unknown){setError(error instanceof Error?error.message:String(error))}
  },[image.blob,image.width,image.height,image.decodedWidth,image.decodedHeight,active,owner,attempt,zh])
  if(!active)return null
  if(error)return <div role="alert"><p>{error}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>{zh?'重试':'Retry'}</button></div>
  if(!url)return null
  return <div className="xhfile-image"><img src={url} alt={image.path.split(/[\\/]/).at(-1)} style={zoom?{width:`${image.width*zoom/100}px`,maxWidth:'none'}:image.displayWidth===undefined?undefined:{width:image.displayWidth,maxWidth:'100%'}} decoding="async" onError={()=>{imageUrlPool.dispose(owner);setError(zh?'图片解码失败；可刷新文件后重试':'Image decode failed; refresh the file and retry')}} onLoad={ready}/><small>{image.width} × {image.height}</small></div>
}
