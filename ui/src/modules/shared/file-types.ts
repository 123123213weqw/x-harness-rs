/** Visual classification is not a promise that a file can be rendered. */
export type ProducedFileKind='website'|'pdf'|'markdown'|'code'|'image'|'spreadsheet'|'presentation'|'document'|'video'|'audio'|'archive'|'data'|'file'
export interface FileType {kind:ProducedFileKind;extensions:readonly string[];color:string;preview:'text'|'image'|'pdf'|'none'}
const fallback:FileType={kind:'file',extensions:[],color:'#8c8e97',preview:'none'}
export const FILE_TYPES:readonly FileType[]=[
 {kind:'website',extensions:['html','htm'],color:'#33caf2',preview:'text'},
 {kind:'pdf',extensions:['pdf'],color:'#cb665d',preview:'pdf'},
 {kind:'markdown',extensions:['md','markdown','mdown'],color:'#7488aa',preview:'text'},
 {kind:'code',extensions:['ts','tsx','js','jsx','mjs','cjs','rs','py','go','c','h','cpp','java','swift','sh','bash','zsh','json','css','toml','yaml','yml','sql','xml','ipynb','diff','patch'],color:'#7275ce',preview:'text'},
 {kind:'image',extensions:['png','jpg','jpeg','webp','gif','svg','avif','heic','bmp','tiff'],color:'#4baf87',preview:'image'},
 {kind:'spreadsheet',extensions:['xls','xlsx','xlsm','csv','tsv','ods'],color:'#398964',preview:'none'},
 {kind:'presentation',extensions:['ppt','pptx','pptm','key','odp'],color:'#cf7b3e',preview:'none'},
 {kind:'document',extensions:['doc','docx','docm','odt','pages','rtf','txt','log'],color:'#4b85cf',preview:'none'},
 {kind:'video',extensions:['mp4','mov','webm','mkv','avi'],color:'#9b78bd',preview:'none'},
 {kind:'audio',extensions:['mp3','wav','m4a','flac','ogg','aac'],color:'#bd779f',preview:'none'},
 {kind:'archive',extensions:['zip','gz','tar','7z','rar','bz2','xz'],color:'#a28a5a',preview:'none'},
 {kind:'data',extensions:['sqlite','sqlite3','db','parquet','arrow'],color:'#5d9b9b',preview:'none'},
 fallback,
]
export function fileName(path:string):string{return path.slice(Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\'))+1)}
export function parentPath(path:string):string{const at=Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\'));return at<0?'':path.slice(0,at)||path.slice(0,1)}
export function fileType(path:string):FileType{
 const name=fileName(path),dot=name.lastIndexOf('.'),ext=dot>0?name.slice(dot+1).toLowerCase():''
 const type=FILE_TYPES.find(item=>item.extensions.includes(ext))??fallback
 // These small text formats share a visual category with their binary cousins.
 if(['csv','tsv','txt','log','svg'].includes(ext))return {...type,preview:'text'}
 if(type.kind==='image'&&!['png','jpg','jpeg','webp','gif'].includes(ext))return {...type,preview:'none'}
 return type
}
export function producedFileKind(path:string):ProducedFileKind{return fileType(path).kind}
export function formatFileSize(bytes:number):string{
 if(!Number.isSafeInteger(bytes)||bytes<0)return ''
 const units=['B','KB','MB','GB','TB'];let unit=0,value=bytes
 while(value>=1024&&unit<units.length-1){value/=1024;unit++}
 return `${unit===0?value:Number(value.toFixed(value<10?1:0))} ${units[unit]}`
}
