'use strict';
// A shared presentation of persisted acquisition facts, not another completion
// or pagination policy. Unknown reasons remain unknown; never interpret logs.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ReaderAcquisitionFeedback=factory();})(globalThis,()=>{
 const stages={'update-history':'获取历史更新失败','task-record':'任务记录更新失败','database-index':'本地统计更新失败','inventory-index':'本地条数统计更新失败','inbox':'未读状态更新失败','unread-and-subscription':'未读或订阅状态更新失败','report-cleanup':'旧报告清理失败','home-refresh':'首页状态刷新失败','resources':'运行状态清理失败'};
 const labels={sent:'发出',received:'收到','post-comments':'博文评论'},boundary=new Set(['SINCE_BOUNDARY_IGNORED','PAGINATION_BOUNDARY','DELTA_END_UNVERIFIED','AUTO_SINCE_IGNORED','AUTO_EMPTY_UNKNOWN','AUTO_BOUNDARY']);
 const capped=new Set(['RETURN_LIMIT','REQUEST_LIMIT','AUTO_ROUND_LIMIT','AUTO_DAILY_BUDGET']);
 const knownMissing=s=>Number.isSafeInteger(s.dataStatus?.missingBodies)&&s.dataStatus.missingBodies>0;
 const uncertain=s=>s.stopCode&&boundary.has(s.stopCode)||s.dataStatus?.unknownMissing||s.dataStatus?.unknownTimeIds?.length||s.dataStatus?.progressConflict||s.located===false||
  (s.coverageUnverified||s.dataStatus?.coverageUnverified)&&!knownMissing(s);
 const commentDirections={both:['sent','received'],sent:['sent'],received:['received']};
 function subscriptionEmptyNote(entry,kind){
  const states=entry.dataStates||entry.directions;
  const pending=states?.length?states.some(s=>(!kind||s.kind===kind)&&(s.pendingNew??s.dataStatus?.pendingNew??s.update?.pending)):entry.pending;
  return pending?'有待补区间。':'本轮暂无新增';
 }
 function noticeSummary({code='',enabled=true,localOnly=false}={}){
  if(localOnly)return '正在恢复本地状态，请稍候。';
  if(code==='IP_GEO_DENIED')return '服务暂不支持当前地区'+(enabled?'，稍后自动重试。':'。');
  if(['AUTH_REQUIRED','MISSING_TOKEN','UNAUTHORIZED'].includes(code))return '登录状态需要更新，请前往账户设置。';
  if(code==='AUTO_DAILY_BUDGET')return '本期额度已用完，额度恢复后继续。';
  if(/^CLI_ACCOUNT_|^AUTO_ACCOUNT/.test(code)||code==='AUTO_BALANCE_UNKNOWN')return enabled?'服务账户暂时无法查询，稍后自动重试。':'服务账户暂时无法查询。';
  if(code==='AUTO_OUTCOME_UNKNOWN')return enabled?'上次读取结果待确认，稍后自动检查。':'上次读取结果待确认。';
  return enabled?'本轮检查未完成，稍后自动重试。':'检查未完成，可稍后重试。';
 }
 function coveredWithMissingBodies(sources,mode){
  const expected=commentDirections[String(mode||'').replace(/^comments-/,'')];
  return !!expected&&expected.length===sources.length&&expected.every(kind=>sources.some(s=>s.kind===kind))&&sources.every(s=>{
   const p=s.readProgress||{},d=s.dataStatus||{};
   return !s.source&&!s.stopCode&&!s.autoStop&&!s.failed&&!s.cancelled&&!s.returnLimited&&!s.repliesIncomplete&&
    p.status==='complete'&&p.targetCovered===true&&p.pending===false&&p.pendingNew===false&&p.deltaConnected===true&&
    d.targetCovered===true&&d.pendingNew===false&&d.deltaConnected===true&&!d.failed&&!d.unknownMissing&&!d.unknownTimeIds?.length&&!d.requestFailure&&!d.progressConflict&&
    Number.isSafeInteger(p.covered)&&Number.isSafeInteger(s.budget)&&s.budget>0&&p.covered>=s.budget&&
    (d.dataState==='historical-missing'&&d.missingBodies>0||d.dataState==='covered'&&!d.coverageUnverified&&!s.coverageUnverified);
  });
 }
 function describe(summary={},finished={}){
  const saved=summary.persistence?.coreSaved!==false&&(summary.persistence?.coreSaved===true||summary.syncOnly===true&&typeof summary.batchId==='string'&&!!summary.batchId||finished.dataSaved===true);
  const count=Number.isSafeInteger(summary.records)&&summary.records>=0?summary.records:null,n=count==null?'':` ${count} 条`;
  const failures=[...(summary.partialFailures||[]),...(finished.partialFailures||[])],issues=[],add=(code,text,detail,next,priority,missingBodyCount)=>{if(!issues.some(i=>i.code===code))issues.push({code,text,detail,next,priority,...(Number.isSafeInteger(missingBodyCount)&&missingBodyCount>0?{missingBodyCount}:{})});};
  const sources=summary.sources||[],targetCovered=sources.length>0&&sources.every(s=>s.dataStatus?.targetCovered===true||s.readProgress?.targetCovered===true);let resumable=false,pendingNew=false;
  for(const s of sources){const p=s.readProgress||{},d=s.dataStatus||{},u=s.update||{},code=s.stopCode||s.autoStop?.code||'',direction=labels[s.kind]||'数据';
   if(code==='DIRECTION_NOT_CHECKED')add('unchecked:'+s.kind,`${direction}方向未检查`,'本次该方向的返回上限为 0 条。','',12);
   if(d.unknownMissing)add('unknown-missing:'+s.kind,'部分缺失无法对应到 ID',`${direction}方向的接口缺失信息不足以核实范围。`,'',13);
   
   const pending=d.pendingNew===true||p.pendingNew===true||u.pending===true&&!u.caughtUp;
   const canResume=p.pending===true&&/^[1-9]\d*$/.test(p.cursor||'')||u.pending===true&&u.checkpointCommitted===true&&typeof u.intervalId==='string';resumable||=canResume;pendingNew||=pending;
   if(s.located===false||d.unknownTimeIds?.length)add('date','日期范围尚未确认完整','已保存内容可以保留，但部分记录的时间或日期边界尚未核实。','请查看运行详情中的日期状态。',10);
   if(boundary.has(code))add('boundary','分页范围尚未确认完整',s.reason||'已返回的数据保留，尚无足够证据确认分页已经接通。','请查看运行详情中的边界说明。',11);
   if(s.failed&&!boundary.has(code))add('source:'+s.kind,direction+'读取未完成',s.reason||'本次未取得可核实的响应。','',7);
   if(pending)add('new','待补区间',targetCovered?'本次条数目标已完成。新旧数据之间仍有未读取区间。':'新增区间尚未完全接回上次成功位置，已返回的数据保留。','',20);
   if(capped.has(code)||s.returnLimited||u.limited)add('limit',code==='REQUEST_LIMIT'?'已达到本次请求次数上限':code==='AUTO_DAILY_BUDGET'?'已达到今日额度':'已达到本次返回上限','本轮已按上限停止，不表示全部数据已经读取。','',30);
   if(s.incompleteReplies?.length||s.repliesIncomplete)add('replies','部分楼中楼回复未返回','已保存评论可以阅读；不能仅凭网页总数确定还缺多少条。','缺失情况见获取历史。',40);
   const missing=d.missingBodies??s.missingBodyIds?.length??0;
   if(missing>0)add('missing:'+s.kind,`获取过程中发现 ${missing} 个已知 ID 缺少正文`,`${direction}方向：分页连通与正文可用性是两件事。未返回不能单独证明删除；已保存的完整正文仍保留。`,count>0?'可直接导出已有数据；缺失情况见获取历史。':'请在获取历史查看缺失情况。',50,missing);
  }
  if(summary.historicalMissingIds?.length&&!issues.some(i=>i.code.startsWith('missing:'))){const missing=new Set(summary.historicalMissingIds).size;add('missing:history','获取过程中发现 '+missing+' 个已知 ID 缺少正文','这是上次获取范围中的历史缺失，不表示仍有新增待读取。','可直接导出已有数据；缺失情况见获取历史。',50,missing);}
  if(summary.cancelled||finished.cancelled)add('stopped','本次获取已停止','已返回的数据和已保存进度保留。','',5);
  for(const failure of failures){const stage=failure.stage||'unknown',repair=summary.inventoryRepair||finished.inventoryRepair;if(stage==='inventory-index'&&repair?.state==='complete')continue;const text=stage==='inventory-index'&&['queued','running'].includes(repair?.state)?'数据已保存，正在重新统计':stage==='inventory-index'&&repair?.state==='failed'?'数据已保存，条数暂未更新':stages[stage]||'部分本地后续处理失败';add('local:'+stage,text,String(failure.message||'').slice(0,600)+(failure.critical?'':'；已保存正文不受影响'),'请查看运行详情；无需为此重新获取已保存正文。',60);}
  if(finished.coreFailed)add('core','必要后续处理未完成','原始响应与恢复证据继续保留，不能将整个任务视为成功。','请查看运行详情中的保存或费用状态。',1);
  if((summary.incomplete||finished.partial||finished.code!=null&&finished.code!==0)&&!issues.length)add('unknown','结果尚未确认完整','旧结果没有足够的结构化原因，不能确定还缺哪些内容。','请查看运行详情。',90);
  issues.sort((a,b)=>a.priority-b.priority);
  const next=resumable?(targetCovered&&pendingNew?'可选择“补齐中间数据”。':'可从已保存的位置继续读取。'):pendingNew?'待补区间已保留，请在运行详情核实可恢复位置。':issues[0]?.next||'';
  if(!saved)return {saved:false,complete:false,resumable:false,pendingNew,issues,title:'本次获取的保存结果尚未确认',detail:'未取得可靠的保存确认，请查看运行详情；不要据此重复获取或清除进度。'};
  const sourceFailed=sources.some(s=>s.failed||s.cancelled||s.dataStatus?.failed);
  const canComplete=!sourceFailed&&!(finished.code!=null&&finished.code!==0)&&!finished.coreFailed&&!summary.cancelled&&!finished.cancelled;
  const missingOnly=canComplete&&issues.length>0&&issues.every(i=>i.missingBodyCount)&&coveredWithMissingBodies(sources,summary.mode);
  const coveredGap=canComplete&&targetCovered&&pendingNew&&resumable&&!sources.some(uncertain)&&issues.every(i=>i.code==='new'||i.missingBodyCount);
  const goalComplete=missingOnly||coveredGap||canComplete&&
    !issues.some(i=>i.code==='boundary'||i.code==='date'||i.code.startsWith('unchecked:')||i.code.startsWith('unknown-missing:')||i.code==='replies'||i.code.startsWith('missing:'))&&
    (targetCovered||sources.length>0&&sources.every(s=>s.update?.caughtUp===true&&!s.coverageUnverified));
  const complete=!issues.length;
  const middleGap=goalComplete&&pendingNew&&resumable&&issues[0]?.code==='new';
  const completeDetail=sources.some(s=>s.readProgress?.terminalProof?.reason==='explicit-empty-comment-list')?'已到空页，本轮网页可见评论已读完；微博显示的总数不代表全部可读取。':sources.some(s=>s.readProgress?.historyPending)?'已达到本次指定条数。可导出已有数据，或继续获取较早的评论。':'本次目标已完成；可导出已有数据。';
  return {saved:true,complete,goalComplete,middleGap,resumable,pendingNew,targetCovered,issues,title:middleGap?'读取完成 · 待补区间':complete||goalComplete&&!pendingNew?`读取完成 · 已保存${n}${Number.isSafeInteger(summary.addedRecords)?' · 新保存 '+summary.addedRecords+' 条':''}`:`已保存${n}，${issues[0].text}`,detail:complete?completeDetail+(Number.isSafeInteger(summary.reusedRecords)?'本地复用 '+summary.reusedRecords+' 条。':''):[...issues.filter(i=>!middleGap||!i.missingBodyCount).map(i=>i.detail),next].filter(Boolean).join(' ')};
 }
 function isMiddleGap(task){
  const p=task.progressStatus||task;
  return !['failed','interrupted','running'].includes(task.status)&&
   (p.targetCovered===true||Number.isSafeInteger(task.query?._gapBudget))&&p.directions?.some(d=>d.pendingNew)===true&&
   !(task.summary?.sources||[]).some(s=>s.failed||s.cancelled||s.dataStatus?.failed||uncertain(s));
 }
 const interruptedTask=task=>task?.status==='interrupted'&&!task.finishedAt&&!task.summary?.cancelled&&!task.summary?.sources?.length;
 const continuationLabel=task=>interruptedTask(task)?'继续原任务':isMiddleGap(task)?'补齐中间数据':'补齐区间';
 function hasContinuation(source){
  const {dataStatus,readProgress,update}=source;
  const pending=dataStatus?dataStatus.pendingNew||!dataStatus.targetCovered&&readProgress?.pending:readProgress?.pending;
  return !!(pending||update?.pending&&!update.caughtUp);
 }
 return {describe,hasContinuation,isMiddleGap,interruptedTask,continuationLabel,noticeSummary,subscriptionEmptyNote};
});
