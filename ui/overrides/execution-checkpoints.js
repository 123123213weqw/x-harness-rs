// xh-execution-checkpoints/v1
function xhCheckpointState(event) {
 if(event.type==='run/checkpoint' && event.data?.notice) return {turn:event.data.turn,seq:event.seq,time:event.time,...event.data.notice};
 if(event.type==='turn/end' && event.data?.reason?.kind==='max-steps') return {turn:event.data.turn,seq:event.seq,time:event.time,kind:'limit',message:'已达到本轮步骤硬上限，进度已保存。发送“继续”可启动下一轮；不会重放已完成的工具。'};
 return null;
}
const xhCheckpointDefinition={
 kind:'run-checkpoint',target:'chat',
 match:event=>xhCheckpointState(event)?{id:String(event.seq),role:'start'}:null,
 start:(_ctx,match)=>xhCheckpointState(match.event),
 update:ctx=>ctx.state,
 publication:()=> 'immediate',
 buildViewNode:ctx=>ctx.state?chatNode(ctx,'run-checkpoint',ctx.state.seq,{...ctx.state,noticeKind:ctx.state.kind,kind:'run-checkpoint',step:ctx.start?.location?.step?.step??0}):null
};
const XhCheckpointView=(0,react.memo)(function XhCheckpointView({node}){
 const d=node.data;
 const title=d.noticeKind==='limit'?'执行已停止：步骤硬上限':d.noticeKind==='continued'?'已进入下一执行阶段':'执行检查点';
 return (0,react_jsx_runtime.jsxs)('details',{className:MessageItem_module_css_default.contextRow,style:{padding:'10px 12px',border:'1px solid var(--dsw-alias-border-l2, #d9dde5)',borderRadius:8,fontSize:13,lineHeight:1.6,color:'var(--dsw-alias-label-secondary, #525866)'},open:d.noticeKind==='limit',children:[
  (0,react_jsx_runtime.jsx)('summary',{style:{cursor:'pointer',fontWeight:500},children:title}),
  (0,react_jsx_runtime.jsx)('div',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'},children:d.message})
 ]});
});
