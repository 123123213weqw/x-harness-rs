import type {TauriBridge} from '../shared/tauri'

/** Full rightward native lease; partial growth never replaces the left dock. */
export function xhCreateBrowserWindowController(tauri: TauriBridge | undefined) {
  const api=tauri?.window
  const LogicalSize=api?.LogicalSize??tauri?.dpi?.LogicalSize
  let lease:{baseWidth:number;addedWidth:number}|null=null
  let queue=Promise.resolve(0)
  const resize=async(open:boolean,preferredWidth:number):Promise<number>=>{
    if(typeof api?.getCurrentWindow!=='function'||typeof api.currentMonitor!=='function'||typeof LogicalSize!=='function')return 0
    const nativeWindow=api.getCurrentWindow()
    if(!nativeWindow||typeof nativeWindow.setSize!=='function')return 0
    const size=await nativeWindow.innerSize(),scale=await nativeWindow.scaleFactor()
    if(!Number.isFinite(scale)||scale<=0)return 0
    const logicalWidth=size.width/scale,logicalHeight=size.height/scale
    const unchanged=lease!==null&&Math.abs(logicalWidth-lease.baseWidth-lease.addedWidth)<=8
    if(!unchanged)lease=null
    if(!open){
      if(lease!==null)await nativeWindow.setSize(new LogicalSize(lease.baseWidth,logicalHeight))
      lease=null;return 0
    }
    if(await nativeWindow.isMaximized()||await nativeWindow.isFullscreen())return lease?.addedWidth??0
    const monitor=await api.currentMonitor()
    if(!monitor?.workArea?.position||!monitor.workArea.size)return lease?.addedWidth??0
    const position=await nativeWindow.outerPosition(),outer=await nativeWindow.outerSize()
    const wanted=Math.max(360,Math.min(900,Math.round(preferredWidth)))
    const rightEdge=monitor.workArea.position.x+monitor.workArea.size.width
    const spare=Math.max(0,(rightEdge-position.x-outer.width)/scale-8),priorAdded=lease?.addedWidth??0
    if(spare+priorAdded<wanted){
      if(lease!==null)await nativeWindow.setSize(new LogicalSize(lease.baseWidth,logicalHeight))
      lease=null;return 0
    }
    const baseWidth=lease?.baseWidth??logicalWidth
    if(Math.abs(wanted-priorAdded)>1)await nativeWindow.setSize(new LogicalSize(baseWidth+wanted,logicalHeight))
    lease={baseWidth,addedWidth:wanted};return wanted
  }
  return{set(open:boolean,preferredWidth=440):Promise<number>{
    queue=queue.catch(()=>0).then(()=>resize(open,preferredWidth))
    return queue.catch(()=>0)
  }}
}
