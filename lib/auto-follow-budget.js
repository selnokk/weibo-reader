'use strict';
// Durable, conservative reservations. A response estimate is never a service ledger debit.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {readerRoot}=require('./data-layout'),{ENDPOINTS,rawArray}=require('./core');
const identity=require('./subscription-key'),views=require('./file-view-cache');
const idOK=id=>/^[a-f0-9-]{36}$/.test(id||'');
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
function read(file,fallback){try{return views.readJSON(file);}catch(e){if(e.code==='ENOENT')return fallback;throw Error('订阅记录无法读取，已停止，原文件保留');}}
const directory=base=>path.join(readerRoot(base),'auto-follow');
function roundFile(base,id){if(!idOK(id))throw Error('自动任务编号无效');return path.join(directory(base),'rounds',id+'.json');}
function localDay(now=Date.now(),zone=Intl.DateTimeFormat().resolvedOptions().timeZone){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),get=k=>parts.find(p=>p.type===k).value;return get('year')+'-'+get('month')+'-'+get('day');}
function rounds(base){const dir=path.join(directory(base),'rounds');if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>idOK(n.replace(/\.json$/,''))&&n.endsWith('.json')).map(n=>read(path.join(dir,n))).filter(r=>r?.schema===1);}
function invalidLedger(message){return safety('AUTO_LEDGER_INVALID','订阅费用账本无法核实，已停止自动请求；原文件保留：'+message);}
function money(value,label,optional=false){if(value==null&&optional)return null;const n=typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;if(!Number.isFinite(n)||n<0)throw invalidLedger(label+'无效');return n;}
function projectRound(raw,file=''){
 if(raw?.schema!==1||!/^\d{5,20}$/.test(String(raw.uid||''))||typeof raw.uid==='number'&&!Number.isSafeInteger(raw.uid)||!Array.isArray(raw.requests))throw invalidLedger('任务版本、身份或请求列表不完整');
 if(raw.id!=null&&file&&raw.id!==path.basename(file,'.json'))throw invalidLedger('任务编号与文件不一致');
 if(raw.targetKind!=null&&!['user','post'].includes(raw.targetKind))throw invalidLedger('订阅类型无效');
 const days=Object.create(null);
 for(const q of raw.requests){
  if(!q||typeof q!=='object'||Array.isArray(q)||!['estimated','unknown','reserved'].includes(q.status))throw invalidLedger('请求状态不明');
  for(const key of ['count','returned'])if(q[key]!=null&&(!Number.isSafeInteger(q[key])||q[key]<(key==='count'?1:0)))throw invalidLedger('请求或返回条数无效');
  if(q.count!=null&&q.returned!=null&&q.returned>q.count)throw invalidLedger('返回条数超过预留范围');
  money(q.unitPrice,'单价',true);
  const pending=['reserved','unknown'].includes(q.status),estimated=money(q.estimatedCredits,'估算费用',pending),reserved=money(q.reservedCredits,'预留费用',!pending),actual=money(q.actualCredits,'实际费用',true);
  let day=q.day;
  const validDay=typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
  if(!validDay){if((estimated||0)>0||(reserved||0)>0||(actual||0)>0)throw invalidLedger('非零费用缺少有效归属日期');day='$undated-zero';}
  const d=days[day]??={estimated:0,reserved:0,unknown:0,actual:0,actualCount:0};
  if(pending){d.reserved+=reserved;d.unknown+=q.status==='unknown'?1:0;}else d.estimated+=estimated;
  if(actual!=null&&q.verifiedLedger){d.actual+=actual;d.actualCount++;}
  if(!Number.isFinite(d.estimated+d.reserved+d.actual))throw invalidLedger('费用合计超出可核实范围');
 }
 return {uid:String(raw.uid),targetKind:identity.kind(raw),source:raw.source==='crawler'?'crawler':'cli',pending:raw.requests.some(q=>['reserved','unknown'].includes(q.status)),running:raw.status==='running',notice:!!raw.billingUnverified||raw.requests.some(q=>q.status==='unknown'),days};
}
function addProjection(subjects,r){const key=r.targetKind+':'+r.uid,s=subjects[key]??={notice:false,pending:0,unknown:0,days:Object.create(null)};s.notice||=r.notice;for(const [day,d]of Object.entries(r.days)){const value=s.days[day]??={estimated:0,reserved:0,unknown:0,actual:0,actualCount:0};for(const k of Object.keys(value))value[k]+=d[k];s.pending+=d.reserved;s.unknown+=d.unknown;if(!Number.isFinite(value.estimated+value.reserved+value.actual+s.pending))throw invalidLedger('历史费用合计超出可核实范围');}}
function subjectUsage(subject,day){const d=subject?.days[day];return {estimatedCredits:d?.estimated||0,reservedCredits:d?.reserved||0,historicalUnverifiedCredits:(subject?.pending||0)-(d?.reserved||0),unknownRequests:subject?.unknown||0,actualCredits:d?.actualCount?d.actual:null,committed:(d?.estimated||0)+(d?.reserved||0)};}
function resetFile(base,uid,day,kind){
 if(!/^\d{5,20}$/.test(uid)||!/^\d{4}-\d\d-\d\d$/.test(day)||!['user','post'].includes(kind))throw invalidLedger('额度周期或对象无效');
 return path.join(directory(base),'budget-resets',kind+'-'+uid,day+'.json');
}
function adjustedUsage(base,uid,day,kind,value){
 const reset=read(resetFile(base,uid,day,kind),null);if(!reset)return value;
 if(reset.schema!==1||reset.uid!==uid||reset.kind!==kind||reset.day!==day||!Number.isFinite(Date.parse(reset.at)))throw invalidLedger('额度重置记录无效');
 const budgetSpent=Math.max(0,value.estimatedCredits-money(reset.settledCredits,'重置时已结算额度'));
 return {...value,budgetSpent,budgetResetAt:reset.at,committed:budgetSpent+value.reservedCredits};
}
function resetToday(base,uid,day,kind,at){
 const current=ledger(base).usage(uid,day,kind);
 if((current.budgetSpent??current.estimatedCredits)>0)
  atomic(resetFile(base,uid,day,kind),{schema:1,uid,kind,day,at:new Date(at).toISOString(),settledCredits:current.estimatedCredits});
 return ledger(base).usage(uid,day,kind);
}
function usage(base,uid,day,history,targetKind='user'){if(history===undefined)return ledger(base).usage(uid,day,targetKind);const subjects=Object.create(null);for(const raw of history)addProjection(subjects,projectRound(raw));return adjustedUsage(base,uid,day,targetKind,subjectUsage(subjects[targetKind+':'+uid],day));}
// Derived projections are local view accelerators, never pagination evidence.
// Unparseable or structurally invalid ledgers fail closed instead of becoming 0.
function ledger(base){
 const dir=path.join(directory(base),'rounds'),manifest=views.manifest(dir,{filter:/^[a-f0-9-]{36}\.json$/,strict:true});
 const data=views.memo('subscription-ledger\0'+dir,manifest.signature,()=>{
  const subjects=Object.create(null),runningFiles=[],pendingFiles=[];let running=false;
  for(const {file}of manifest.files){const r=views.fileView(file,'ledger-round-v2',raw=>projectRound(raw,file));running||=r.running;if(r.running)runningFiles.push(file);if(r.pending)pendingFiles.push({file,uid:r.uid,targetKind:r.targetKind,source:r.source});addProjection(subjects,r);}
  return {subjects,running,runningFiles,pendingFiles};
 });
 return {running:data.running,runningFiles:[...data.runningFiles],pendingFiles:(uid,kind='user',source='cli')=>data.pendingFiles.filter(e=>e.uid===uid&&e.targetKind===kind&&e.source===source).map(e=>e.file),notice:(uid,kind='user')=>!!data.subjects[kind+':'+uid]?.notice,usage:(uid,day,kind='user')=>adjustedUsage(base,uid,day,kind,subjectUsage(data.subjects[kind+':'+uid],day))};
}
function runningRounds(base){return ledger(base).runningFiles.map(file=>read(file));}
function safety(code,message){return Object.assign(Error(message),{code});}
function priceFor(command,kind,service){const def=ENDPOINTS[kind].command,flags=new Set((command?.flags||[]).map(f=>f.name));if(command?.group!==def[0]||command.action!==def[1]||command.method!=='GET'||!(kind==='post-comments'?['id','count','page','filter_by_author','max_id','since_id']:['uid','count','max_id','since_id']).every(f=>flags.has(f)))throw safety('AUTO_UNSUPPORTED',ENDPOINTS[kind].label+'未明确支持 since_id / max_id，订阅已暂停，不回退读取旧记录');const p=require('./command-pricing').parse(command,{group:def[0],action:def[1],types:['per_record'],serviceKind:service});if(!p)throw safety('AUTO_PRICE_UNKNOWN','接口计费方式或当前单价不明，自动请求已停止');return p.unitPrice;}
const MAX_CLI_ROUND_RETURNS=100;
function createBudget(base,id,{now=Date.now}={}){
 const file=roundFile(base,id),job=read(file);if(job?.schema!==1||!/^\d{5,20}$/.test(job.uid)||!Number.isSafeInteger(job.roundLimit)||job.roundLimit<1||!Number.isFinite(job.dailyBudget)||job.dailyBudget<=0)throw Error('自动任务配置无效');
 const roundLimit=Math.min(job.roundLimit,MAX_CLI_ROUND_RETURNS);
 const prices=new Map(),directionErrors=new Map();let initial=null,stopCode='',stopReason='',stopKind='',serviceWireProofs;const stop=(code,reason)=>{stopCode=code;stopReason=reason;stopKind='';return 0;};
 function configure(metadata,snapshot){initial=snapshot.initialBalance;if(initial==null||!Number.isFinite(initial)||initial<0)throw safety('AUTO_BALANCE_UNKNOWN','本轮未能核实服务余额，未发起内容请求；订阅设置保留');for(const kind of job.kinds)try{prices.set(kind,priceFor(metadata.get(kind),kind,snapshot.serviceKind));}catch(error){directionErrors.set(kind,error);}if(!prices.size&&directionErrors.size)throw directionErrors.values().next().value;}
 function maxCount(kind,wanted){
  if(job.blockedKinds?.includes(kind))throw safety('AUTO_OUTCOME_UNKNOWN','该方向上次请求仍待本地核对，不发起重复请求');
  if(!prices.has(kind))throw safety('AUTO_PRICE_UNKNOWN','单价尚未核实');
  if(stopCode&& !['AUTO_ROUND_LIMIT','AUTO_DAILY_BUDGET'].includes(stopCode)&&(!stopKind||stopKind===kind))return 0;
  const interrupt=read(file+'.stop',null);if(interrupt)return stop('AUTO_YIELD',interrupt.reason||'等待手动任务，续取位置保留');
  const round=read(file),used=(round.requests||[]).reduce((n,q)=>n+(q.returned||0),0),day=localDay(now(),job.timeZone),u=usage(base,job.uid,day,undefined,identity.kind(job)),spent=(round.requests||[]).reduce((n,q)=>n+(['unknown','reserved'].includes(q.status)?Number(q.reservedCredits)||0:q.estimatedCredits||0),0),price=prices.get(kind);
  if((round.requests||[]).some(q=>q.status==='reserved'))throw safety('AUTO_IN_FLIGHT','当前请求尚未结束，不能并发重复请求');
  if(used>=roundLimit)return stop('AUTO_ROUND_LIMIT','达到单轮取数上限，未读取区间已保留');
  if(u.committed>=job.dailyBudget-1e-9)return stop('AUTO_DAILY_BUDGET','本周期订阅预算已用尽，待补区间保留');
  const money=price===0?Infinity:Math.floor((job.dailyBudget-u.committed+1e-9)/price),balance=price===0?Infinity:Math.floor((initial-spent+1e-9)/price);
  if(money<1)return stop('AUTO_DAILY_BUDGET','本周期剩余额度不足以请求 1 条，待补区间保留');
  if(balance<1)return stop('AUTO_BALANCE','服务余额不足，订阅已暂停');
  return Math.min(wanted,roundLimit-used,money,balance);
 }
 function beginInitial(kind,dir){
  if(identity.kind(job)!=='user'||!['sent','received'].includes(kind)||!job.kinds.includes(kind))throw safety('AUTO_BASELINE','此方向不能自动初始化');
  const storage=require('./storage'),p=storage.storagePaths(base),expected=storage.mappedFolder(p.users,job.uid,storage.indexRead(p.users));if(path.resolve(dir)!==path.resolve(expected))throw safety('AUTO_BASELINE','初始化资料目录与原对象不一致');
  const checkpointFile=require('./incremental').stateFile(dir,kind),state=require('./incremental').readState(dir,kind,job.uid);
  if(state?.checkedAt||state?.pending||state?.sinceDisabled)throw safety('AUTO_BASELINE','已有检查点或未完成区间，不能以初始化覆盖');
  let planChecked=false;
  for(const prior of ledger(base).pendingFiles(job.uid,'user','cli')){
   const round=read(prior);
   for(const request of round.requests){
    if(request.kind!==kind||!['reserved','unknown'].includes(request.status))continue;
    if(job.automaticRecovery?.kinds?.includes(kind)){
     if(!planChecked)require('./subscription-continuous').validatePlan(base,dir,job,kind,{now});
     planChecked=true;
     continue;
    }
    const service=require('./subscription-service-proof'),proof=service.rejection(base,dir,round,request);
    if(proof&&service.restored(base,dir,proof))continue;
    throw safety('AUTO_OUTCOME_UNKNOWN','原方向存在未决请求，不初始化或重发');
   }
  }
  const value=read(file),proof={file:path.relative(base,checkpointFile),checkpointToken:require('./update-progress').token(checkpointFile),journalFile:path.relative(base,require('./data-update').progressFile(dir,kind,{taskScopeId:job.id})),previous:state||null};value.initialBaselines??={};value.initialBaselines[kind]=proof;atomic(file,value);job.initialBaselines=value.initialBaselines;
 }
 function initialAllowed(kind,count,maxId,activeReservationId){
  const proof=job.initialBaselines?.[kind];if(!proof)return false;const target=path.resolve(base,proof.file);if(!target.startsWith(path.resolve(base)+path.sep)||require('./update-progress').token(target)!==proof.checkpointToken)return false;
  const round=read(file),requests=round.requests.filter(q=>q.kind===kind&&q.id!==activeReservationId);if(!requests.length)return count===1&&!maxId;
  if(!maxId||!proof.journalFile)return false;
  try{const dir=path.dirname(path.dirname(path.dirname(target))),journalFile=require('./data-update').progressFile(dir,kind,{taskScopeId:job.id});if(path.resolve(base,proof.journalFile)!==path.resolve(journalFile))return false;
   const journal=read(journalFile),refs=journal?.packets;
   if(journal?.uid!==job.uid||journal.kind!==kind||journal.anchor!==''||journal.phase!=='body'||journal.checkpointToken!==proof.checkpointToken||!journal.ownerScopes?.includes(job.id)||journal.cursor!==maxId||refs?.length!==requests.length)return false;
   let cursor='';const exact=require('./completeness').exactId;
   for(const [i,ref] of refs.entries()){
    const last=requests[i],{query:q,raw,billingReservation,received}=require('./request-journal').verifySavedResponse(dir,ref),a=rawArray(raw,kind),ids=a?.items.map(r=>exact(r.idstr??r.id));
    if(!['estimated','unknown'].includes(last.status)||billingReservation?.id!==last.id||billingReservation.roundId!==round.id||!received||last.file!==received.file||last.hash!==received.hash||!ids||ids.length!==last.returned||ids.some(id=>!id)||q.uid!==job.uid||q.kind!==kind||q.taskId!==journal.id||q.page!==1||q.count!==last.count||q.maxId!==cursor||q.maxId!==last.maxId||q.sinceId!==(last.sinceId||''))return false;
    const next=require('./history').historyNext(raw,kind),lower=ids.reduce((a,b)=>!a||BigInt(b)<BigInt(a)?b:a,'');
    const missing=a.container.miss_ids_str??a.container.miss_ids??[];
    if(!lower&&(!Array.isArray(missing)||missing.length||Number(a.container.miss_count||0)!==0||!next||next==='0'))return false;
    const upper=next&&next!=='0'?next:lower?(BigInt(lower)-1n).toString():'';
    if(!exact(upper)||cursor&&BigInt(upper)>=BigInt(cursor))return false;cursor=upper;
   }
   return cursor===maxId;
  }catch{return false;}
 }
 function recoveryBounds(valid,dir,kind,sinceId,maxId){
  if(!valid.initial)return valid.window.anchor===sinceId&&valid.window.pending.cursor===(maxId||'');
  if(valid.journal.cursor!==(maxId||''))return false;
  if(!sinceId)return true;
  // Initial regular collection may use the existing collector's actual scanned
  // older band as a request optimization. This is not a successful future head.
  const older=maxId&&valid.journal.phase==='body'&&!valid.journal.gapSinceDisabled&&require('./data-windows').createWindows(dir,kind,job.uid).bandBelow(maxId);
  return !!older&&older.id===sinceId;
 }
 function confirmedChoice(reader,ref,sinceId){
  const chosen=reader.committed(ref.decisionId,{roundId:ref.roundId,requestId:ref.requestId,sinceId});
  if(!chosen||chosen.choiceHash!==ref.choiceHash||chosen.head!==ref.futureLower)throw safety('AUTO_OUTCOME_UNKNOWN','未来检查起点选择已变化，未重复发送');
 }
 function reserve(kind,count,sinceId,maxId,context){
  const choices=(job.unresolvedRanges||[]).filter(ref=>ref.kind===kind&&(ref.decisionId||ref.serviceRejection)),serviceProofs=[],restoredProofs=[];
  const S=require('./storage'),p=S.storagePaths(base),choiceDir=identity.kind(job)==='post'?S.findPostFolder(p.postComments,job.postId||job.uid):S.mappedFolder(p.users,job.uid,S.indexRead(p.users)),state=require('./incremental').readState(choiceDir,kind,job.uid);
  const choiceJournal=require('./request-journal').proofReader(choiceDir);
  let decisionReader,choiceToken,serviceReader;
  const continuous=job.automaticRecovery?.kinds?.includes(kind)?require('./subscription-continuous').validate(base,choiceDir,job,kind,context,{now,unitPrice:prices.get(kind)}):null;
  if(continuous){if(!recoveryBounds(continuous,choiceDir,kind,sinceId,maxId))throw safety('AUTO_OUTCOME_UNKNOWN','独立观测请求边界已变化');const requests=read(file).requests.filter(q=>q.kind===kind);if(!requests.length&&count!==1)throw safety('AUTO_ROUND_LIMIT','持续恢复先执行一条独立核查');}
  if(!continuous&&(choices.length||state?.userUnknownChoices?.length||job.serviceRetry)){
   const present=new Set((job.unresolvedRanges||[]).filter(ref=>ref.kind===kind).map(ref=>ref.roundId+':'+ref.requestId));
   for(const prior of require('./gap-choice-proof').pendingRequests(base,job.uid,kind,identity.kind(job)))if(!Number.isSafeInteger(prior.request.returned)||!prior.request.file||!prior.request.hash){if(!present.has(prior.roundId+':'+prior.requestId))throw safety('AUTO_OUTCOME_UNKNOWN','原未知请求缺少本轮精确选择关联，未发起新请求');}
  }
  if(!continuous&&choices.length){
   choiceToken=require('./subscription-response-proof').pendingTokenForJob(base,choiceDir,job,kind);
   if(choices.some(ref=>ref.pendingToken!==choiceToken))throw safety('AUTO_OUTCOME_UNKNOWN','出现新的未确认请求或原预留已变化，请重新核对；未沿用旧选择');
  }
  for(const ref of job.unresolvedRanges||[]){
   if(ref.kind!==kind)continue;
   if(continuous)continue;
   const prior=read(roundFile(base,ref.roundId)),q=prior?.requests?.find(q=>q.id===ref.requestId);
   if(!prior||!identity.matches(prior,job)||prior.source&&prior.source!=='cli'||!q||q.kind!==kind||(q.maxId||'')!==ref.maxId||(q.sinceId||'')!==ref.sinceId)throw safety('AUTO_OUTCOME_UNKNOWN','原未决请求关联已变化，未放行新请求');
   if(!['reserved','unknown'].includes(q.status))continue;
   if(ref.serviceRejection){
    const S=require('./subscription-service-proof');let restored,grant;
    serviceReader??=S.restorationReader(base,choiceDir,job,choiceJournal);
    try{restored=serviceReader.restored(ref.serviceRejection,{recheckRejection:true});if(!restored&&!ref.serviceRestored)grant=S.granted(base,choiceDir,job,ref.serviceRejection);}catch{throw safety('AUTO_OUTCOME_UNKNOWN','原服务拒绝回执已变化，未重新请求');}
    if(ref.serviceRestored&&JSON.stringify(ref.serviceRestored)!==JSON.stringify(restored))throw safety('AUTO_OUTCOME_UNKNOWN','服务恢复正常响应证据已变化');
    if(restored)restoredProofs.push({ref,restored});
    else{
     const lower=require('./subscription-latest').safeLower(choiceDir,kind,job.uid);
     if(!grant||grant.id!==ref.serviceGrantId||count!==1||maxId||!sinceId||!lower||BigInt(sinceId)<BigInt(lower))throw safety('IP_GEO_DENIED',require('./service-rejection').message);
     serviceProofs.push(ref.serviceRejection);
    }
   }else if(ref.decisionId){
    try{
     decisionReader??=require('./gap-choice-proof').futureChoiceReader(base,choiceDir,job.uid,kind,{state,journal:choiceJournal});
     confirmedChoice(decisionReader,ref,sinceId);
    }catch{throw safety('AUTO_OUTCOME_UNKNOWN','原未知区间选择或完整响应无法核实，未放行新请求');}
   }else if(!sinceId||!q.maxId||BigInt(sinceId)<BigInt(q.maxId))throw safety('AUTO_OUTCOME_UNKNOWN','新请求与原未决范围重叠，未重复发送');
  }
  const allowed=maxCount(kind,count);
  const initializingPost=identity.kind(job)==='post'&&kind==='post-comments'&&!state&&!maxId;
  if(allowed<count||(!sinceId&&!initializingPost&&!initialAllowed(kind,count,maxId)))throw safety(stopCode||'AUTO_BOUNDARY',stopReason||'自动请求缺少已确认的 since_id');
  decisionReader?.assertUnchanged();serviceReader?.assertUnchanged();choiceJournal.assertUnchanged();
  if(choiceToken!==undefined&&require('./subscription-response-proof').pendingTokenForJob(base,choiceDir,job,kind)!==choiceToken)throw safety('AUTO_OUTCOME_UNKNOWN','原未确认请求在预留前变化，未沿用旧选择');
  const value=read(file),request={id:crypto.randomUUID(),kind,at:new Date(now()).toISOString(),day:localDay(now(),job.timeZone),count,sinceId,maxId,unitPrice:prices.get(kind),reservedCredits:Number((count*prices.get(kind)).toFixed(6)),status:'reserved',actualCredits:null,...(serviceProofs.length?{serviceRetryFor:{grantId:job.serviceRetry.id,proofs:serviceProofs}}:{}),...(continuous?{automaticRecovery:{planId:continuous.plan.id,policy:continuous.plan.policy,pendingToken:continuous.plan.pendingTokens[kind],proofToken:continuous.plan.proofTokens[kind],taskId:context.taskId,windowId:context.windowId,...(continuous.initial?{initial:true}:{})}}:{})};value.requests.push(request);atomic(file,value);
  serviceWireProofs=restoredProofs.length?{requestId:request.id,proofs:restoredProofs}:undefined;
  return request.id;
 }
 function settle(requestId,packet){const value=read(file),q=value.requests.find(q=>q.id===requestId);if(!q)throw safety('AUTO_REQUEST_RECORD','请求预留记录丢失');const n=rawArray(packet.raw,q.kind)?.items.length;if(!Number.isSafeInteger(n)||n>q.count||['failed','error','denied','not_executed'].includes(String(packet.raw.outcome).toLowerCase())){q.status='unknown';q.reason='响应数量、格式或执行状态异常';atomic(file,value);stop('AUTO_RESPONSE_INVALID',q.reason);throw safety('AUTO_RESPONSE_INVALID',q.reason);}const unverified=packet.raw.outcome!=null||packet.raw.billing!=null;Object.assign(q,{status:unverified?'unknown':'estimated',returned:n,estimatedCredits:Number((n*q.unitPrice).toFixed(6)),file:packet.file,hash:packet.responseHash,finishedAt:new Date(now()).toISOString()});if(unverified)q.reason='服务端费用状态待核对，已保存返回数据';atomic(file,value);return {unverified};}
 function fail(requestId,error){const value=read(file),q=value.requests.find(q=>q.id===requestId);stop('AUTO_REQUEST_FAILED',String(error.message).slice(0,400));if(q){stopKind=q.kind;q.status='unknown';q.reason=String(error.message).slice(0,400);atomic(file,value);}}
 function notSent(requestId,proof){
  const value=read(file),q=value.requests.find(v=>v.id===requestId),S=require('./storage'),p=S.storagePaths(base),dir=identity.kind(job)==='post'?S.findPostFolder(p.postComments,job.postId||job.uid):S.mappedFolder(p.users,job.uid,S.indexRead(p.users));
  if(!q||!['reserved','unknown'].includes(q.status)||proof?.billingReservation?.roundId!==job.id||proof.billingReservation.id!==requestId||!/^cache\/request-journal\/[a-f0-9-]{36}\.request\.json$/.test(proof.file||''))throw safety('AUTO_REQUEST_RECORD','未发送证明与新预留不匹配');
  const target=path.join(dir,proof.file),bytes=require('./regular-file').read(target,{maxBytes:65536}),box=JSON.parse(bytes),query=box.query,J=require('./request-journal');
  if(require('node:crypto').createHash('sha256').update(bytes).digest('hex')!==proof.hash||box.schema!==1||box.status!=='not-sent'||box.notSent?.guard!=='sdk-not-invoked-v1'||box.notSent.queryHash!==proof.queryHash||box.notSent.queryHash!==crypto.createHash('sha256').update(JSON.stringify(query)).digest('hex')||box.billingReservation?.roundId!==job.id||box.billingReservation.id!==requestId||query?.uid!==job.uid||query.kind!==q.kind||query.count!==q.count||query.maxId!==(q.maxId||'')||query.sinceId!==(q.sinceId||'')||query.page!==(q.page||1)||!J.subscriptionRequests(dir,job.id,requestId).includes(target)||['.received.json','.response.json','.rejection.json'].some(suffix=>fs.existsSync(target.replace(/\.request\.json$/,suffix))))throw safety('AUTO_REQUEST_RECORD','未发送证明无法可靠核实，原预留保留');
  Object.assign(q,{status:'estimated',returned:0,estimatedCredits:0,actualCredits:null,wireOutcome:'not-sent',notSent:{file:proof.file,hash:proof.hash},finishedAt:new Date(now()).toISOString(),reason:'本地请求前检查停止，SDK 未调用；原预留金额作为证据保留'});atomic(file,value);return {notSent:true};
 }
 function validateAutomaticWire(requestId,query,context){
  const automatic=job.automaticRecovery?.kinds?.includes(query.kind),initial=!!job.initialBaselines?.[query.kind]&&!query.sinceId,service=serviceWireProofs?.requestId===requestId?serviceWireProofs.proofs:undefined;
  const decisions=automatic?[]:(job.unresolvedRanges||[]).filter(ref=>ref.kind===query.kind&&ref.decisionId);
  if(!automatic&&!initial&&!service&&!decisions.length)return;
  const value=read(file),q=value.requests.find(v=>v.id===requestId),S=require('./storage'),p=S.storagePaths(base),dir=identity.kind(job)==='post'?S.findPostFolder(p.postComments,job.postId||job.uid):S.mappedFolder(p.users,job.uid,S.indexRead(p.users));
  if(value.id!==job.id||!identity.matches(value,job)||(value.source||'cli')!==(job.source||'cli')||query.uid!==job.uid||!q||q.status!=='reserved'||q.kind!==query.kind||q.count!==query.count||(q.sinceId||'')!==query.sinceId||(q.maxId||'')!==query.maxId||q.day!==localDay(now(),job.timeZone)||read(file+'.stop',null))throw safety('AUTO_OUTCOME_UNKNOWN','新恢复请求的预留、日期或取消状态已变化，未发送');
  if(initial&&!initialAllowed(query.kind,query.count,query.maxId,requestId))throw safety('AUTO_BOUNDARY','初始化分页的原始证据在发送前变化，未发起请求');
  if(decisions.length){
   const G=require('./gap-choice-proof'),journal=require('./request-journal').proofReader(dir),reader=G.futureChoiceReader(base,dir,job.uid,query.kind,{journal});
   try{
    const files=journal.subscriptionRequests(job.id,requestId),request=files.length===1&&read(files[0]);
    if(!request||request.status!=='inflight'||request.billingReservation?.roundId!==job.id||request.billingReservation.id!==requestId||G.digest(request.query)!==G.digest(query))throw Error('当前预留与原始请求不匹配');
    if(['.received.json','.response.json','.rejection.json'].some(suffix=>fs.existsSync(files[0].replace(/\.request\.json$/,suffix))))throw Error('当前预留已经有返回证据');
    for(const ref of decisions)confirmedChoice(reader,ref,query.sinceId);
    const token=require('./subscription-response-proof').pendingTokenForJob(base,dir,job,query.kind,{activeReservationId:requestId});
    if(decisions.some(ref=>ref.pendingToken!==token))throw Error('原未确认请求在发送前变化');
    if(G.digest(read(file).requests.find(v=>v.id===requestId))!==G.digest(q))throw Error('当前预留在发送前变化');
    reader.assertUnchanged();journal.assertUnchanged();
   }catch(cause){throw Object.assign(safety('REQUEST_EVIDENCE_INVALID','后续起点选择的原始证据在发送前变化，未发起请求'),{cause});}
  }
  if(service){
   const journal=require('./request-journal').proofReader(dir),reader=require('./subscription-service-proof').restorationReader(base,dir,job,journal);
   try{
    for(const {ref,restored} of service)if(JSON.stringify(reader.restored(ref.serviceRejection,{recheckRejection:true}))!==JSON.stringify(restored))throw Error('服务恢复证据已变化');
    reader.assertUnchanged();journal.assertUnchanged();
   }catch{throw safety('REQUEST_EVIDENCE_INVALID','服务恢复的原始证据在发送前变化，未发起请求');}
  }
  if(automatic){
   const valid=require('./subscription-continuous').validate(base,dir,job,query.kind,context,{now,unitPrice:prices.get(query.kind),activeReservationId:requestId,activeQuery:query});
   if(!recoveryBounds(valid,dir,query.kind,query.sinceId,query.maxId))throw safety('AUTO_OUTCOME_UNKNOWN','独立观测请求边界在发送前变化，未发送');
  }
  if(!automatic&&!service&&!decisions.length)return;
  if(usage(base,job.uid,localDay(now(),job.timeZone),undefined,identity.kind(job)).committed>job.dailyBudget+1e-9)throw safety('AUTO_DAILY_BUDGET','当前日预算已用尽，未发送新恢复请求');
 }
 return {configure,beginInitial,directionError:kind=>directionErrors.get(kind),maxCount,reserve,settle,fail,notSent,validateAutomaticWire,allowServiceRetry(query){try{const S=require('./storage'),p=S.storagePaths(base),dir=identity.kind(job)==='post'?S.findPostFolder(p.postComments,job.postId||job.uid):S.mappedFolder(p.users,job.uid,S.indexRead(p.users));return require('./subscription-service-proof').allowQuery(base,dir,job,query);}catch{return false;}},halt:(code,message)=>stop(code,message),job,get stopCode(){return stopCode;},get stopReason(){return stopReason;},file};
}
module.exports={atomic,read,directory,roundFile,rounds,ledger,runningRounds,usage,resetToday,localDay,priceFor,safety,createBudget,MAX_CLI_ROUND_RETURNS};
