// Shared attachment card presentation, matching the existing upstream tokens.
const attachmentStyle = document.createElement('style');
attachmentStyle.textContent = `.xh-file-card{box-sizing:border-box;position:relative;flex:0 0 240px;max-width:100%;width:240px;height:64px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:16px;background:var(--dsw-alias-interactive-bg-hover);padding:10px 32px 10px 12px;display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-primary)}.xh-file-card button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}.xh-file-card .xh-file-info{min-width:0;overflow:hidden;text-align:left;display:flex;flex-direction:column;gap:4px}.xh-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:175px;font-size:13px}.xh-file-size{font-size:11px;color:var(--dsw-alias-label-tertiary)}.xh-file-remove{position:absolute;right:6px;top:4px;width:24px;height:24px}.xh-attachment-toolbar{padding:4px 12px;display:flex;align-items:center}.xh-attachment-toolbar button{border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:4px 6px}.xh-attachment-toolbar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.xh-attachment-toolbar button:disabled{opacity:.5;cursor:default}.xh-file-card :focus-visible,.xh-attachment-toolbar :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}`;
document.head.appendChild(attachmentStyle);
function XHarnessFileCard({name,bytes,onRemove,removeLabel,onDownload,busy,error}) {
  const h=react.createElement;
  const size=bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KiB':(bytes/1048576).toFixed(1)+' MiB';
  return h('div',{className:'xh-file-card'},
    h('span',{'aria-hidden':true},'▤'),
    h(onDownload?'button':'div',{className:'xh-file-info',onClick:onDownload,disabled:busy,title:name},
      h('span',{className:'xh-file-name'},name||'附件'),
      h('span',{className:'xh-file-size',role:error?'alert':undefined},busy?'正在读取…':error?'读取失败，点击重试':size+(onDownload?' · 下载':''))),
    onRemove&&h('button',{type:'button',className:'xh-file-remove',onClick:onRemove,'aria-label':removeLabel||'移除 '+name},'×'));
}
function XHarnessHistoryFile({attachment,load}) {
  const [busy,setBusy]=react.useState(false),[error,setError]=react.useState(false);
  const download=async()=>{
    if(busy)return;setBusy(true);setError(false);
    try {const url=await load(attachment);const link=document.createElement('a');link.href=url;link.download=attachment.name||'attachment';document.body.appendChild(link);link.click();link.remove();}
    catch {setError(true);} finally {setBusy(false);}
  };
  return react.createElement(XHarnessFileCard,{name:attachment.name,bytes:attachment.bytes,onDownload:download,busy,error});
}
