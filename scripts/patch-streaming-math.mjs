import {readFileSync,writeFileSync,existsSync,realpathSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const start='/* xh-streaming-math:start */',end='/* xh-streaming-math:end */';
const impl=readFileSync(new URL('../ui/overrides/streaming-math.js',import.meta.url),'utf8');
export function patchStreamingMath(source){
 const block=start+'\n'+impl+end+'\n';
 if(source.includes(start)){
  if(source.split(start).length!==2||source.split(end).length!==2)throw Error('Streaming math implementation anchors changed');
  return source.slice(0,source.indexOf(start))+block+source.slice(source.indexOf(end)+end.length).replace(/^\n/,'');
 }
 // Match parser shape, not a particular build's minified symbol names.
 const parsers=[...source.matchAll(/function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\2,\{extensions:\[([^\]]+)\],mdastExtensions:\[([^\]]+)\]\}\)\}/g)];
 const full=parsers.filter(p=>p[4].split(',').length===4&&p[5].split(',').length===2);
 const plain=parsers.filter(p=>p[4].split(',').length===2&&p[5].split(',').length===1);
 if(full.length!==1||plain.length!==1||full[0][3]!==plain[0][3])throw Error('Streaming math parser anchors changed');
 const constructor=new RegExp('"parser",new ([\\w$]+)\\('+plain[0][1]+'\\)','g');
 if([...source.matchAll(constructor)].length!==1)throw Error('Streaming math incremental parser anchor changed');
 source=source.replace(constructor,(_match,klass)=>`"parser",new ${klass}(text=>xhParseStreamingMath(text,${full[0][1]}))`);
 return block+source;
}
if(process.argv[1]&&existsSync(process.argv[1])&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const dist=resolve(process.argv[2]??'ui/dist'),index=join(dist,'index.html');
 let html=readFileSync(index,'utf8');
 const asset=html.match(/src="(\/assets\/index-[^"?]+\.js)(?:\?[^" ]*)?"/)?.[1];
 if(!asset)throw Error('UI entry missing');
 const source=patchStreamingMath(readFileSync(join(dist,asset),'utf8'));
 const out='/assets/index-xhmath-'+createHash('sha256').update(source).digest('hex').slice(0,12)+'.js';
 writeFileSync(join(dist,out),source);writeFileSync(index,html.replaceAll(asset,out));
 // Remove only our superseded artifact. Other upstream chunks may import the original entry.
 if(asset!==out&&/index-xh(math|motion)-/.test(asset))unlinkSync(join(dist,asset));
 console.log(out);
}
