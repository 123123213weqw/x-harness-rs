export const NS = 'xharness.performance'
export const en = {
  title:'Performance', turn:'Turn', raw:'1s buckets', smooth:'3s smoothing', empty:'No timed stream checkpoints available. An average cannot reconstruct a curve.', unavailable:'This Host does not provide performance telemetry yet.', invalid:'Performance telemetry is incompatible. Chat history is unaffected.',
  receptionEstimate:'Reception estimate · before buffering · usage-calibrated after completion',
  estimate:'Reception estimate · journal checkpoint timing · not server decode TPS', retention:'Only the latest sampling window is retained. Older samples were evicted.',
  rate:'Estimated reception', reported:'Reported tokens / reception time', missing:'Unknown', time:'Time', step:'Step', attempt:'Attempt', model:'Model', source:'Source',
  text:'Text', reasoning:'Reasoning', arguments:'Tool input', details:'Sample details',
  preparing:'Preparing', waiting_first_token:'Waiting for first token', output:'Text output', tool:'Tools', approval:'Waiting for approval', question:'Waiting for answer', retry:'Retry', compaction:'Compaction', between_steps:'Between steps', unknown:'Unknown',
  table:'Accessible timeline data', seconds:'s', live:'Running', done:'Finished', hint:'Gaps mean no sample; tools and human waits are not zero decode speed.',
}
export const zh: Record<keyof typeof en,string> = {
  title:'性能', turn:'轮次', raw:'每秒采样', smooth:'3 秒平滑', empty:'没有可用的流式时间采样。不能根据平均值补出曲线。', unavailable:'当前 Host 尚未提供性能采样。', invalid:'性能采样协议不兼容；不影响聊天历史。',
  receptionEstimate:'接收侧采样 · 缓冲前计时 · 完成后按接口 Token 校准',
  estimate:'接收侧估算 · 日志检查点计时 · 不是服务端生成 TPS', retention:'仅保留最近采样窗口；更早的采样已淘汰。',
  rate:'估算接收速度', reported:'接口 Token / 接收耗时', missing:'未知', time:'时间', step:'步骤', attempt:'尝试', model:'模型', source:'来源',
  text:'正文', reasoning:'思考', arguments:'工具参数', details:'采样详情',
  preparing:'准备', waiting_first_token:'等待首 token', output:'正文输出', tool:'工具执行', approval:'等待审批', question:'等待回答', retry:'重试', compaction:'压缩', between_steps:'步骤间隔', unknown:'未知',
  table:'时间线数据表', seconds:'秒', live:'运行中', done:'已结束', hint:'断线表示缺少采样；工具执行和等待用户不记为零生成速度。',
}
