'use strict';
// Continuous subscription authority opens a NEW scoped observation. It never
// settles, resends or changes ownership of an earlier unknown request.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const B=require('./auto-follow-budget'),G=require('./gap-choice-proof'),J=require('./request-journal'),K=require('./subscription-key'),I=require('./incremental');
const POLICY='continuous-cli-v1',uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v),read=file=>JSON.parse(require('./regular-file').read(file,{maxBytes:16*1024*1024}));
function binding(e){return {uid:e.uid,targetKind:K.kind(e),source:e.source||'cli',mode:e.mode,roundLimit:e.roundLimit,dailyBudget:e.dailyBudget,timeZone:e.timeZone};}
function enabled(base,e){
 if(e.enabled!==true||(e.source||'cli')!=='cli')return false;
 const value=read(path.join(B.directory(base),'settings.json'));if(value.schema!==1||!Array.isArray(value.entries))throw Error('订阅设置无法核实，未自动重新请求');
 const current=value.entries.find(v=>K.matches(v,e)&&(v.source||'cli')==='cli');
 return current?.enabled===true&&G.digest(binding(current))===G.digest(binding(e));
}
function ended(worker){
 if(worker?.schema!==1||!Number.isSafeInteger(worker.pid)||worker.pid<1||worker.pgid!==worker.pid||typeof worker.birth!=='string'||!worker.birth||worker.birth.length>256||!Number.isFinite(Date.parse(worker.startedAt)))return false;
 let alive=false;try{process.kill(worker.pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')return false;}
 if(alive){const birth=require('./process-lease').processBirth(worker.pid);return !!birth&&birth!==worker.birth;}
 try{process.kill(-worker.pgid,0);return false;}catch(error){return error.code==='ESRCH';}
}
function endedGroup(worker){try{process.kill(-worker.pgid,0);return false;}catch(error){return error.code==='ESRCH';}}
function legacyFinalization(base,round,q){
 // Older native runners did not capture a worker generation. Their original
 // finalizer was entered only after child close (or a definite spawn failure).
 // This proves that local task ended, never a response, charge or connected gap.
 if(round.schema!==1||!uuid(round.id)||(round.source||'cli')!=='cli'||['worker','requireWorkerBinding','automaticRecovery'].some(key=>Object.hasOwn(round,key))||Object.hasOwn(q,'automaticRecovery'))return null;
 const folder=path.join(require('./data-layout').readerRoot(base),'task-finalization');
 require('./workspace-access').directory(base,path.relative(base,folder));
 const file=path.join(folder,round.id+'.json');if(!fs.existsSync(file))return null;
 const bytes=require('./regular-file').read(file,{maxBytes:16*1024*1024}),journal=JSON.parse(bytes),query=journal.query,post=K.kind(round)==='post';
 const mode=post?'post-comments':{sent:'comments-sent',received:'comments-received',both:'comments-both'}[round.mode];
 const kinds=post?['post-comments']:round.mode==='both'?['sent','received']:[round.mode];
 if(post&&round.mode!=='post-comments'||!kinds.includes(q.kind)||!Array.isArray(round.kinds)||!round.kinds.includes(q.kind))return null;
 const start=Date.parse(round.startedAt),attempt=Date.parse(q.at),finish=Date.parse(round.finishedAt),nativeStart=Date.parse(journal.startedAt),nativeFinish=Date.parse(journal.finishedAt);
 if(journal.schema!==1||journal.id!==round.id||journal.status!=='settled'||journal.kind!=='collect'||journal.automatic!==true||journal.preview!==false||journal.cancelled!==false||journal.signal!==null||!Number.isInteger(journal.code)||journal.code<0||journal.code>255||journal.targetKind!==(post?'post':'user')||(post?journal.postId!==round.uid:journal.uid!==round.uid))return null;
 if(!mode||query?.target!==round.uid||query.mode!==mode||query.policy!=='update'||query.syncOnly!==true||(query.source||'cli')!=='cli'||query.preview||query.from||query.to||query.before||String(query.limit)!==String(round.roundLimit))return null;
 if(!Array.isArray(journal.steps)||!['task-record','billing-history','subscription-settlement'].every(step=>journal.steps.includes(step))||!Array.isArray(journal.failures)||journal.failures.some(value=>!value||typeof value.stage!=='string'||value.critical===true))return null;
 if(![start,attempt,finish,nativeStart,nativeFinish].every(Number.isFinite)||start>nativeStart||nativeStart>attempt||attempt>finish||finish>nativeFinish)return null;
 const result=journal.result;
 if(result!=null){
  if(result.type!=='summary'||result.syncOnly!==true||result.autoRoundId!==round.id||result.target!==round.uid||(post?result.category!=='post-comments':result.uid!==round.uid||result.category!=='user-comments')||result.mode!==round.mode||(result.source||'cli')!=='cli'||result.preview||result.from||result.to||G.digest(result)!==G.digest(round.summary))return null;
 }else if(round.summary!=null)return null;
 return {file:path.relative(base,file),hash:crypto.createHash('sha256').update(bytes).digest('hex'),startedAt:journal.startedAt,finishedAt:journal.finishedAt,exitCode:journal.code};
}
function missingRequest(dir,round,q,journal,lowerForMissing){
 const post=K.kind(round)==='post',kinds=post?(round.mode==='post-comments'?['post-comments']:[]):round.mode==='both'?['sent','received']:['sent','received'].filter(kind=>kind===round.mode);
 const since=v=>v===''||require('./completeness').exactId(v)===v||post&&v==='0',max=v=>v===''||require('./completeness').exactId(v)===v;
 if(round.schema!==1||!uuid(round.id)||!uuid(q.id)||typeof round.uid!=='string'||!/^\d{5,20}$/.test(round.uid)||(round.source||'cli')!=='cli'||!['complete','partial','failed','cancelled','interrupted'].includes(round.status)||round.targetKind!=null&&!['user','post'].includes(round.targetKind)||(post?round.postId!=null&&round.postId!==round.uid:round.postId!=null)||!kinds.includes(q.kind)||!Array.isArray(round.kinds)||!round.kinds.includes(q.kind)||!Array.isArray(round.requests)||round.requests.filter(v=>v?.id===q.id).length!==1)return null;
 if(!Number.isSafeInteger(q.count)||q.count<1||q.count>200||!since(q.sinceId)||!max(q.maxId)||q.sinceId&&q.maxId&&BigInt(q.maxId)<=BigInt(q.sinceId)||q.page!=null&&q.page!==1||!Number.isFinite(q.unitPrice)||q.unitPrice<0||q.reservedCredits!==Number((q.count*q.unitPrice).toFixed(6))||q.actualCredits!=null||q.estimatedCredits!=null||q.returned!=null||q.file!=null||q.hash!=null||q.wireOutcome!=null)return null;
 const start=Date.parse(round.startedAt),at=Date.parse(q.at),finish=Date.parse(round.finishedAt);
 if(!Number.isFinite(start)||start>at||q.day!==B.localDay(at,round.timeZone))return null;
 if(round.worker){const workerStart=Date.parse(round.worker.startedAt),close=Date.parse(round.worker.closedAt);if(workerStart<start||workerStart>at||round.worker.closedAt!=null&&(!Number.isFinite(close)||close<at||close>finish)||!endedGroup(round.worker))return null;}
 journal.assertNoUnboundResponse(round.id,q.id,round.uid,q.kind);
 const lower=lowerForMissing();
 return lower?{lower}:null;
}
function fact(base,dir,round,q,{service,journal=J.proofReader(dir),lowerForMissing=()=>require('./subscription-latest').safeLower(dir,q.kind,round.uid)}={}){
 if(q.status!=='unknown'||round.status==='running'||!Number.isFinite(Date.parse(round.finishedAt))||!Number.isFinite(Date.parse(q.at))||Date.parse(round.finishedAt)<Date.parse(q.at))return null;
 const queryFiles=[],queries=[];
 for(const file of journal.subscriptionRequests(round.id,q.id)){
  const request=read(file),v=request.query;
  if(request.schema!==1||request.billingReservation?.roundId!==round.id||request.billingReservation?.id!==q.id||v?.uid!==round.uid||v.kind!==q.kind||v.count!==q.count||(v.maxId||'')!==(q.maxId||'')||(v.sinceId||'')!==(q.sinceId||'')||v.page!==(q.page||1)||!uuid(v.taskId))throw Error('原未确认请求与预留身份不匹配');
  if(!service){
   if(journal.recover(v))throw Error('原请求有待本地回放正文，未另发新请求');
   if(['received','saved'].includes(request.status)||request.receivedFile||request.responseFile)throw Error('原请求声明的已返回响应缺失，未另发新请求');
  }
  queryFiles.push({file:path.relative(dir,file),hash:require('./update-progress').token(file)});queries.push(v);
 }
 // New attempts require their captured worker generation. A raw, fully settled
 // native journal supplies only the ended-task fact for pre-binding versions.
 const legacy=!round.worker&&!service?legacyFinalization(base,round,q):null;
 const closed=round.worker?(ended(round.worker)?'worker-ended':null):service?'complete-service-response':legacy?'legacy-native-finalized':null;
 if(!closed||service&&!queryFiles.length||legacy&&queryFiles.length>1)return null;
 const absent=queryFiles.length?null:missingRequest(dir,round,q,journal,lowerForMissing);
 if(!queryFiles.length&&!absent)return null;
 return {kind:q.kind,roundId:round.id,requestId:q.id,at:q.at,code:service?'IP_GEO_DENIED':'AUTO_OUTCOME_UNKNOWN',requestHash:G.digest(q),round:{id:round.id,uid:round.uid,targetKind:K.kind(round),source:round.source||'cli',status:round.status,finishedAt:round.finishedAt,worker:round.worker||null},queryFiles,queries,closure:closed,...(absent?{missingRequest:absent}:{}),...(legacy?{legacyFinalization:legacy}:{}),...(service?{serviceReceipt:service.receipt}:{})};
}
function ownAttempt(base,dir,round,q,job,{activeReservationId,activeQuery,unitPrice,journal=J.proofReader(dir)}={}){
 const ref=q.automaticRecovery,plan=job?.automaticRecovery;
 if(round.id!==job?.id||!ref||ref.planId!==plan?.id||ref.policy!==POLICY||ref.pendingToken!==plan.pendingTokens?.[q.kind]||ref.proofToken!==plan.proofTokens?.[q.kind]||ref.windowId!==job.id&&!ref.initial)return false;
 if(unitPrice!=null&&(q.unitPrice!==unitPrice||q.reservedCredits!==Number((q.count*unitPrice).toFixed(6))))throw Error('当前恢复预留与本轮已核实单价不一致');
 const files=journal.subscriptionRequests(round.id,q.id);if(files.length!==1)return false;
 const request=read(files[0]),query=request.query;
 if(request.billingReservation?.roundId!==round.id||request.billingReservation?.id!==q.id||query?.taskId!==ref.taskId||query.uid!==job.uid||query.kind!==q.kind||query.count!==q.count||query.maxId!==(q.maxId||'')||query.sinceId!==(q.sinceId||'')||query.page!==(q.page||1))throw Error('当前恢复请求与原预留或观测范围不匹配');
 if(require('./subscription-response-proof').complete(q)){
  require('./subscription-response-proof').verifyComplete(base,dir,round,q,{journal,currentRoundId:job.id});
  const file=require('../desktop/follow-response-evidence').verify(base,dir,q);
  if(![files[0].replace(/\.request\.json$/,'.response.json'),files[0].replace(/\.request\.json$/,'.received.json')].includes(path.resolve(file)))throw Error('当前恢复响应不属于其原预留');
  return true;
 }
 return q.status==='reserved'&&q.id===activeReservationId&&request.status==='inflight'&&G.digest(query)===G.digest(activeQuery)&&!fs.existsSync(files[0].replace(/\.request\.json$/,'.received.json'))&&!fs.existsSync(files[0].replace(/\.request\.json$/,'.response.json'));
}
function verifyCurrentObservation(base,dir,job,kind,window,options){
 const pending=window.pending,ref=window.latestObservation;
 const first=pending.packets[0];
 const invalid=()=>B.safety('REQUEST_EVIDENCE_INVALID','本轮最新记录与原始请求不一致，已停止续读');
 if(!first){
  if(ref||pending.cursor||pending.head!==window.anchor)throw invalid();
  return;
 }
 if(!pending.since||ref&&(first.file!==ref.file||first.hash!==ref.hash))throw invalid();
 const {query,raw,billingReservation}=J.verifySavedResponse(dir,first);
 if(query.taskId!==pending.id||query.uid!==job.uid||query.kind!==kind||query.page!==1||
    query.maxId!==''||query.sinceId!==window.anchor||query.count!==1||billingReservation?.roundId!==job.id)throw invalid();
 const core=require('./core'),items=core.rawArray(raw,kind)?.items;
 const round=B.read(B.roundFile(base,job.id));
 const request=round?.requests.find(q=>q.id===billingReservation.id);
 if(!items||items.length>1||!request||request.returned!==items.length||
    request.automaticRecovery?.windowId!==job.id||!ownAttempt(base,dir,round,request,job,options))throw invalid();
 const item=items[0];
 const complete=item&&require('./record-body').completeBody(core.normalize(item,kind,job.uid),item);
 // An empty or incomplete first row has no leading observation, even when
 // a later page contains bodies. A complete first row must keep its receipt.
 if(!complete){
  if(ref)throw invalid();
  return;
 }
 if(!ref||require('./history').historyRecordId(item)!==pending.head||BigInt(pending.head)<=BigInt(window.anchor))throw invalid();
}
function scan(base,e,dir,kind,options={}){
 const facts=[],preserved=[],excluded=new Set(),response=require('./subscription-response-proof');let eligible=0;
 // Do not carry this locator or any validated choice into a later reserve or
 // pre-wire validation. Each invocation starts again from current raw files.
 const ledger=B.ledger(base),journal=J.proofReader(dir),choices=G.futureChoiceReader(base,dir,e.uid,kind,{journal});
 const job=options.currentJob;
 const activeWindow=job&&options.windowId===job.id?
  {id:job.id,verify:window=>verifyCurrentObservation(base,dir,job,kind,window,{...options,journal})}:null;
 // Only share a lower bound within this synchronous scan. Reservation and
 // dispatch each verify the raw evidence again, including the current probe.
 let lower;
 const lowerForMissing=()=>{
  if(lower===undefined)lower=require('./subscription-latest').safeLower(dir,kind,e.uid,activeWindow);
  return lower;
 };
 const openingPending=G.pendingRequests(base,e.uid,kind,K.kind(e),{ledger});
 for(const file of ledger.pendingFiles(e.uid,K.kind(e),'cli')){
  const round=read(file);if(!K.matches(e,round)||(round.source||'cli')!=='cli')throw Error('原订阅范围已变化');
  for(const q of round.requests||[]){
   if(q.kind!==kind||!['reserved','unknown'].includes(q.status))continue;
   if(options.currentJob&&ownAttempt(base,dir,round,q,options.currentJob,{...options,journal})){excluded.add(round.id+':'+q.id);continue;}
   if(response.complete(q)){
    const positionProof=response.verifyPendingResponse(base,dir,round,q,{journal});
    preserved.push({roundId:round.id,requestId:q.id,requestHash:G.digest(q),responseHash:q.hash,...(positionProof?{positionProof}:{})});
    continue;
   }
   const service=require('./subscription-service-proof').rejection(base,dir,round,q,{journal});
   const value=fact(base,dir,round,q,{service,journal,lowerForMissing});
   if(value){facts.push(value);eligible++;continue;}
   const choice=choices.unknown(round.id,q.id);
   if(choice){preserved.push({roundId:round.id,requestId:q.id,requestHash:G.digest(q),decisionId:choice.decisionId,choiceHash:choice.choiceHash});continue;}
   throw B.safety('AUTO_OUTCOME_UNKNOWN','旧任务仍在运行或结束证据不足；原请求、费用及续取位置保留');
  }
 }
 const token=values=>G.digest(values.filter(v=>!excluded.has(v.roundId+':'+v.requestId)).map(v=>({identity:v.identity,request:v.request})));
 // Other owners and processes can settle or add ledger rounds. Confirm the
 // exact pending set against a fresh strict manifest before using this proof.
 const pendingToken=token(G.pendingRequests(base,e.uid,kind,K.kind(e)));
 if(pendingToken!==token(openingPending))throw B.safety('AUTO_OUTCOME_UNKNOWN','原未确认请求在核对期间变化，未发起请求');
 choices.assertUnchanged();
 journal.assertUnchanged();
 return {facts,eligible,proofToken:G.digest({facts,preserved}),pendingToken};
}
function eligible(base,e,dir,round,q,options){if(!enabled(base,e))return null;return fact(base,dir,round,q,options);}
function plan(base,e,dir,checked,kinds,{now=Date.now}={}){
 if(!enabled(base,e))return null;
 const selected=[...new Set(kinds)].filter(k=>checked.recoveryKinds?.includes(k)&&!checked.blockedKinds.includes(k)),proofTokens={},pendingTokens={},counts={},notBefore={};
 for(const kind of selected){const value=scan(base,e,dir,kind);if(!value.eligible)continue;proofTokens[kind]=value.proofToken;pendingTokens[kind]=value.pendingToken;counts[kind]=value.eligible;const deadline=Date.parse(e.directionRetry?.[kind]?.nextRetryAt);notBefore[kind]=new Date(Number.isFinite(deadline)?deadline:now()).toISOString();}
 const active=Object.keys(proofTokens);if(!active.length)return null;
 return {schema:1,policy:POLICY,id:crypto.randomUUID(),workspace:fs.realpathSync(base),...binding(e),bindingHash:G.digest(binding(e)),kinds:active,createdAt:new Date(now()).toISOString(),notBefore,proofTokens,pendingTokens,counts};
}
function validatePlan(base,dir,job,kind,{now=Date.now,activeReservationId,activeQuery,unitPrice,windowId}={}){
 const p=job.automaticRecovery;
 const deadline=Date.parse(p?.notBefore?.[kind]);
 if(p?.schema!==1||p.policy!==POLICY||!uuid(p.id)||p.workspace!==fs.realpathSync(base)||p.uid!==job.uid||p.targetKind!==K.kind(job)||p.source!=='cli'||!Array.isArray(p.kinds)||!p.kinds.includes(kind)||!job.kinds.includes(kind)||p.bindingHash!==G.digest(binding(job))||!enabled(base,{...job,enabled:true})||!Number.isFinite(deadline)||now()<deadline)throw B.safety('AUTO_OUTCOME_UNKNOWN','持续订阅恢复计划或用户启用意图已变化，未发起请求');
 const current=scan(base,{...job,enabled:true},dir,kind,{currentJob:job,activeReservationId,activeQuery,unitPrice,windowId});
 if(!current.eligible||current.proofToken!==p.proofTokens[kind]||current.pendingToken!==p.pendingTokens[kind])throw B.safety('AUTO_OUTCOME_UNKNOWN','原未确认集合、正文或结束证明已变化，等待下轮重新核对');
 if(!enabled(base,{...job,enabled:true}))throw B.safety('AUTO_OUTCOME_UNKNOWN','订阅启用意图在核对期间变化，未发起请求');
 return {plan:p,current};
}
function validate(base,dir,job,kind,context,options){
 const valid=validatePlan(base,dir,job,kind,{...options,windowId:context?.windowId});
 const missing=valid.current.facts.filter(f=>f.missingRequest);
 if(missing.length&&context?.windowId!==job.id)throw B.safety('AUTO_OUTCOME_UNKNOWN','缺少原请求文件的预留只允许使用独立观测窗口');
 if(kind==='post-comments'&&context?.windowId===''&&!I.readState(dir,kind,job.uid)){
  const file=path.join(dir,'cache/updates/post-subscription-initial',job.id+'.json'),journal=read(file);
  if(journal.schema!==1||journal.postId!==(job.postId||job.uid)||journal.taskId!==context.taskId||!uuid(context.taskId))throw B.safety('AUTO_OUTCOME_UNKNOWN','博文初始化缺少本轮独立原任务证明');
  return {...valid,initial:true,journal:{...journal,cursor:''}};
 }
 if(context?.windowId===''&&job.initialBaselines?.[kind]){
  const baseline=job.initialBaselines[kind],file=require('./data-update').progressFile(dir,kind,{taskScopeId:job.id}),journal=read(file);
  if(!uuid(context.taskId)||journal.id!==context.taskId||journal.uid!==job.uid||journal.kind!==kind||journal.anchor!==''||journal.checkpointToken!==baseline.checkpointToken||!journal.ownerScopes?.includes(job.id)||journal.scope?.from||journal.scope?.to)throw B.safety('AUTO_OUTCOME_UNKNOWN','新初始化请求缺少独立且固定范围的原任务证明');
  return {...valid,initial:true,journal};
 }
 if(context?.windowId!==job.id||!uuid(context.taskId))throw B.safety('AUTO_OUTCOME_UNKNOWN','新请求缺少独立订阅观测范围，未复用旧在途请求');
 const window=require('./subscription-latest').validateWindow(dir,kind,job.uid,context);
 if(missing.some(f=>BigInt(window.anchor)<BigInt(f.missingRequest.lower)))throw B.safety('AUTO_OUTCOME_UNKNOWN','独立观测早于当前已核实的检查点，未发起请求');
 return {...valid,window};
}
module.exports={POLICY,binding,enabled,ended,fact,eligible,scan,plan,validatePlan,validate};
