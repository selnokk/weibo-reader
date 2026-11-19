'use strict';
// Shared read-only validation of an original subscription response and reservation.
const fs=require('node:fs'),path=require('node:path');
function complete(q){return Number.isSafeInteger(q.returned)&&q.returned>=0&&typeof q.file==='string'&&/^[a-f0-9]{64}$/.test(q.hash||'');}
function historicalPosition(base,dir,round,q,packet,proof){
 const C=require('./subscription-continuous'),{digest}=require('./gap-choice-proof'),plan=round.automaticRecovery,ref=q.automaticRecovery,kind=q.kind;
 const invalid=()=>Error('费用待核对的空记录与原订阅窗口不一致');
 if(!['complete','partial','failed','cancelled','interrupted'].includes(round.status)||!Number.isFinite(Date.parse(round.finishedAt))||
    round.source!=='cli'||round.targetKind!=='user'||!round.kinds?.includes(kind)||
    !plan||!ref||plan.schema!==1||plan.policy!==C.POLICY||ref.policy!==plan.policy||ref.planId!==plan.id||
    !plan.kinds?.includes(kind)||plan.workspace!==fs.realpathSync(base)||plan.uid!==round.uid||
    plan.targetKind!=='user'||plan.source!=='cli'||plan.bindingHash!==digest(C.binding(round))||
    ref.initial||ref.windowId!==round.id||ref.taskId!==proof.query.taskId||
    !['pendingTokens','proofTokens'].every(key=>/^[a-f0-9]{64}$/.test(plan[key]?.[kind]||''))||
    ref.pendingToken!==plan.pendingTokens[kind]||ref.proofToken!==plan.proofTokens[kind])throw invalid();
 if(q.actualCredits!=null||!Number.isFinite(q.unitPrice)||q.unitPrice<0||!require('./core').unverifiedBilling(proof.raw)||!C.ended(round.worker)||
    q.reservedCredits!==Number((q.count*q.unitPrice).toFixed(6))||q.estimatedCredits!==Number((q.returned*q.unitPrice).toFixed(6)))throw invalid();
 const window=require('./subscription-latest').windowState(dir,kind,round.uid,round.id);
 if(window?.origin!=='subscription-observation-window'||!q.sinceId||window.seed?.id!==q.sinceId)throw invalid();
 const chain=[window.pending,window.unverifiedObservation,window.connectedProof].find(chain=>
  chain?.id===ref.taskId&&(chain.lower??window.anchor)===q.sinceId&&Array.isArray(chain.packets)&&chain.packets.some(p=>
   p.file===packet.file&&p.hash===packet.hash&&p.maxId===q.maxId&&p.sinceId===q.sinceId&&p.count===q.count));
 if(!chain)throw invalid();
 return digest({plan,windowId:ref.windowId,seed:window.seed,taskId:ref.taskId,packet,received:proof.received});
}
function verifyResponse(base,dir,round,q,{journal=require('./request-journal').proofReader(dir),currentRoundId,historical=false}={}){
 const C=require('./core');
 const file=require('../desktop/follow-response-evidence').verify(base,dir,q),root=fs.realpathSync(path.join(dir,'cache'));
 if(!fs.realpathSync(file).startsWith(root+path.sep))throw Error('响应不属于原对象');
 const box=JSON.parse(require('./regular-file').read(file)),query=box.query;
 let raw,currentReceipt;
 if(query){
  if(box.schema!==1||query.uid!==round.uid||query.kind!==q.kind||query.count!==q.count||(query.maxId||'')!==(q.maxId||'')||(query.sinceId||'')!==(q.sinceId||'')||query.page!==(q.page||1)||!query.taskId)throw Error('响应请求边界不匹配');
  const requests=journal.subscriptionRequests(round.id,q.id);
  if(!requests.some(requestFile=>{const r=JSON.parse(require('./regular-file').read(requestFile,{maxBytes:65536}));return r.billingReservation?.roundId===round.id&&r.billingReservation?.id===q.id&&JSON.stringify(r.query)===JSON.stringify(query);} ))throw Error('缺少原预留与请求关联');
  const recovered=journal.recover(query);if(!recovered)throw Error('原响应恢复关联缺失');
  const active=currentRoundId&&currentRoundId===round.id&&round.status==='running'&&['estimated','unknown'].includes(q.status);
  if((active||historical&&q.status==='unknown')&&requests.length===1&&recovered.receipt&&
     path.resolve(recovered.file)===file.replace(/\.received\.json$/,'.response.json'))currentReceipt=recovered.receipt;
  if(typeof box.responseText==='string'){
   if(box.billingReservation?.roundId!==round.id||box.billingReservation?.id!==q.id)throw Error('接收响应不属于原预算预留');
   raw=JSON.parse(box.responseText);
  }else raw=box.response;
 }else{
  // Legacy plain JSON is accepted only in its exact typed-owner request slot.
  const expected=require('./storage').cacheFile(dir,q.kind,q.count,q.maxId||'',q.sinceId||'',q.page||1);
  if(file!==expected&&file!==expected.replace(/\.json$/,'_legacy_'+q.hash.slice(0,16)+'.json'))throw Error('旧响应缺少原请求槽关联');
  raw=box;
 }
 const items=C.rawArray(raw,q.kind)?.items;
 if(!items||C.apiError(raw)||items.length!==q.returned||items.length>q.count)throw Error('原返回条数或执行结果无法核实');
 let authorless=false;
 for(const item of items){
  const row=C.normalize(item,q.kind,round.uid);
  if(!row.recordId||q.sinceId&&BigInt(row.recordId)<=BigInt(q.sinceId)||q.maxId&&BigInt(row.recordId)>BigInt(q.maxId))throw Error('原响应身份或返回范围不一致');
  if(q.kind!=='sent'||row.authorUid===round.uid)continue;
  // A billed position can lack both author and body. Only its own current
  // receipt proves that position was returned. It cannot identify an author.
  const author=item.user;
  const noAuthorId=author==null||typeof author==='object'&&!Array.isArray(author)&&[author.idstr,author.id,author.uid].every(id=>id==null||id==='');
  if(!currentReceipt||!noAuthorId||row.content.trim()||require('./record-quality').media(row))throw Error('原响应身份或返回范围不一致');
  authorless=true;
 }
 if(authorless){
  const proof=require('./request-journal').verifySavedResponse(dir,currentReceipt);
  if(!proof.received||proof.billingReservation?.id!==q.id||proof.billingReservation.roundId!==round.id)throw Error('当前请求的原始返回或预留关联缺失');
  if(historical)return historicalPosition(base,dir,round,q,currentReceipt,proof);
 }
 if(q.kind==='post-comments')require('./post-comments').postPageRows(raw,round.uid);
 return null;
}
function verifyComplete(base,dir,round,q,{journal,currentRoundId}={}){verifyResponse(base,dir,round,q,{journal,currentRoundId});return true;}
// Only automatic checks may preserve a prior exact billed position. This
// authorizes no settlement, body, successful checkpoint or historical replay.
function verifyPendingResponse(base,dir,round,q,{journal}={}){return verifyResponse(base,dir,round,q,{journal,historical:true});}
function ownComplete(base,dir,job,round,q){
 if(round.id!==job.id||round.uid!==job.uid||require('./subscription-key').kind(round)!==require('./subscription-key').kind(job)||(round.source||'cli')!==(job.source||'cli')||!['estimated','unknown'].includes(q.status)||!complete(q))return false;
 verifyComplete(base,dir,round,q,{currentRoundId:job.id});
 const J=require('./request-journal'),files=J.subscriptionRequests(dir,round.id,q.id);if(files.length!==1)throw Error('当前请求的原预留关联不唯一');
 const request=JSON.parse(require('./regular-file').read(files[0])),file=require('../desktop/follow-response-evidence').verify(base,dir,q);
 if(request.billingReservation?.roundId!==job.id||request.billingReservation?.id!==q.id||!['.response.json','.received.json'].some(suffix=>files[0].replace(/\.request\.json$/,suffix)===path.resolve(file)))throw Error('当前请求的完整正文不属于其原预留');
 return true;
}
function pendingTokenForJob(base,dir,job,kind,{activeReservationId}={}){
 const G=require('./gap-choice-proof'),B=require('./auto-follow-budget'),values=G.pendingRequests(base,job.uid,kind,require('./subscription-key').kind(job)),kept=[];
 for(const v of values){
  if(v.roundId===job.id&&v.requestId===activeReservationId&&v.request.status==='reserved')continue;
  const round=B.read(B.roundFile(base,v.roundId));
  if(v.roundId===job.id&&ownComplete(base,dir,job,round,v.request))continue;
  if(complete(v.request))verifyPendingResponse(base,dir,round,v.request);
  kept.push({identity:v.identity,request:v.request});
 }
 return G.digest(kept);
}
module.exports={complete,verifyComplete,verifyPendingResponse,ownComplete,pendingTokenForJob};
