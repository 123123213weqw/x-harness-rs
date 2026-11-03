import {useEffect,useState} from 'react'

/** Only the visible static raster owns a URL and mounted decoder. Compressed
 * bytes stay with its bounded retained tab so offline revisit stays identical. */
export function ImagePreview({image,zoom,ready,zh}:{
  image:{blob:Blob;path:string;width:number;height:number};zoom:number;ready():void;zh:boolean
}){
  const [url,setUrl]=useState<string>(),[error,setError]=useState(''),[attempt,setAttempt]=useState(0)
  useEffect(()=>{
    let url:string|undefined
    setUrl(undefined);setError('')
    try{url=URL.createObjectURL(image.blob);setUrl(url)}
    catch(error:unknown){setError(error instanceof Error?error.message:String(error))}
    return()=>{if(url)URL.revokeObjectURL(url)}
  },[image.blob,attempt])
  if(error)return <div role="alert"><p>{zh?'无法加载图片预览':'Could not load image preview'}: {error}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>{zh?'重试':'Retry'}</button></div>
  if(!url)return null
  return <div className="xhfile-image"><img src={url} alt={image.path.split(/[\\/]/).at(-1)} style={zoom?{width:`${image.width*zoom/100}px`,maxWidth:'none'}:undefined} decoding="async" onLoad={ready}/><small>{image.width} × {image.height}</small></div>
}
