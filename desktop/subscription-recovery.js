'use strict';
// Recovery decisions use durable request facts, never error-message matching.
// This module performs local replay only; it cannot start a network request.
const fs=require('node:fs'),path=require('node:path');
const B=require('../lib/auto-follow-budget'),K=require('../lib/subscription-key');
function delay(attempt,random=Math.random){return Math.round(Math.min(15*60000,30000*2**Math.min(6,Math.max(0,attempt-1)))*(1+Math.max(0,Math.min(1,random()))*.2));}
const retryMinutes=require('./follow-frequency').steps;
const ordinaryCodes=new Set(['AUTO_RETRY','AUTO_START_FAILED','AUTO_REQUEST_FAILED']);
function delayAt(steps,attempt){return 60000*steps[Math.min(steps.length-1,Math.max(0,attempt-1))];}
function retryDelay(attempt){return delayAt(retryMinutes,attempt);}
function ordinaryFailure(code){return ordinaryCodes.has(code);}
function waiting(e,round,at,{code='AUTO_RETRY',local=false,random=Math.random,ordinaryAttempts=0,notBefore=0}={}){
 const attempts=(e.recovery?.attempts||0)+1;
 e.recovery={schema:1,roundId:round.id,source:round.source||'cli',code,attempts,lastAttemptAt:new Date(at).toISOString(),localOnly:local};
 e.status=local?'attention-required':'retry-wait';e.pauseCode=code;
 const backoff=retryDelay(attempts);
 const retryAt=at+backoff;
 e.nextCheckAt=e.enabled?new Date(Math.max(retryAt,notBefore,Number(e.restUntil)||0)).toISOString():null;
 e.reason=local?'正在核对原请求与本地保存证据；安全条件恢复后自动继续，未决请求不会重复发送':'本轮检查未完成；已保留订阅，稍后自动重试';
}
const {complete,verifyComplete,verifyPendingResponse}=require('../lib/subscription-response-proof');
function replay(base,dir,round,q,journal,invalidate){
 const J=require('../lib/request-journal'),root=J.folder(dir);
 if(!fs.existsSync(root))return false;
 for(const requestFile of journal.subscriptionRequests(round.id,q.id)){
  const name=path.basename(requestFile),request=JSON.parse(require('../lib/regular-file').read(requestFile,{maxBytes:65536}));
  if(request.billingReservation?.roundId!==round.id||request.billingReservation?.id!==q.id)continue;
  const query=request.query;
  if(request.schema!==1||query?.uid!==round.uid||query.kind!==q.kind||query.count!==q.count||(query.maxId||'')!==(q.maxId||'')||(query.sinceId||'')!==(q.sinceId||'')||!query.taskId)throw Error('原预算预留与恢复请求身份不一致');
  if(request.status==='not-sent'){
   journal.assertUnchanged();
   invalidate();
   B.createBudget(base,round.id).notSent(q.id,{file:path.relative(dir,requestFile),hash:require('../lib/update-progress').token(requestFile),queryHash:request.notSent?.queryHash,billingReservation:request.billingReservation});return true;
  }
  const recovered=journal.recover(query);if(!recovered)return false;
  if(![requestFile.replace(/\.request\.json$/,'.response.json'),requestFile.replace(/\.request\.json$/,'.received.json')].includes(path.resolve(recovered.file)))throw Error('恢复响应不属于原请求收据');
  // Both getOne's offline flag and the checked receipt prohibit wire fallback.
  journal.assertUnchanged();
  invalidate();
  require('../lib/storage').getOne({uid:query.uid,...(query.kind==='post-comments'?{postId:query.uid}:{}),offline:true,refresh:true,dataTaskId:query.taskId,postPage:query.page},dir,query.kind,query.count,query.maxId,query.sinceId);
  const receivedFile=path.join(root,name.replace(/\.request\.json$/,'.received.json'));
  if(fs.existsSync(receivedFile)){
   const bytes=require('../lib/regular-file').read(receivedFile),box=JSON.parse(bytes),hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
   if(JSON.stringify(box.query)!==JSON.stringify(query)||box.billingReservation?.roundId!==round.id||box.billingReservation?.id!==q.id)throw Error('原响应与预留关联不一致');
   J.settleReceived(dir,{query,billingReservation:box.billingReservation,received:{file:receivedFile,hash}},JSON.parse(box.responseText));
  }
  return complete(B.read(B.roundFile(base,round.id)).requests.find(x=>x.id===q.id));
 }
 return false;
}
function inspectWork(base,entry,dir,excludeKinds){
 // Validate the complete ledger before its filtered projection is used.
 const initialLedger=B.ledger(base),J=require('../lib/request-journal'),G=require('../lib/gap-choice-proof'),S=require('../lib/subscription-service-proof');
 const journal=J.proofReader(dir),restoration=S.restorationReader(base,dir,entry,journal),choices=new Map(),lowers=new Map();
 let ledger=initialLedger;
 // Local replay can change the pending set, journal files, or the available
 // proof. Drop the scoped projections before attempting any such write.
 function invalidate(){journal.invalidate();restoration.invalidate();choices.clear();lowers.clear();ledger=null;}
 function futureChoice(kind,roundId,requestId){
  if(!choices.has(kind))choices.set(kind,G.futureChoiceReader(base,dir,entry.uid,kind,{journal}));
  return choices.get(kind).unknown(roundId,requestId);
 }
 function lowerFor(kind){
  if(!lowers.has(kind))lowers.set(kind,require('../lib/subscription-latest').safeLower(dir,kind,entry.uid));
  return lowers.get(kind);
 }
 const blocked=new Set(),recovered=[],ranges=[],serviceBlocks=[],unknownKinds=new Set(),unknownBlocks=[],recoveryKinds=new Set();
 function recordUnknown(round,q,service){
  const value=require('../lib/subscription-continuous').eligible(base,entry,dir,round,q,{service,journal});
  if(!service)unknownKinds.add(q.kind);
  if(unknownBlocks.length<128)unknownBlocks.push({kind:q.kind,roundId:round.id,requestId:q.id,at:q.at,code:service?'IP_GEO_DENIED':'AUTO_OUTCOME_UNKNOWN',retryEligible:!!value});
  if(value)recoveryKinds.add(q.kind);return !!value;
 }
 for(const file of initialLedger.pendingFiles(entry.uid,K.kind(entry),entry.source||'cli')){
  const round=B.read(file);if(!K.matches(entry,round)||(entry.source||'cli')!==(round.source||'cli'))throw Error('原任务身份已变化，未放行自动请求');
  for(const q of round.requests||[]){
   if(excludeKinds.has(q.kind)||!['reserved','unknown'].includes(q.status))continue;
   try{
    if(complete(q))verifyPendingResponse(base,dir,round,q,{journal});
    else{
     const rejection=S.rejection(base,dir,round,q,{journal});
     if(rejection){
      const restored=restoration.restored(rejection),grant=!restored&&S.granted(base,dir,entry,rejection);
      if(restored||grant)ranges.push({roundId:round.id,requestId:q.id,kind:q.kind,maxId:q.maxId||'',sinceId:q.sinceId||'',serviceRejection:rejection,...(restored?{serviceRestored:restored}:{serviceGrantId:grant.id})});
      else{serviceBlocks.push(rejection);if(!recordUnknown(round,q,rejection))blocked.add(q.kind||'*');}
      continue;
     }
     if(replay(base,dir,round,q,journal,invalidate)){recovered.push({roundId:round.id,requestId:q.id});continue;}
     const boundRequest=journal.subscriptionRequests(round.id,q.id).length>0;
     if(!boundRequest)journal.assertNoUnboundResponse(round.id,q.id,round.uid,q.kind);
     const lower=boundRequest&&q.maxId&&/^[1-9]\d*$/.test(q.maxId)?lowerFor(q.kind):null;
     if(lower&&BigInt(lower)>=BigInt(q.maxId))ranges.push({roundId:round.id,requestId:q.id,kind:q.kind,maxId:q.maxId,sinceId:q.sinceId||''});
     else{
      const chosen=futureChoice(q.kind,round.id,q.id);
      if(chosen)ranges.push({roundId:round.id,requestId:q.id,kind:q.kind,maxId:q.maxId||'',sinceId:q.sinceId||'',decisionId:chosen.decisionId,choiceHash:chosen.choiceHash,futureLower:chosen.head});
      else if(!recordUnknown(round,q))blocked.add(q.kind||'*');
     }
    }
   }catch{blocked.add(q.kind||'*');unknownKinds.add(q.kind||'*');if(unknownBlocks.length<128)unknownBlocks.push({kind:q.kind||'*',roundId:round.id,requestId:q.id,code:'REQUEST_EVIDENCE_INVALID',retryEligible:false});}
  }
 }
 for(const kind of new Set(ranges.filter(r=>r.decisionId||r.serviceRejection).map(r=>r.kind))){ledger??=B.ledger(base);const pendingToken=G.pendingToken(base,entry.uid,kind,K.kind(entry),{ledger});for(const ref of ranges)if(ref.kind===kind&&(ref.decisionId||ref.serviceRejection))ref.pendingToken=pendingToken;}
 for(const reader of choices.values())reader.assertUnchanged();
 restoration.assertUnchanged();
 journal.assertUnchanged();
 return {blockedKinds:[...blocked],unresolvedRanges:ranges,recovered,serviceBlocks,unknownKinds:[...unknownKinds],unknownBlocks,recoveryKinds:[...recoveryKinds]};
}
function inspect(base,entry,dir,{excludeKinds=[]}={}){const access=require('../lib/workspace-access'),release=access.enter(base);let object;try{object=access.enterObject(base,K.kind(entry),entry.uid);return inspectWork(base,entry,dir,new Set(excludeKinds));}finally{object?.();release();}}
module.exports={retryDelay,ordinaryFailure,waiting,complete,verifyComplete,inspect,serviceRetryGrant:(base,entry,dir)=>require('../lib/subscription-service-proof').grant(base,entry,dir),automaticRecovery:(base,entry,dir,checked,kinds,options)=>require('../lib/subscription-continuous').plan(base,entry,dir,checked,kinds,options)};
