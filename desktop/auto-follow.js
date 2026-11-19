'use strict';
const {clean}=require('../lib/diagnostic-text');
const {subscriptionEmptyNote}=require('./ui/acquisition-feedback');
const {conciseError}=require('../lib/terminal-report');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const store=require('../lib/auto-follow-budget'),{storagePaths,indexRead,mappedFolder}=require('../lib/storage');
const identity=require('../lib/subscription-key'),frequency=require('./follow-frequency'),recovery=require('./subscription-recovery'),missing=require('./subscription-missing');
const entryKinds=e=>e.mode==='both'?['sent','received']:[e.mode];
function validDeadline(value){return Number.isFinite(value)&&value>0&&value<=8.64e15?value:0;}
function ordinaryCount(value){return Number.isSafeInteger(value)&&value>0?Math.min(value,32):0;}
const normalCliStops=new Set(['AUTO_ROUND_LIMIT','AUTO_YIELD','REQUEST_LIMIT','RETURN_LIMIT','LATEST_WINDOW_LIMIT']);
function emptyObservation(source,requests){
 return source?.update?.noNewBodies===true&&source.update.checkpointCommitted===true&&
  !source.failed&&!source.dataStatus?.failed&&!source.cancelled&&(!source.stopCode||source.stopCode==='LATEST_WINDOW_LIMIT')&&
  source.newIndependentCount===0&&source.savedIndependentCount===0&&requests.length>0&&requests.every(q=>recovery.complete(q));
}
function retryDue(e,kind,at){const next=Date.parse(e.directionRetry?.[kind]?.nextRetryAt);return !Number.isFinite(next)||next<=at;}
function nextDirections(e,at){const values=entryKinds(e).map(kind=>Date.parse(e.directionRetry?.[kind]?.nextRetryAt)).filter(Number.isFinite);return values.length?Math.max(at+500,Math.min(...values)):at+1000;}
function replanNormal(e,at,period){for(const [kind,slot]of Object.entries(e.directionRetry||{})){if(!entryKinds(e).includes(kind)||slot?.attempts!==0||slot.code||!Number.isFinite(Date.parse(slot.lastAttemptAt)))continue;slot.nextRetryAt=new Date(Math.max(at,Date.parse(slot.lastAttemptAt)+period)).toISOString();}}
// UI state only locates the latest named receipt per direction. The original
// journals and the recovery module retain and validate the complete set.
function serviceProjection(values){const latest=new Map();for(const value of values||[])if(['sent','received','post-comments'].includes(value.kind)&&value.code==='IP_GEO_DENIED'){const old=latest.get(value.kind);if(!old||Date.parse(value.savedAt||0)>=Date.parse(old.savedAt||0))latest.set(value.kind,{kind:value.kind,code:value.code,roundId:value.roundId,requestId:value.requestId,receipt:value.receipt,savedAt:value.savedAt});}return [...latest.values()];}
const modeNames={sent:'comments-sent',received:'comments-received',both:'comments-both'};
function directionMessage(e){

 const kinds=e.mode==='both'?['sent','received']:[e.mode],blocked=kinds.filter(k=>e.blockedKinds?.includes(k)),retained=kinds.filter(k=>e.unknownKinds?.includes(k)&&!blocked.includes(k)),retrying=kinds.filter(k=>!blocked.includes(k)&&!e.checkedKinds?.includes(k)&&!(e.status==='running'&&e.checkingKinds?.includes(k))&&e.directionRetry?.[k]?.attempts>0),names={sent:'发出评论',received:'收到评论','post-comments':'博文评论'};
 const deferred=e.status==='running'?kinds.filter(k=>!e.checkingKinds?.includes(k)&&!blocked.includes(k)&&!retrying.includes(k)):[];if(!blocked.length&&!retained.length&&!retrying.length&&!deferred.length)return '';
 const checked=kinds.filter(k=>!blocked.includes(k)&&e.checkedKinds?.includes(k)),checking=e.status==='running'?kinds.filter(k=>(e.checkingKinds||kinds).includes(k)&&!blocked.includes(k)):[];
 const finalizing=blocked.filter(k=>e.directionRetry?.[k]?.code==='AUTO_FINALIZATION'),service=blocked.filter(k=>!finalizing.includes(k)&&e.serviceBlocks?.some(v=>v.kind===k&&v.code==='IP_GEO_DENIED')),unknown=blocked.filter(k=>!finalizing.includes(k)&&(e.unknownKinds?.includes(k)||!service.includes(k)));
 const local=retrying.filter(k=>!e.requestedKinds?.includes(k)&&['AUTO_OUTCOME_UNKNOWN','REQUEST_EVIDENCE_INVALID','LOCAL_SOURCE_INVALID'].includes(e.directionRetry[k].code)),retry=retrying.filter(k=>!local.includes(k));
 return (checked.length?'本轮已检查'+checked.map(k=>names[k]).join('、'):checking.length?'正在检查'+checking.map(k=>names[k]).join('、'):'本轮未完成检查')+'；'+[...(finalizing.length?[finalizing.map(k=>names[k]).join('、')+'未请求：等待本地恢复操作保存，其他方向可继续。']:[]),...(unknown.length?[unknown.map(k=>names[k]).join('、')+'未请求：旧请求结果未确认，需先核对原请求；原请求不重发，按恢复间隔继续核对。']:[]),...service.map(k=>names[k]+(e.serviceBlocks.some(v=>v.kind===k&&v.roundId===e.lastRoundId)&&e.requestedKinds?.includes(k)?'请求被服务拒绝':'未请求：此前服务拒绝')+'（IP_GEO_DENIED，地区条件未满足）；保留订阅并按恢复间隔重新核查，费用仍待核对。'),...(retained.length?[retained.map(k=>names[k]).join('、')+'的旧未确认结果与费用保留，旧区间仍未知。']:[]),...(local.length?[local.map(k=>names[k]).join('、')+'未请求：等待核对本地请求证据，按独立恢复间隔继续。']:[]),...(retry.length?[retry.map(k=>names[k]).join('、')+'按独立恢复间隔等待，不延后其他方向。']:[]),...(deferred.length?[deferred.map(k=>names[k]).join('、')+'尚未到检查时间。']:[])].join(' ');
}
function nextDay(now,zone){const day=store.localDay(now,zone);let a=now,b=now+27*3600000;while(b-a>1000){const m=Math.floor((a+b)/2);if(store.localDay(m,zone)===day)a=m;else b=m;}return b+1000;}
function validate(input){
 const targetKind=identity.kind(input),uid=String(targetKind==='post'?(input.postId||input.uid||''):input.uid||'');if(!/^\d{5,20}$/.test(uid)||(targetKind==='post'?input.mode!=='post-comments':!Object.hasOwn(modeNames,input.mode)))throw Error('请选择有效用户或博文，以及支持的订阅内容');
 if(input.source&&input.source!=='cli')throw Error('订阅数据来源无效');
 const interval=Number(input.interval),roundLimit=Number(input.roundLimit),dailyBudget=Number(input.dailyBudget);
 if(!Number.isSafeInteger(interval)||interval<1||interval>1440)throw Error('检查间隔请填写 1–1440 分钟');
 if(!Number.isSafeInteger(roundLimit)||roundLimit<(input.mode==='both'?2:1))throw Error('单轮取数上限必须为正整数，双向至少为 2');
 if(!Number.isFinite(dailyBudget)||dailyBudget<=0||dailyBudget>Number.MAX_SAFE_INTEGER)throw Error('每日 credit 预算必须为有效正数');
 return {uid,targetKind,...(targetKind==='post'?{source:'cli',postId:uid}:{}),subscriptionKey:identity.key({targetKind,uid}),mode:input.mode,interval,roundLimit:Math.min(roundLimit,store.MAX_CLI_ROUND_RETURNS),dailyBudget,...(targetKind==='user'?{accelerationTrigger:['sent','received','any'].includes(input.accelerationTrigger)?input.accelerationTrigger:'sent'}:{}),frequency:input.frequency==='adaptive'?'adaptive':'fixed',enabled:input.enabled===true};
}
function createAutoFollow(base,{now=Date.now,isBusy=()=>false,launch=()=>{},publish=()=>{},setTimer=setInterval,clearTimer=clearInterval,random=Math.random,recoverLocal=()=>{},canDispatch=()=>true,blockedDirections=()=>[]}={}){
 const file=path.join(store.directory(base),'settings.json'),lock=path.join(store.directory(base),'session.lock');
 const normalizeEntry=e=>{const value=({...e,...validate({...e,frequency:e.frequency||'adaptive'}),...(e.status==='billing-paused'?{status:e.enabled?'retry-wait':'paused',reason:e.enabled?'原费用记录保留，等待安全核对后自动继续':'订阅已暂停，可直接开启',nextCheckAt:e.enabled?new Date(now()+30000).toISOString():null}:{})});if(!value.missingBodyState)missing.observe(value,value.directions,true);return frequency.normalize(value,now());};
 let entries=[], archivedEntries=[], active=null,closed=false,owns=false,sessionLease=null,timer=null,recovered=false,startupReady=false,startupError=null,localCheckAfter=0,dispatchAfter=0,localHold=null,tickEntry=null;
 function loadSettings(){const saved=store.read(file,{schema:1,entries:[]});if(saved.schema!==1||!Array.isArray(saved.entries))throw Error('订阅设置损坏，未运行任何自动任务');archivedEntries=saved.entries.filter(entry=>entry.source&&entry.source!=='cli');
  return {...saved,entries:saved.entries.filter(entry=>!entry.source||entry.source==='cli')};
 }
 const persist=()=>store.atomic(file,{schema:1,entries:[...entries,...archivedEntries]});
 function acquire(){
  if(owns&&sessionLease?.owned())return true;
  owns=false;
  try{sessionLease=require('../lib/process-lease').acquire(lock,'另一应用实例正在订阅');}
  catch(error){if(error.code==='DATA_LOCK_BUSY')return false;throw error;}
  try{const latest=loadSettings();entries=latest.entries.map(normalizeEntry);owns=true;if(JSON.stringify(entries)!==JSON.stringify(latest.entries))persist();return true;}
  catch(error){release();throw error;}
 }
 function dataDir(e){const p=storagePaths(base);return identity.kind(e)==='post'?require('../lib/storage').findPostFolder(p.postComments,e.postId||e.uid):mappedFolder(p.users,e.uid,indexRead(p.users));}
 function inbox(e){try{if(identity.kind(e)==='post'){const id=e.postId||e.uid;return {...require('../lib/post-reading-state').unreadSummary(base,id),lastComment:require('../lib/post-subscription').latest(base,id)};}return require('../lib/follow-inbox').summary(base,e.uid,e.lastNewBatchId);}catch(error){return {unread:null,lastSent:null,lastReceived:null,unavailable:true,warning:'本地未读统计暂不可用，已保存的数据保留：'+String(error.message).slice(0,200)};}}
 function dataStates(e){return (e.directions||[]).map(source=>{const result={kind:source.kind,...require('../lib/collection-result').collectionResult(source)};if(identity.kind(e)!=='user'||!['sent','received'].includes(source.kind))return result;try{const file=require('../lib/incremental').stateFile(dataDir(e),source.kind),current=require('../lib/file-view-cache').readJSON(file);if(current.uid===e.uid&&current.kind===source.kind&&current.endPolicyVersion===2)return {...result,pendingNew:!!current.pending||source.update?.protection?.pendingWindows>0,deltaConnected:!current.pending&&!(source.update?.protection?.pendingWindows>0)};}catch{}return result;});}
 function snapshot(){if(startupError)throw startupError;const at=now(),ledger=store.ledger(base);return {timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,active:active?.uid??null,entries:entries.map(e=>{const {missingBodyState,...display}=e;return {...display,missingNotice:missing.snapshot(e),dataStates:dataStates(e),inbox:inbox(e),billingNotice:ledger.notice(e.uid,identity.kind(e)),today:ledger.usage(e.uid,store.localDay(at,e.timeZone),identity.kind(e)),running:!!active&&identity.matches(active,e)};})};}
 const emit=()=>publish('followState',snapshot());
 function recover(){let changed=false;for(const r of store.runningRounds(base).filter(round=>!round.source||round.source==='cli')){
  let unknown=false;for(const q of r.requests||[])if(q.status==='reserved'){q.status='unknown';q.reason='上次应用退出时响应未完成，扣费待核对';unknown=true;}
  r.status='interrupted';r.finishedAt=new Date(now()).toISOString();r.reason=unknown?'应用退出，最后请求费用待核对':'应用退出，已保存续取位置';store.atomic(store.roundFile(base,r.id),r);
  const e=entries.find(e=>identity.matches(e,r));if(e){e.status=unknown?'error-paused':e.enabled?'waiting':'paused';e.reason=unknown?'上次更新被中断，续取位置已保存，可直接开启订阅':r.reason;e.pending=true;if(e.enabled)recovery.waiting(e,r,now(),{code:unknown?'AUTO_OUTCOME_UNKNOWN':'AUTO_INTERRUPTED',local:unknown,random});else e.nextCheckAt=null;changed=true;}
  writeFallback(r);
 }for(const e of entries)if(e.status==='running'){e.pending=true;if(e.enabled)recovery.waiting(e,{id:e.lastRoundId||''},now(),{code:'AUTO_STATE_RECOVERY',local:true,random});else{e.status='paused';e.nextCheckAt=null;}changed=true;}if(changed)persist();}
 function writeFallback(r){try{const dir=dataDir(r);if(require('../lib/database-sync').history(dir).some(e=>e.autoRoundId===r.id))return;const requests=r.requests||[],unknown=requests.filter(q=>q.status==='unknown'||q.status==='reserved').length,b=r.billing||{};require('../lib/database-sync').writeHistory(dir,{schema:1,id:r.id,target:r.uid,uid:identity.kind(r)==='post'?'':r.uid,mode:r.mode,category:identity.kind(r)==='post'?'post-comments':'user-comments',operation:'automatic',autoRoundId:r.id,startedAt:r.startedAt,finishedAt:r.finishedAt||new Date(now()).toISOString(),status:r.interruptionCode==='AUTO_YIELD'?'partial':['interrupted','cancelled'].includes(r.status)?'cancelled':'failed',apiCalls:requests.length,newReturned:requests.reduce((n,q)=>n+(q.returned||0),0),addedRecords:null,billing:{actualCredits:null,estimatedCredits:requests.reduce((n,q)=>n+(q.estimatedCredits||0),0),balanceBefore:b.initialBalance??null,balanceAfter:b.finalBalance??null,balanceDecrease:b.initialBalance!=null&&b.finalBalance!=null?b.initialBalance-b.finalBalance:null,unknownRequests:unknown,status:unknown?'unverified':requests.length?'estimated-only':'no-content-requests'},reason:r.reason||'自动检查未完成，已有数据保留'});}catch(error){return {error};}}
 function save(input,intent=null,retryGrant){if(intent&&!['save','enable'].includes(intent))throw Error('订阅设置操作无效');const validated=validate(input);if(!acquire())throw Error('另一应用实例正在订阅，请在该窗口修改，或关闭该实例后再操作');if(archivedEntries.some(e=>identity.matches(e,validated)))throw Error('该对象有另一数据来源的订阅，请在新的资料目录设置。原订阅已保留');const old=entries.find(e=>identity.matches(e,validated)),enabled=intent==='save'?!!old?.enabled:validated.enabled;
  if(active&&identity.matches(active,validated)&&(intent!=='save'||(old?.source||'cli')!==(validated.source||'cli')))throw Error('本次检查仍在保存，请等待完成再开启');const config={...validated,enabled},changed=!old||frequency.settingsKey(old)!==frequency.settingsKey(config);
  const e={...old,...config,intentVersion:1,createdAt:old?.createdAt||new Date(now()).toISOString(),timeZone:old?.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone};
  if(arguments.length>=3){if(retryGrant)e.serviceRetry=retryGrant;else delete e.serviceRetry;}
  if(old&&((old.source||'cli')!==(e.source||'cli')||old.mode!==e.mode)){delete e.serviceRetry;delete e.directionRetry;delete e.noNewKinds;}
  if(intent==='enable'&&e.directionRetry)for(const slot of Object.values(e.directionRetry))slot.nextRetryAt=new Date(Math.max(now()+1000,validDeadline(slot.notBefore))).toISOString();

  if(intent==='save'&&old){e.status=old.status;e.reason=old.reason;e.nextCheckAt=old.nextCheckAt;if((old.source||'cli')!==(e.source||'cli')){delete e.recovery;e.pauseCode=null;e.status=enabled?'waiting':'paused';e.reason=enabled?'已保存新的来源设置，等待安全检查':'由用户暂停';e.nextCheckAt=enabled?new Date(now()+1000).toISOString():null;}}else{delete e.recovery;e.status=enabled?'waiting':'paused';e.reason=enabled?'等待检查':'由用户暂停';e.nextCheckAt=enabled?new Date(now()+1000).toISOString():null;}

  if(changed){e.lastActiveAt=null;e.quietChecks=0;e.effectiveInterval=null;if(e.frequency==='adaptive')frequency.interval(e,null,now());}delete e.profile;const displayedKinds=e.mode==='both'?['sent','received']:[e.mode];e.blockedKinds=(e.blockedKinds||[]).filter(kind=>displayedKinds.includes(kind));e.checkedKinds=(e.checkedKinds||[]).filter(kind=>displayedKinds.includes(kind));e.unknownKinds=(e.unknownKinds||[]).filter(kind=>displayedKinds.includes(kind));e.serviceBlocks=((e.serviceBlocks||[]).filter(value=>displayedKinds.includes(value.kind)));e.directionMessage=directionMessage(e);entries=[e,...entries.filter(v=>!identity.matches(v,e))];persist();emit();return e;
 }
 function resume(uid){if(!acquire())throw Error('另一应用实例正在订阅，请在该窗口恢复');const e=entries.find(e=>identity.matches(e,uid));if(!e)throw Error('请先保存订阅设置');return save({...e,enabled:true},'enable');}
 function resetBudget(key){
  if(!acquire())throw Error('另一应用实例正在订阅，请在该窗口重置额度');
  const e=entries.find(e=>identity.matches(e,key));
  if(!e||e.removing)throw Error('该对象没有可重置的微博 CLI 订阅额度');
  const at=now(),kind=identity.kind(e),today=store.resetToday(base,e.uid,store.localDay(at,e.timeZone),kind,at);
  if(e.enabled&&e.status==='budget-paused'&&today.committed<e.dailyBudget){
   e.status='waiting';e.reason='当前额度已重置，等待下次检查';
   if(e.pauseCode==='AUTO_DAILY_BUDGET')e.pauseCode=null;
   e.nextCheckAt=new Date(Math.max(at+1000,validDeadline(e.restUntil))).toISOString();
   persist();
  }
  emit();return {uid:e.uid,targetKind:kind,today};
 }
 function dismissMissing(key,notice){
  if(!acquire())throw Error('另一应用实例正在订阅，请在该窗口关闭提示');
  const e=entries.find(e=>identity.matches(e,key));if(!e)throw Error('订阅已变化，请刷新后重试');
  const old=e.missingBodyState;e.missingBodyState=missing.dismiss(e,notice);
  try{persist();}catch(error){e.missingBodyState=old;throw error;}
  emit();return {uid:e.uid,targetKind:identity.kind(e),missingNotice:missing.snapshot(e)};
 }
 function remove(uid){if(!acquire())throw Error('另一应用实例正在订阅，无法移除订阅');if(active&&identity.matches(active,uid))throw Error('请先停止该用户的检查，待响应保存后删除');entries=entries.filter(e=>!identity.matches(e,uid));persist();emit();}
 // Unsubscribe preserves all raw data, checkpoints, inbox and the spending ledger.
 function unsubscribe(uid){if(!acquire())throw Error('另一应用实例正在订阅，请在该窗口移除');const e=entries.find(e=>identity.matches(e,uid));if(!e)return {pending:false};e.enabled=false;e.status='paused';e.nextCheckAt=null;e.removing=true;e.reason='正在保存当前请求，随后移除订阅';persist();if(active&&identity.matches(active,e)){interrupt('已取消订阅，保存当前响应后停止');emit();return {pending:true};}remove(uid);return {pending:false};}
 function pause(uid){if(!acquire())throw Error('另一应用实例正在订阅，请在该窗口暂停，或关闭该实例后再操作');const e=entries.find(e=>identity.matches(e,uid));if(!e)throw Error('该对象尚未设置订阅');e.enabled=false;e.status='paused';e.reason='由用户暂停';e.nextCheckAt=null;persist();if(active&&identity.matches(active,uid))interrupt('由用户暂停，保存当前响应后停止');emit();}
 function interrupt(reason,{code='USER_CANCELLED'}={}){if(active)store.atomic(store.roundFile(base,active.id)+'.stop',{schema:1,roundId:active.id,uid:active.uid,targetKind:identity.kind(active),source:active.source||'cli',code,reason});}
 function workerRound(id){const r=store.read(store.roundFile(base,id));if(!active||active.id!==id||!r||r.schema!==1||r.id!==id||!identity.matches(r,active)||(r.source||'cli')!=='cli'||r.status!=='running')throw store.safety('AUTO_WORKER_BINDING','自动任务进程与原订阅账本不匹配，未开始内容请求');return r;}
 function prepareWorker(id){const r=workerRound(id);if(r.worker)throw store.safety('AUTO_WORKER_BINDING','原自动任务已有进程绑定，未重复启动');r.requireWorkerBinding=true;store.atomic(store.roundFile(base,id),r);}
 function bindWorker(id,value){const r=workerRound(id);if(!r.requireWorkerBinding||r.worker||value?.schema!==1||!Number.isSafeInteger(value.pid)||value.pid<1||value.pgid!==value.pid||typeof value.birth!=='string'||!value.birth||!Number.isFinite(Date.parse(value.startedAt))||require('../lib/process-lease').processBirth(value.pid)!==value.birth)throw store.safety('AUTO_WORKER_BINDING','自动任务进程身份无法核实，未继续内容请求');r.worker={schema:1,pid:value.pid,pgid:value.pgid,birth:value.birth,startedAt:value.startedAt};store.atomic(store.roundFile(base,id),r);return r.worker;}
 function workerClosed(id,binding,closedAt=new Date(now()).toISOString()){const r=workerRound(id),w=r.worker;if(!w||!binding||w.pid!==binding.pid||w.pgid!==binding.pgid||w.birth!==binding.birth||w.startedAt!==binding.startedAt||!Number.isFinite(Date.parse(closedAt)))throw store.safety('AUTO_WORKER_BINDING','已结束进程不属于原自动任务，未修改证据');r.worker={...w,closedAt};store.atomic(store.roundFile(base,id),r);}
 function tickWork(){tickEntry=null;if(closed||isBusy()||now()<dispatchAfter)return;
  if(!startupReady&&!recoverStartup())return;
  if(localHold){const held=localHold;if(holdFinalization(held.id,held.reason,held.subject).coreFailed)return;}
  if(active)return;const at=now(),due=e=>e.enabled&&Date.parse(e.nextCheckAt)<=at&&validDeadline(e.restUntil)<=at;let e=entries.filter(due).sort((a,b)=>Date.parse(a.nextCheckAt)-Date.parse(b.nextCheckAt))[0];if(!e)return;
  if(!acquire()){e.status='queued';e.reason='另一应用实例正在订阅，等待释放会话';e.nextCheckAt=new Date(at+60000).toISOString();emit();return;}
  if(!recovered){recover();recovered=true;}
  e=entries.find(v=>identity.matches(v,e));if(!e||!due(e))return;tickEntry=e;
  if(at>=localCheckAfter){localCheckAfter=at+60000;recoverLocal();}
  if(!canDispatch(e)){recovery.waiting(e,{id:e.recovery?.roundId||e.lastRoundId||'',source:e.source},at,{code:'AUTO_FINALIZATION',local:true,random});persist();emit();return;}
  const allKinds=entryKinds(e),localBlocked=blockedDirections(e);
  let checked;try{checked=allKinds.every(kind=>localBlocked.includes(kind))?{blockedKinds:[],unknownKinds:[]}:recovery.inspect(base,e,dataDir(e),{excludeKinds:localBlocked});}catch(error){if(error.code!=='DATA_LOCK_BUSY')throw error;recovery.waiting(e,{id:e.lastRoundId||'',source:e.source},at,{code:'DATA_LOCK_BUSY',local:true,random});e.status='queued';e.reason='原对象正在保存，稍后自动核对；其他订阅继续';persist();emit();return;}
  const blockedKinds=[...new Set([...checked.blockedKinds,...localBlocked])];
  e.blockedKinds=allKinds.filter(kind=>blockedKinds.includes('*')||blockedKinds.includes(kind));e.checkedKinds=[];e.noNewKinds=[];e.checkingKinds=[];e.requestedKinds=[];e.serviceBlocks=serviceProjection(checked.serviceBlocks);e.unknownKinds=checked.unknownKinds||e.blockedKinds.filter(kind=>!e.serviceBlocks.some(value=>value.kind===kind));
  const dueKinds=allKinds.filter(kind=>retryDue(e,kind,at)),chosenKinds=dueKinds.filter(kind=>!e.blockedKinds.includes(kind));
  {e.directionRetry??={};for(const kind of dueKinds.filter(kind=>e.blockedKinds.includes(kind))){const old=e.directionRetry[kind],attempts=Math.min(32,(old?.attempts||0)+1);e.directionRetry[kind]={...(ordinaryCount(old?.ordinaryAttempts)?{ordinaryAttempts:old.ordinaryAttempts}:{}),attempts,nextRetryAt:new Date(at+recovery.retryDelay(attempts)).toISOString(),lastAttemptAt:new Date(at).toISOString(),code:localBlocked.includes(kind)?'AUTO_FINALIZATION':e.serviceBlocks.some(value=>value.kind===kind)?'IP_GEO_DENIED':'AUTO_OUTCOME_UNKNOWN',lastRoundId:old?.lastRoundId||e.lastRoundId||''};}}
  if(!chosenKinds.length){if(e.blockedKinds.length){recovery.waiting(e,{id:e.recovery?.roundId||e.lastRoundId||'',source:e.source},at,{code:localBlocked.length?'AUTO_FINALIZATION':'AUTO_OUTCOME_UNKNOWN',local:true,random});}else{e.status='waiting';e.reason='按各方向的检查间隔等待';}e.nextCheckAt=new Date(nextDirections(e,at)).toISOString();e.directionMessage=directionMessage(e);if(e.directionMessage)e.reason=e.directionMessage;persist();emit();return;}
  if(e.recovery?.localOnly&&e.recovery.roundId){const r=store.read(store.roundFile(base,e.recovery.roundId));if(r?.status==='running'){const result=recoverSettlement(r.id,{summary:r.summary});if(result.coreFailed){recovery.waiting(e,r,at,{code:'AUTO_SETTLEMENT',local:true,random});persist();emit();return;}}}
  const used=store.usage(base,e.uid,store.localDay(at,e.timeZone),undefined,identity.kind(e));if(used.committed>=e.dailyBudget-1e-9){e.status='budget-paused';e.reason='订阅预算已用尽，额度重置后继续；待补区间保留';e.nextCheckAt=new Date(nextDay(at,e.timeZone)).toISOString();persist();emit();return;}
  const id=crypto.randomUUID(),round={schema:1,id,uid:e.uid,...(e.serviceRetry?{serviceRetry:e.serviceRetry}:{}),targetKind:identity.kind(e),subscriptionKey:identity.key(e),...(identity.kind(e)==='post'?{postId:e.uid}:{}),mode:e.mode,frequencySettingsKey:frequency.settingsKey(e),kinds:chosenKinds,deferredKinds:allKinds.filter(kind=>!dueKinds.includes(kind)),blockedKinds,unknownKinds:e.unknownKinds,serviceBlocks:e.serviceBlocks,unresolvedRanges:checked.unresolvedRanges||[],roundLimit:e.roundLimit,dailyBudget:e.dailyBudget,timeZone:e.timeZone,startedAt:new Date(at).toISOString(),requests:[],status:'running'};
  if(recovery.automaticRecovery)round.automaticRecovery=recovery.automaticRecovery(base,e,dataDir(e),checked,chosenKinds,{now:()=>at});store.atomic(store.roundFile(base,id),round);active=round;e.status='running';e.pauseCode=null;delete e.restUntil;e.reason='正在检查新记录';e.checkingKinds=chosenKinds;e.directionMessage=directionMessage(e);e.nextCheckAt=null;
  try{
   persist();const state=snapshot();
   // Transport notification is auxiliary. Durable setup/ledger failures still
   // stop dispatch; a failed UI refresh must not leave an unlaunched active job.
   try{publish('followState',state);}catch(error){try{publish('followError',{uid:e.uid,targetKind:identity.kind(e),roundId:id,stage:'publish-state',message:'订阅状态显示未能刷新：'+String(error.message).slice(0,300),coreFailed:false});}catch{}}
   launch(round);
  }catch(error){finish(id,{code:1,reason:error.message,failureCode:error.code||'AUTO_START_FAILED'});}
 }
 function finish(id,{summary=null,code=0,cancelled=false,reason='',yielded=false,failureCode='',failureRetryAt=0}={}){
  if(active?.id!==id)return {ignored:true,coreFailed:false,warnings:[]};const original=active,warnings=[];let r=null,e=entries.find(e=>identity.matches(e,original)),ledgerSaved=false,settingsSaved=false,frequencyDecision=null;
  const warning=(stage,error)=>{warnings.push({stage,message:String(error?.message||error).slice(0,400)});};
  const effect=(stage,run)=>{try{return run();}catch(error){warning(stage,error);return null;}};
  try{
   r=store.read(store.roundFile(base,id));if(!r||r.id!==id||!identity.matches(r,original))throw Error('自动任务账本与当前任务不匹配');const at=now();
  for(const q of r.requests)if(q.status==='reserved'){q.status='unknown';q.reason='请求未取得完整计费结果';}
  r.finishedAt=new Date(at).toISOString();if(failureCode)r.safetyCode=r.safetyCode||failureCode;r.billing=summary?.billing||null;r.summary=summary;r.reason=clean(conciseError(reason||r.reason||summary?.autoStop?.message||''));
  const unknown=r.requests.some(q=>q.status==='unknown')||summary?.billing?.unknownRequests;
  const b=r.billing,estimate=r.requests.reduce((n,q)=>n+(q.estimatedCredits||0),0),difference=b?.initialBalance!=null&&b?.finalBalance!=null?b.initialBalance-b.finalBalance:null;
  const mismatch=difference!=null&&Math.abs(difference-estimate)>1e-6;
  r.billingUnverified=!!unknown||mismatch;r.status=cancelled?'cancelled':code?'failed':summary?.incomplete?'partial':'complete';
  let safetyCode=r.safetyCode||summary?.autoStop?.code||failureCode||'';
  const control=store.read(store.roundFile(base,id)+'.stop',null),validYield=control?.schema===1&&control.code==='AUTO_YIELD'&&control.roundId===id&&identity.matches(control,r)&&(control.source||'cli')===(r.source||'cli');
  const manualYield=!unknown&&!code&&(yielded||validYield)&&['','AUTO_YIELD','USER_CANCELLED'].includes(safetyCode);
  if(control?.code==='AUTO_YIELD'&&!validYield&&!yielded&&safetyCode==='AUTO_YIELD')safetyCode='AUTO_STOP_UNVERIFIED';
  const retryAfter=Math.max(validDeadline(summary?.autoStop?.retryAt),validDeadline(failureRetryAt));
  const expectedStop=!unknown&&!code&&(manualYield||(closed||!e?.enabled)&&['AUTO_YIELD','USER_CANCELLED'].includes(safetyCode));
  if(safetyCode)r.safetyCode=safetyCode;
  if(manualYield){safetyCode='AUTO_YIELD';r.interruptionCode='AUTO_YIELD';r.status='partial';}
  if(e){
   e.pauseCode=expectedStop&&!manualYield?null:(safetyCode||null);delete e.restUntil;e.lastCheckAt=r.finishedAt;e.lastAdded=summary?.addedRecords??0;e.lastReturned=summary?.newRecords??r.requests.reduce((n,q)=>n+(q.returned||0),0);e.pending=!!summary?.incomplete||!!code||cancelled;

   e.directions=(summary?.sources||e.directions||[]).map(source=>({...source,reason:clean(conciseError(source.reason))}));e.lastBalanceDifference=difference;e.lastEstimate=estimate;e.lastRoundId=id;
   const priorCadence=e.effectiveInterval,plannedMinutes=e.enabled?frequency.interval(e,r.frequencySettingsKey===frequency.settingsKey(e)?summary:null,at,value=>frequencyDecision=value):(e.frequency==='adaptive'?e.effectiveInterval:e.interval);

   const serviceProof=require('../lib/subscription-service-proof'),freshService=[],restoredKinds=new Set();for(const q of r.requests){try{const rejected=serviceProof.rejection(base,dataDir(e),r,q);if(rejected)freshService.push(rejected);else if((r.serviceBlocks||[]).some(value=>value.kind===q.kind)&&serviceProof.normalResponse(dataDir(e),r,q))restoredKinds.add(q.kind);}catch(error){warning('service-rejection-projection',error);}}
   e.serviceBlocks=serviceProjection([...(r.serviceBlocks||[]).filter(value=>!restoredKinds.has(value.kind)),...freshService]);e.blockedKinds=[...new Set([...(r.blockedKinds||[]),...freshService.map(value=>value.kind)])].filter(kind=>['sent','received','post-comments'].includes(kind));e.unknownKinds=[...new Set([...(r.unknownKinds||[]),...r.requests.filter(q=>['reserved','unknown'].includes(q.status)&&!recovery.complete(q)&&!freshService.some(value=>value.requestId===q.id)).map(q=>q.kind)])].filter(kind=>['sent','received','post-comments'].includes(kind));delete e.checkingKinds;e.requestedKinds=[...new Set(r.requests.filter(q=>q.wireOutcome!=='not-sent').map(q=>q.kind))];e.checkedKinds=(summary?.sources||[]).filter(source=>!e.blockedKinds.includes(source.kind)&&(source.update?.protection?.latestSucceeded||!source.failed&&source.update?.caughtUp)).map(source=>source.kind);
   const saved=summary?.persistence?.coreSaved===true;
   if(saved)missing.observe(e,summary.sources);
   e.noNewKinds=saved&&!code&&!cancelled&&!safetyCode?(summary.sources||[]).filter(source=>!e.blockedKinds.includes(source.kind)&&emptyObservation(source,r.requests.filter(q=>q.kind===source.kind))).map(source=>source.kind):[];
   e.checkedKinds=[...new Set([...e.checkedKinds,...e.noNewKinds])];
   if(saved&&!cancelled){
    const successful=(summary.sources||[]).filter(s=>!s.failed&&!s.dataStatus?.failed&&!s.cancelled&&!s.stopCode&&!e.blockedKinds.includes(s.kind)&&!e.unknownKinds.includes(s.kind)&&
     (((s.update?.protection?.latestComplete===true||s.update?.caughtUp===true&&!s.coverageUnverified&&!s.dataStatus?.coverageUnverified)&&r.requests.some(q=>q.kind===s.kind&&recovery.complete(q)))));
    if(successful.length){e.successfulChecks??={};for(const source of successful)e.successfulChecks[source.kind]=r.finishedAt;}
   }
   if(saved&&summary.addedRecords>0&&summary.batchId){e.lastNewBatchId=summary.batchId;e.lastNewAt=r.finishedAt;e.lastNewCount=summary.addedRecords;}
   if(!e.enabled){e.status='paused';e.reason='由用户暂停';}
   else if(safetyCode==='AUTO_DAILY_BUDGET'){
    const usage=store.usage(base,e.uid,store.localDay(at,e.timeZone),undefined,identity.kind(e));
    if(Date.parse(usage.budgetResetAt)>=Date.parse(r.startedAt)&&usage.committed<e.dailyBudget&&retryAfter<=at){
     e.status='waiting';e.pauseCode=null;e.reason='当前额度已重置，等待下次检查';
    }else{
     if(retryAfter>at)e.restUntil=retryAfter;
     e.status='budget-paused';e.reason='本周期剩余额度不足，额度重置后继续；待补区间保留';e.nextCheckAt=new Date(Math.max(nextDay(at,e.timeZone),retryAfter)).toISOString();
    }
   }
   else if((summary?.sources?.some(s=>s.update?.protection?.latestSucceeded)||(['AUTO_BASELINE','AUTO_BODY_MISSING','AUTO_PRICE_UNKNOWN','AUTO_UNSUPPORTED'].includes(safetyCode)||r.blockedKinds?.length)&&summary?.sources?.some(s=>s.update?.caughtUp&&!s.failed))&&!unknown&&e.enabled){e.status='waiting';e.reason=directionMessage(e)||'最新可见评论已检查；未读区间已保留';delete e.recovery;}
   else if(!expectedStop&&((code||cancelled)&&(!closed||unknown)||safetyCode&& !['AUTO_ROUND_LIMIT','AUTO_YIELD'].includes(safetyCode))){recovery.waiting(e,r,at,{code:safetyCode||'AUTO_RETRY',local:!!unknown,random,notBefore:retryAfter});e.reason=(clean(reason||r.reason)||'本轮检查未完成')+'；订阅启用意图保留，安全条件恢复后自动继续';}
   else if(manualYield&&e.enabled){e.status='queued';e.reason='等待手动任务结束，随后自动继续订阅';}
   else {delete e.recovery;e.status='waiting';e.reason=(e.pending?'本轮未接回旧检查点，待补区间保留，下轮检查最新记录':'本轮检查完成');}
   if(e.enabled&&!expectedStop&&e.status!=='budget-paused'){
    const period=plannedMinutes*60000;e.directionRetry??={};
    for(const kind of r.kinds||[]){
     const prior=e.directionRetry[kind],source=summary?.sources?.find(source=>source.kind===kind),requests=r.requests.filter(q=>q.kind===kind);
     const unconfirmed=requests.some(q=>['unknown','reserved'].includes(q.status)&&!recovery.complete(q));
     const latestSucceeded=source?.update?.protection?.latestSucceeded===true;
     const succeeded=e.noNewKinds.includes(kind)||latestSucceeded||(!unconfirmed&&!source?.failed&&!source?.dataStatus?.failed&&!source?.cancelled&&source?.update?.caughtUp===true);
     const failed=!succeeded&&(unconfirmed||source?.failed||source?.dataStatus?.failed||
      (source?.stopCode&&!normalCliStops.has(source.stopCode))||(!source&&(code||safetyCode&&!normalCliStops.has(safetyCode))));
     const attempts=succeeded?0:Math.min(32,(prior?.attempts||0)+(failed?1:0));
     const serviceRejected=freshService.some(value=>value.kind===kind);
     const reported=source?.stopCode||safetyCode,directionCode=serviceRejected?'IP_GEO_DENIED':reported&&reported!=='IP_GEO_DENIED'?reported:'AUTO_RETRY';
     const failure=source?.dataStatus?.requestFailure;
     const transportFailure=directionCode==='AUTO_FAILED'&&unconfirmed&&failure?.apiAttempt===true&&failure.cached===false&&failure.responseReceived===false&&failure.responseSaved===false&&failure.billingUnknown===true;
     const ordinary=failed&&(serviceRejected||transportFailure||recovery.ordinaryFailure(directionCode)&&!(unconfirmed&&directionCode==='AUTO_RETRY'));
     const ordinaryAttempts=succeeded?0:Math.min(32,ordinaryCount(prior?.ordinaryAttempts)+(ordinary?1:0));
     const notBefore=failed?Math.max(validDeadline(source?.retryAt),retryAfter):0;
     const delay=failed?recovery.retryDelay(attempts):period;
     e.directionRetry[kind]={attempts,...(ordinaryAttempts?{ordinaryAttempts}:{}),...(notBefore>at?{notBefore}:{}),nextRetryAt:new Date(Math.max(at+delay,notBefore)).toISOString(),lastAttemptAt:r.finishedAt,code:failed?directionCode:succeeded?'':prior?.code||'',lastRoundId:r.id};
    }
    if(e.frequency==='adaptive'&&priorCadence!==e.effectiveInterval)replanNormal(e,at,period);
    const healthy=e.noNewKinds.length||(summary?.sources||[]).some(source=>source.update?.protection?.latestSucceeded||!source.failed&&!source.dataStatus?.failed&&source.update?.caughtUp);if(healthy){e.status='waiting';delete e.recovery;e.reason=e.noNewKinds.length&&e.lastAdded===0?subscriptionEmptyNote(e):'本轮已完成到期方向检查；其他方向按各自恢复间隔继续';}
   }
   e.directionMessage=directionMessage(e);if(e.status==='waiting'&&e.directionMessage)e.reason=e.directionMessage;
   if(!e.enabled)e.nextCheckAt=null;else if(manualYield)e.nextCheckAt=new Date(Math.max(at,validDeadline(e.restUntil))).toISOString();else if(!['budget-paused','retry-wait','attention-required'].includes(e.status))e.nextCheckAt=new Date(at+plannedMinutes*60000).toISOString();
  }
   if(e?.enabled&&e.status!=='budget-paused'&&!expectedStop)e.nextCheckAt=new Date(nextDirections(e,at)).toISOString();
   store.atomic(store.roundFile(base,id),r);ledgerSaved=true;
  }catch(error){warning('round-settlement',error);if(e){e.pending=true;if(e.enabled)recovery.waiting(e,original,now(),{code:'AUTO_SETTLEMENT',local:true,random});else{e.status='paused';e.nextCheckAt=null;}}}
  finally{active=null;}
  if(ledgerSaved)entries=entries.filter(v=>!(v.removing&&identity.matches(v,r)));
  try{persist();settingsSaved=true;}catch(error){warning('subscription-settings',error);if(e){e.pending=true;if(e.enabled)recovery.waiting(e,original,now(),{code:'AUTO_SETTINGS_SAVE',local:true,random});else{e.status='paused';e.nextCheckAt=null;}}}
  if(ledgerSaved){
   if(identity.kind(r)==='user'&&summary?.batchId)effect('inbox',()=>require('../lib/follow-inbox').ingest(base,r.uid,summary.batchId));
   if(r.billingUnverified&&summary)effect('billing-history',()=>{const dir=dataDir(r),db=require('../lib/database-sync'),entry=db.history(dir).find(e=>e.autoRoundId===r.id);if(entry){entry.billing.status='unverified';entry.billing.reconciliation=r.billing?.initialBalance!=null&&r.billing?.finalBalance!=null&&Math.abs(r.billing.initialBalance-r.billing.finalBalance-r.requests.reduce((n,q)=>n+(q.estimatedCredits||0),0))>1e-6?'balance-mismatch':'unknown-request';entry.reason+='；费用待核对（不影响后续订阅）';db.writeHistory(dir,entry);}});
   if(!summary)effect('update-history',()=>{const result=writeFallback(r);if(result?.error)throw result.error;});
   if(warnings.length)effect('side-effect-audit',()=>{r.sideEffects=warnings.map(w=>({...w}));store.atomic(store.roundFile(base,id),r);});
  }
  if(ledgerSaved&&settingsSaved&&e?.enabled&&frequencyDecision)effect('frequency-log',()=>publish('autoFrequency',{uid:e.uid,targetKind:identity.kind(e),source:e.source||'cli',roundId:id,frequency:{...frequencyDecision,nextCheckAt:e.nextCheckAt||null}}));
  effect('publish-state',emit);
  for(const item of [...warnings])effect('publish-warning',()=>publish('followError',{uid:original.uid,targetKind:identity.kind(original),roundId:id,stage:item.stage,message:item.message,dataSaved:!!summary,coreFailed:!ledgerSaved||!settingsSaved}));
  return {id,dataSaved:!!summary,coreFailed:!ledgerSaved||!settingsSaved,ledgerSaved,settingsSaved,warnings};
 }
 function holdFinalization(id,reason='必要结算尚未完成',subject=null){
  // A local save/ownership blocker is recoverable, unlike explicit application Quit.
  // Keep the scheduler timer alive, but retry only this local hold before dispatching.
  function wait(message,error){localHold={id,reason,subject};dispatchAfter=now()+60000;const warnings=error?[{stage:'hold-settings',message:error.message,critical:true}]:[];
   try{publish('followError',{roundId:id,stage:'automatic-local-recovery',code:'AUTO_FINALIZATION',message,coreFailed:true});}catch{}
   return {held:true,coreFailed:true,message,warnings};
  }
  try{if(!acquire())return wait('另一实例拥有订阅会话，等待释放后自动核对；未覆盖该实例状态');}catch(error){return wait('订阅本地状态暂不可读，一分钟后自动核对；原始证据保留',error);}
  const warnings=[];let target;
  try{target=store.read(store.roundFile(base,id));}catch{}
  if(target?.schema!==1||target.id!==id||typeof target.uid!=='string'||!/^\d{5,20}$/.test(target.uid)||subject&&!identity.matches(target,subject))return wait('订阅身份暂不能核实，已保留证据；一分钟后只核对本地状态，不发送请求');
  const e=entries.find(e=>identity.matches(e,target));
  if(active&&identity.matches(active,target)&&active.id!==id)interrupt('必要结算尚未完成，保存当前响应后暂停');
  if(active?.id===id)active=null;
  if(e){e.pending=true;if(e.enabled){recovery.waiting(e,{...target,id},now(),{code:'AUTO_FINALIZATION',local:true,random});e.reason=String(reason||'必要结算尚未完成，正在自动核对；保留订阅意图').slice(0,500);}else{e.status='paused';e.nextCheckAt=null;}}
  try{persist();}catch(error){return wait('订阅暂停状态暂未保存，原始证据保留；存储恢复后自动核对并继续',error);}
  localHold=null;
  try{emit();}catch(error){warnings.push({stage:'hold-notification',message:error.message});}
  return {held:true,coreFailed:false,warnings};
 }
 function recoverSettlement(id,{summary=null,code=0,cancelled=false,reason='',startedAt='',failureCode='',failureRetryAt=0}={}){
  if(active?.id===id)return finish(id,{summary,code,cancelled,reason,failureCode,failureRetryAt});
  let r;const warnings=[];
  const fail=error=>({id,coreFailed:true,dataSaved:!!summary,message:String(error?.message||error),warnings});
  try{
   if(!acquire())throw Error('另一实例拥有订阅会话，未覆盖结算或订阅设置');
   r=store.read(store.roundFile(base,id));
   if(!r||r.schema!==1||r.id!==id||!/^\d{5,20}$/.test(r.uid)||!Array.isArray(r.requests))throw Error('无法核实原订阅账本，未改写结算或成功位置');
   const expected=summary?.target||summary?.uid;
   if(expected&&String(expected)!==r.uid)throw Error('恢复结果的身份与原订阅不一致，证据保留');
   // A live newer round owns its own settings and progress. This recovery only
   // checks/repairs the old immutable round record and optional local inbox.
   if(r.requests.some(q=>q.status==='reserved'||q.status==='unknown'&&(!Number.isSafeInteger(q.returned)||!q.file||!/^[a-f0-9]{64}$/.test(q.hash||''))))throw Error('原请求仍有未知结果，结算证据保留；不会自动重试');
   if(!summary?.syncOnly&&!r.summary?.syncOnly){
    for(const q of r.requests){
     if(!['estimated','unknown'].includes(q.status)||!Number.isSafeInteger(q.returned)||q.returned<0||!Number.isSafeInteger(q.count)||q.returned>q.count||typeof q.file!=='string'||!/^[a-f0-9]{64}$/.test(q.hash||''))throw Error('原请求的返回或费用证据不完整，仍需核实；不会自动重新取数');
     recovery.verifyComplete(base,dataDir(r),r,q);
    }
    const e=entries.find(e=>identity.matches(e,r));
    // Do not rewrite a newer round's state. No summary ever certifies coverage.
    if(e&&(!e.lastCheckAt||!Number.isFinite(Date.parse(r.startedAt))||Date.parse(e.lastCheckAt)<=Date.parse(r.startedAt))){if(e.enabled){e.status='waiting';e.nextCheckAt=new Date(now()+1000).toISOString();delete e.recovery;e.reason='上次任务本地证据已核实，自动继续订阅；未证实区间仍保留';}persist();}
    if(!r.recoveryClosure){r.status='interrupted';r.finishedAt=r.finishedAt||new Date(now()).toISOString();r.reason='上次任务意外中断，已完成本地收尾；未确认的范围和费用证据保留';r.recoveryClosure='interrupted-with-saved-evidence';store.atomic(store.roundFile(base,id),r);}
    const fallback=writeFallback(r);if(fallback?.error)warnings.push({stage:'update-history',message:fallback.error.message});
    return {id,dataSaved:false,coreFailed:false,ledgerSaved:true,settingsSaved:true,interrupted:true,warnings};
   }
   const settled=r.status!=='running'&&!!r.finishedAt&&r.summary?.syncOnly;
   if(!settled){
    if(!summary?.syncOnly)throw Error('原任务缺少可靠结果，仍需核实结算；不会自动重新取数');
    for(const q of r.requests){
     if(!['estimated','unknown'].includes(q.status)||!Number.isSafeInteger(q.returned)||q.returned<0||!Number.isSafeInteger(q.count)||q.returned>q.count||typeof q.file!=='string'||!/^[a-f0-9]{64}$/.test(q.hash||''))throw Error('原请求的返回或费用证据不完整，待恢复区间保留');
     recovery.verifyComplete(base,dataDir(r),r,q);
    }
    r.summary=summary;r.billing=summary.billing||r.billing||null;r.reason=String(reason||r.reason||'已根据保存的证据恢复本地结算').slice(0,500);r.status=cancelled?'cancelled':code?'failed':summary.incomplete?'partial':'complete';r.finishedAt=r.finishedAt||summary.updatedAt||startedAt||new Date(now()).toISOString();r.recoveredSettlementAt=new Date(now()).toISOString();store.atomic(store.roundFile(base,id),r);
   }
   for(const warning of r.sideEffects||[])warnings.push({...warning});
   const savedSummary=r.summary||summary;
   if(identity.kind(r)==='user'&&savedSummary?.batchId)try{require('../lib/follow-inbox').ingest(base,r.uid,savedSummary.batchId);for(let i=warnings.length-1;i>=0;i--)if(warnings[i].stage==='inbox')warnings.splice(i,1);}catch(error){warnings.push({stage:'inbox',message:error.message});}
   return {id,dataSaved:!!savedSummary,coreFailed:false,alreadySettled:!!settled,ledgerSaved:true,settingsSaved:true,warnings};
  }catch(error){return fail(error);}
 }
 function tick(){try{return tickWork();}catch(error){const code=require('../lib/diagnostic-codes').safe(error.code);let scoped=false;if(tickEntry&&code!=='AUTO_LEDGER_INVALID')try{const e=entries.find(e=>identity.matches(e,tickEntry));if(e?.enabled){recovery.waiting(e,{id:e.lastRoundId||'',source:e.source},now(),{code,local:true,random});e.reason='此订阅本地状态暂不可核实，已保留启用意图与证据；稍后自动核对，其他订阅继续：'+clean(conciseError(error));persist();scoped=true;emit();}}catch{}if(!scoped)dispatchAfter=now()+60000;try{publish('followError',{...(scoped?{uid:tickEntry.uid,targetKind:identity.kind(tickEntry)}:{}),code,stage:'automatic-local-recovery',message:scoped?'此订阅暂时无法安全检查，稍后自动核对；其他订阅继续':'订阅暂时无法安全检查，已保留启用意图；一分钟后自动重新核对本地状态',coreFailed:true});}catch{}}}
 function wake(){if(closed)return;if(!entries.some(e=>e.enabled)||!acquire()){emit();return;}for(const e of entries)if(e.enabled&&e.status!=='budget-paused'){e.nextCheckAt=new Date(Math.max(now()+500,validDeadline(e.restUntil),e.recovery?Date.parse(e.nextCheckAt)||0:0)).toISOString();e.reason='电脑唤醒，等待一次检查';}if(entries.length)persist();emit();}
 function observe(summary,context){
  if(summary?.uid&&summary.batchId&&summary.category!=='post-comments'&&summary.category!=='posts')require('../lib/follow-inbox').ingest(base,summary.uid,summary.batchId);
  if(context?.workspace===base&&!context.automatic&&!context.preview&&typeof context.id==='string'&&typeof context.requestId==='string'&&context.requestId&&context.query?.syncOnly&&['comments-sent','comments-received','comments-both','post-comments'].includes(context.query.mode)&&summary?.persistence?.coreSaved&&summary.batchId&&!summary.autoRoundId&&!context.query.from&&!context.query.to&&!context.query.before&&!context.query._resumeTaskId&&acquire()){
   const post=context.query.mode==='post-comments',id=post?require('./ui/form-utils').postId(context.query.target):require('./ui/form-utils').uid(context.query.target),e=entries.find(e=>identity.kind(e)===(post?'post':'user')&&e.uid===id);
   if(e?.enabled&&e.frequency==='adaptive'&&(e.source||'cli')===(context.query.source||'cli')){
    const db=require('../lib/database-sync'),dir=dataDir(e),batch=db.readBatch(dir,summary.batchId),history=db.historyEntry(dir,summary.batchId),task=require('./user-workspace').task(base,context.id),at=now(),stamp=Date.parse(batch.createdAt),mode={sent:'comments-sent',received:'comments-received',both:'comments-both','post-comments':'post-comments'}[batch.mode];
    if(e.manualActivity?.batchId===batch.id){emit();return;}
    if(batch.target!==id||batch.category!==(post?'post-comments':'user-comments')||!post&&batch.uid!==id||batch.from||batch.to||mode!==context.query.mode||!batch.sources?.every(s=>(s.source||'cli')===(context.query.source||'cli'))||!history||history.batchId!==batch.id||history.target!==id||history.category!==batch.category||(history.source||'cli')!==(context.query.source||'cli')||!['regular','quick'].includes(history.operation)||!task||!Number.isFinite(Date.parse(context.startedAt))||task.startedAt!==context.startedAt||task.requestId!==context.requestId||!task.summary?.persistence?.coreSaved||task.summary.batchId!==summary.batchId||task.status==='running'||task.query?.target!==context.query.target||task.query?.mode!==context.query.mode||!task.query?.syncOnly||task.query.from||task.query.to||task.query.before||(task.query?.source||'cli')!==(context.query.source||'cli')||! /^[a-f0-9-]{36}$/.test(context.query._scopeId||'')||task.query?._scopeId!==context.query._scopeId||!Number.isFinite(stamp)||stamp>at+60000||stamp<at-5*60000||stamp<=(Date.parse(e.manualActivity?.createdAt)||0))throw store.safety('LOCAL_SOURCE_INVALID','本次手动活动与原订阅批次无法核实，未改变检查节奏');
    const before=e.effectiveInterval,proof={...summary,sources:batch.sources,from:batch.from,to:batch.to};
    if(frequency.hasActivity(e,proof,at)){let decision;frequency.interval(e,proof,at,value=>decision=value);e.manualActivity={batchId:batch.id,createdAt:batch.createdAt,taskId:context.id,requestId:context.requestId,scope:context.query._scopeId,hash:crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex')};if(before!==e.effectiveInterval){replanNormal(e,at,e.effectiveInterval*60000);if(!active&&e.status==='waiting'&&!e.recovery&&(!e.pauseCode||e.directionRetry)){e.nextCheckAt=new Date(nextDirections(e,at)).toISOString();}}persist();if(decision)publish('autoFrequency',{uid:e.uid,targetKind:identity.kind(e),source:e.source||'cli',taskId:context.id,requestId:context.requestId,frequency:{...decision,nextCheckAt:e.nextCheckAt||null}});}
   }
  }
  recoverBaselinePauses();emit();
 }
 function readItems(uid,ids){const result=require('../lib/follow-inbox').markRead(base,uid,ids);emit();return result;}
 function recoverBaselinePauses(){
  const eligible=e=>identity.kind(e)==='user'&&!e.enabled&&e.status==='error-paused'&&(e.pauseCode==='AUTO_BASELINE'||/^(?:发出|收到)的评论缺少可靠的增量基线，请先手动更新该方向$/.test(e.reason||''));
  if(!entries.some(eligible)||!acquire())return false;const waiting=entries.filter(eligible);let changed=false;
  for(const e of waiting)try{const kinds=e.mode==='both'?['sent','received']:[e.mode],dir=dataDir(e);if(!kinds.every(kind=>{const s=require('../lib/incremental').prepareUpdateState(dir,kind,e.uid);return s?.checkedAt&&s.endPolicyVersion===2&&!s.baselineUnverified&&!s.sinceDisabled&&(!s.pending||s.pending.since);}))continue;e.status='paused';e.reason='已从保存的响应核实更新起点，可恢复订阅；旧任务与历史缺失仍保留';e.nextCheckAt=null;e.pauseCode=null;changed=true;}catch{/* Keep the original pause and evidence when local verification fails. */}
  if(changed)persist();return changed;
 }
 function recoverLegacyIntent(){
  const eligible=e=>!e.intentVersion&&!e.enabled&&!e.removing&&e.status==='error-paused'&&/^[a-f0-9-]{36}$/.test(e.lastRoundId||'')&&Number.isFinite(Date.parse(e.lastCheckAt));
  if(!entries.some(eligible)||!acquire())return;
  let changed=false;
  for(const e of entries.filter(eligible))try{
   const r=store.read(store.roundFile(base,e.lastRoundId));
   if(!r||r.schema!==1||r.id!==e.lastRoundId||!identity.matches(e,r)||r.mode!==e.mode||(r.source||'cli')!==(e.source||'cli')||r.status!=='failed'||r.finishedAt!==e.lastCheckAt||r.summary?.cancelled)continue;
   const stop=store.read(store.roundFile(base,r.id)+'.stop',null);if(stop&&!(stop.schema===1&&stop.code==='AUTO_YIELD'&&stop.roundId===r.id&&identity.matches(stop,r)))continue;
   e.enabled=true;e.intentVersion=1;e.intentMigration={from:'legacy-automatic-error',roundId:r.id,at:new Date(now()).toISOString()};recovery.waiting(e,r,now(),{code:'AUTO_LEGACY_RECOVERY',local:r.requests.some(q=>['reserved','unknown'].includes(q.status)),random});e.reason='旧版在单轮异常后自动停用；已保留原设置，核实安全条件后自动继续';changed=true;
  }catch{/* Missing or contradictory legacy evidence cannot enable a target. */}
  if(changed)persist();
 }
 function close(){closed=true;if(timer)clearTimer(timer);interrupt('应用退出，保留续取位置');}
 function release(){try{sessionLease?.release();}finally{sessionLease=null;owns=false;}}

 function recoverStartup(){
  const retry=!!startupError;
  try{
   entries=loadSettings().entries.map(normalizeEntry);
   recoverLegacyIntent();
   const needsRecovery=entries.some(e=>e.enabled||e.removing||e.status==='running')||store.ledger(base).running;
   if(needsRecovery){if(!acquire())return false;recover();recovered=true;}
   // Complete a persisted removal only after interrupted evidence is recovered.
   if(entries.some(e=>e.removing)){entries=entries.filter(e=>!e.removing);persist();}
   recoverBaselinePauses();startupError=null;startupReady=true;
  }catch(error){
   // This is the lease obtained by this scheduler only. A different live owner
   // is never displaced, and no invalid ledger is treated as zero usage.
   release();recovered=false;startupError=error;dispatchAfter=now()+60000;
   try{publish('followError',{code:require('../lib/diagnostic-codes').safe(error.code),stage:'automatic-local-recovery',message:'订阅本地记录暂不可核实，已保留启用意图与原证据；一分钟后自动重新核对',coreFailed:true});}catch{}
   return false;
  }
  if(retry)try{emit();}catch{/* Status presentation must not stop recovery. */}
  return true;
 }
 recoverStartup();
 timer=setTimer(tick,1000);timer?.unref?.();
 return {snapshot,save,resume,resetBudget,dismissMissing,remove,unsubscribe,pause,tick,finish,prepareWorker,bindWorker,workerClosed,holdFinalization,recoverSettlement,wake,interrupt,close,release,observe,readItems,get active(){return active;}};
}
module.exports={createAutoFollow,validate,nextDay};
