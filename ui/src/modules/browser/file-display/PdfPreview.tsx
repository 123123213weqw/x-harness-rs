import {useState} from 'react'
/** Native PDF plugins do not expose a portable trusted reading-position API.
 * Keep hidden readers intact by default. Explicit pause is the safe opt-in;
 * resuming reloads the same bounded snapshot and may reset the reader position. */
export function PdfPreview({url,zh}:{url:string;zh:boolean}){
  const [paused,setPaused]=useState(false)
  return <><p className="xhfile-preview-note">{zh?'PDF 预览 · 暂停可释放预览资源，恢复时阅读位置可能重置':'PDF preview · Pausing releases the viewer; resuming may reset reading position'} <button type="button" onClick={()=>setPaused(value=>!value)}>{paused?(zh?'恢复 PDF 预览':'Resume PDF preview'):(zh?'暂停 PDF 预览':'Pause PDF preview')}</button></p>
    {!paused&&<iframe className="xhfile-document" title={zh?'PDF 预览':'PDF preview'} src={url} referrerPolicy="no-referrer"/>}</>
}
