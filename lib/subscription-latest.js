'use strict';
// Latest-window protection uses the existing bounded incremental collector and
// request journal. These separate window files are NEVER global checkpoints.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('./core'),P=require('./update-progress');
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
function controlFile(dir,kind){return path.join(dir,'cache/updates/subscription-windows',kind,'monitor.json');}
function readControl(dir,kind,uid){
 const file=controlFile(dir,kind);if(!fs.existsSync(file))return {schema:1,uid,kind,windows:[]};
 const value=JSON.parse(require('./regular-file').read(file));
 if(value.schema!==1||value.uid!==uid||value.kind!==kind||!Array.isArray(value.windows)||value.windows.some(id=>!uuid(id)))throw Object.assign(Error('订阅观测证据身份无效，原文件保留'),{code:'REQUEST_EVIDENCE_INVALID'});
 return value;
}
function leading(dir,kind,uid,ref){
 if(!ref)return null;
 let packet,box;
 try{packet=require('./incremental').restorePacket(ref,dir);box=JSON.parse(require('./regular-file').read(packet.file));}
 catch(cause){throw Object.assign(Error('最新观测的原始响应无法核实'),{code:'REQUEST_EVIDENCE_INVALID',cause});}
 const q=box.query;
 if(box.schema!==1||q?.uid!==uid||q.kind!==kind||q.maxId!==''||q.page!==1||!uuid(q.taskId)||C.apiError(packet.raw))throw Object.assign(Error('最新观测未绑定原对象和请求'),{code:'REQUEST_EVIDENCE_INVALID'});
 if(kind==='post-comments')require('./post-comments').postPageRows(packet.raw,uid);
 const first=C.rawArray(packet.raw,kind)?.items[0];if(!first)return null;
 const row=C.normalize(first,kind,uid);if(!require('./record-body').completeBody(row,first)||kind==='sent'&&row.authorUid!==uid||q.sinceId&&(!/^\d+$/.test(q.sinceId)||BigInt(row.recordId)<=BigInt(q.sinceId)))return null;
 return {id:row.recordId,ref};
}
function proofFor(dir,kind,state,windowId=''){
 if(state?.connectedProof)return state.connectedProof;
 const ref=state?.connection;if(!ref)return null;
 if(!/^update-connections\/[a-f0-9-]{36}\.json$/.test(ref.file||'')||! /^[a-f0-9]{64}$/.test(ref.hash||''))throw Error('订阅连接证据索引无效');
 const root=path.dirname(path.dirname(require('./incremental').stateFile(dir,kind,windowId))),entry=require('./file-view-cache').fileView(path.join(root,ref.file),'subscription-proof-v1',(proof,meta)=>({proof,hash:meta.hash()}));
 if(entry.hash!==ref.hash)throw Error('订阅连接证据已变化');
 const proof=entry.proof;if(proof.schema!==1||proof.uid!==state.uid||proof.kind!==kind)throw Error('订阅连接证据归属不匹配');
 // An explicit future head retains the earlier connected chain as history. It
 // does not turn that older chain into a proof for the newly selected head.
 if(proof.upper!==state.anchor){if(state.baselineScope==='user-selected-latest-head'&&state.userSelectedHead?.head===state.anchor&&require('./completeness').exactId(proof.upper)&&BigInt(proof.upper)<BigInt(state.anchor))return null;throw Error('订阅连接证据归属不匹配');}return proof;
}
function windowState(dir,kind,uid,id){const I=require('./incremental'),file=I.stateFile(dir,kind,id);if(!fs.existsSync(file))return null;const state=require('./file-view-cache').fileView(file,'subscription-window-v1',()=>I.readState(dir,kind,uid,{windowId:id}));if(state.uid!==uid||state.kind!==kind)throw Error('订阅观测身份不匹配');return {...state,connectedProof:proofFor(dir,kind,state,id)};}
function refs(state){return state?.pending?.packets||state?.connectedProof?.packets||[];}
function initialPoint(head,taskId){return {id:head.id,ref:head.ref,initialPrefix:{taskId,packets:head.packets}};}
function proofLeading(dir,kind,uid,proof){
 const point=leading(dir,kind,uid,proof?.packets?.[0]);
 if(point||!proof?.initial)return point;
 const head=require('./subscription-baseline').initialSavedHead(dir,kind,uid,proof.packets,proof.id);
 return head?initialPoint(head,proof.id):null;
}
function emptyReceipt(dir,kind,uid,head,taskId,ref,maxId){
 const invalid=()=>Object.assign(Error('原空页未绑定已核实的检查点和请求，原证据保留'),{code:'REQUEST_EVIDENCE_INVALID'});
 if(!uuid(taskId)||ref?.sinceId!==head||ref.maxId!==maxId||!Number.isSafeInteger(ref.count)||ref.count<1||ref.count>200)throw invalid();
 const {query,raw}=require('./request-journal').verifySavedResponse(dir,ref),parsed=C.rawArray(raw,kind);
 if(query.uid!==uid||query.kind!==kind||query.taskId!==taskId||query.count!==ref.count||query.sinceId!==head||query.maxId!==maxId||query.page!==1||C.apiError(raw)||parsed?.items.length!==0)throw invalid();
 try{
  if(kind==='post-comments')for(const box of [raw,raw.data,parsed.container])for(const value of [box?.status,box?.weibo]){const id=C.reliableId('原微博 ID',value?.idstr,value?.id,value?.mid);if(id&&id!==uid)throw invalid();}
  return require('./history').historyNext(raw,kind);
 }catch(cause){throw Object.assign(invalid(),{cause});}
}
function emptyHead(dir,kind,uid,state){
 if(!['sent','received','post-comments'].includes(kind)||state?.uid!==uid||state.kind!==kind||!state.connection||!Number.isFinite(Date.parse(state.checkedAt))||state.endPolicyVersion!==2||state.sinceDisabled||state.pending&&(state.pending.head!==state.anchor||!state.pending.since))return null;
 const head=state.anchor;
 if(!head||require('./completeness').exactId(head)!==head)return null;
 let proof;try{require('./workspace-access').directory(dir,'cache/update-connections');proof=proofFor(dir,kind,{...state,connectedProof:null});}catch(cause){throw Object.assign(Error('原检查点连接证据无法核实，原文件保留'),{code:'REQUEST_EVIDENCE_INVALID',cause});}
 const ref=proof?.packets?.[0];
 if(proof?.initial||proof?.lower!==head||proof.upper!==head||!uuid(proof.id)||proof.packets?.length!==1||ref?.sinceId!==head||ref.maxId!==''||!Number.isSafeInteger(ref.count)||ref.count<1||ref.count>200)return null;
 if(emptyReceipt(dir,kind,uid,head,proof.id,ref,'')!=='0')throw Object.assign(Error('原空页未核实终止位置，原证据保留'),{code:'REQUEST_EVIDENCE_INVALID'});
 const pending=state.pending,chain=pending?.packets||[];
 let cursor='';for(const packet of chain){if(C.rawArray(require('./incremental').restorePacket(packet,dir).raw,kind)?.items.length)return null;const next=emptyReceipt(dir,kind,uid,head,pending.id,packet,cursor);if(!next||BigInt(next)<=BigInt(head)||cursor&&BigInt(next)>=BigInt(cursor))throw Object.assign(Error('待续空页的游标不能证明前进，原证据保留'),{code:'REQUEST_EVIDENCE_INVALID'});cursor=next;}
 if(chain.length&&cursor!==pending.cursor)throw Object.assign(Error('待续空页与原续取位置不一致，原证据保留'),{code:'REQUEST_EVIDENCE_INVALID'});
 // A terminal empty receipt preserves the established lower bound. It does
 // not promote the old pending chain or supply a new leading record.
 return {id:head,ref,emptyConnection:state.connection,emptyPending:chain.length?require('./gap-choice-proof').digest({id:pending.id,cursor,chain}):null};
}
function validateWindowSeed(dir,kind,uid,window){
 const seed=window.seed;
 if(!seed||seed.id!==window.anchor||typeof seed.ref?.file!=='string'||!/^[a-f0-9]{64}$/.test(seed.ref.hash||''))return false;
 if(seed.boundaryToken){
  const I=require('./incremental'),file=I.stateFile(dir,kind);
  if(P.token(file)!==seed.boundaryToken)return false;
  const current=boundarySeed(dir,kind,uid,I.readState(dir,kind,uid));
  return current?.id===seed.id&&current.ref.file===seed.ref.file&&current.ref.hash===seed.ref.hash&&P.token(file)===seed.boundaryToken;
 }
 if(seed.initialPrefix){
  const {packets,taskId}=seed.initialPrefix,head=require('./subscription-baseline').initialSavedHead(dir,kind,uid,packets,taskId);
  return head?.id===seed.id&&head.ref.file===seed.ref.file&&head.ref.hash===seed.ref.hash;
 }
 if(!seed.emptyConnection){
  // A saved window can be edited between planning and wire. Its anchor and
  // duplicated seed ID agree only if the original exact receipt proves them.
  const point=seed.id==='0'&&kind==='post-comments'
   ?require('./post-subscription').verifiedBaseline(dir,uid,require('./incremental').readState(dir,kind,uid))
   :leading(dir,kind,uid,seed.ref);
  return point?.id===seed.id&&point.ref.file===seed.ref.file&&point.ref.hash===seed.ref.hash;
 }
 const current=emptyHead(dir,kind,uid,require('./incremental').readState(dir,kind,uid));
 return current?.id===seed.id&&current.emptyConnection.file===seed.emptyConnection.file&&current.emptyConnection.hash===seed.emptyConnection.hash&&current.ref.file===seed.ref.file&&current.ref.hash===seed.ref.hash&&current.emptyPending===seed.emptyPending;
}
function boundarySeed(dir,kind,uid,state){
 if(!state?.sinceDisabled||!Number.isFinite(Date.parse(state.checkedAt))||state.endPolicyVersion!==2)return null;
 const baseline={...state,sinceDisabled:false,pending:null},empty=emptyHead(dir,kind,uid,baseline);
 if(empty)return empty;
 return trustedSeed(dir,kind,uid,baseline);
}
function trustedSeed(dir,kind,uid,state){
 const baseline={...state,pending:null};
 if(!require('./subscription-boundary').trustedHead(dir,kind,uid,baseline))return null;
 const selected=state.baselineScope==='user-selected-latest-head'&&state.userSelectedHead?.head===state.anchor?state.userSelectedHead:null;
 const point=selected?{id:selected.head,ref:selected.proof}:proofLeading(dir,kind,uid,proofFor(dir,kind,baseline));
 if(point?.id===state.anchor)return point;
 return kind==='post-comments'?require('./post-subscription').verifiedBaseline(dir,uid,baseline):null;
}
function validateWindow(dir,kind,uid,{windowId,taskId,sinceId,maxId}){
 const window=require('./incremental').readState(dir,kind,uid,{windowId});
 if(!uuid(taskId)||!window||window.pending?.id!==taskId||!window.pending.since||sinceId!==undefined&&(window.anchor!==sinceId||window.pending.cursor!==maxId))throw Object.assign(Error('新请求与独立观测任务不匹配'),{code:'AUTO_OUTCOME_UNKNOWN'});
 if(!validateWindowSeed(dir,kind,uid,window))throw Object.assign(Error('新观测起点与原始响应不一致，未发起请求'),{code:'REQUEST_EVIDENCE_INVALID'});
 return window;
}
function reconcileWork(dir,kind,uid,control,{allowEmpty=false,boundaryTrial=null}={}){
 const I=require('./incremental'),file=I.stateFile(dir,kind);let expected=P.token(file),state=I.readState(dir,kind,uid);
 if(!state||boundaryTrial&&(!state.sinceDisabled||expected!==boundaryTrial.token)||!boundaryTrial&&(state.sinceDisabled||state.pending&&state.pending.head!==state.anchor))return state;
 const windows=boundaryTrial?[boundaryTrial.id]:control.windows;
 // Join only a complete, independently verified response chain whose lower
 // bound is EXACTLY the already connected global head. Points are insufficient.
 for(let n=0;n<windows.length;n++){
  let changed=false;
  for(const id of windows){
   const window=windowState(dir,kind,uid,id),proof=window?.connectedProof;
   if(window?.pending||!proof||proof.lower!==state.anchor||BigInt(proof.upper)<BigInt(state.anchor)||proof.upper===state.anchor&&!(boundaryTrial||allowEmpty&&state.pending&&!state.pending.packets.length&&state.pending.head===state.anchor))continue;
   if(boundaryTrial&&(window.seed?.boundaryToken!==boundaryTrial.token||!validateWindowSeed(dir,kind,uid,{...window,anchor:proof.lower})))continue;
   const j={schema:1,id:proof.id,uid,kind,deltaComplete:true,phase:'body',anchor:proof.lower,head:proof.upper,since:true,deltaPackets:proof.packets.map(ref=>ref.sinceId===undefined?{...ref,sinceId:proof.lower}:ref),ownerScopes:proof.scopes||[],...(kind==='post-comments'&&state.anchor==='0'?{verifiedEmptyBaseline:state.verifiedEmptyBaseline}:{})};
   const verified=require('./regular-progress').connection(dir,kind,uid,j,null);if(!verified)continue;
   const gaps=new Set([...(state.gaps?.unresolvedIds||[]),...verified.missingIds]);
   let retired=state.supersededSubscriptionIntervals||[],priorRef;if(state.pending||boundaryTrial){const prior=path.join(dir,'cache/update-boundary-recoveries',crypto.randomUUID()+'.json'),hash=require('./durable-write').atomic(prior,{schema:1,uid,kind,originalState:state,replacementProof:verified});priorRef={file:path.relative(dir,prior),hash};retired=[...retired,priorRef];}
   const next={...state,pending:null,...(boundaryTrial?{sinceDisabled:false,boundaryRecovery:{at:new Date().toISOString(),anchor:state.anchor,request:verified.packets[0],accepted:true,previousState:priorRef}}:{}),...(retired.length?{supersededSubscriptionIntervals:retired}:{}),anchor:verified.upper,connectedProof:verified,checkedAt:window.checkedAt,endPolicyVersion:2,gaps:{unresolvedIds:[...gaps],unidentifiedMissing:Math.max(state.gaps?.unidentifiedMissing||0,verified.unidentifiedMissing)}};
   const saved=P.commit(file,expected,next);if(!saved.ok)throw Object.assign(Error(saved.reason),{code:'PROGRESS_CONFLICT'});state=saved.state;if(boundaryTrial)return state;expected=saved.token;changed=true;break;
  }
  if(!changed)break;
 }
 return state;
}
function reconcile(dir,kind,uid,control,options){return require('./incremental').withLock(dir,kind,()=>reconcileWork(dir,kind,uid,control,options));}
function protectWork(opts,dir,kind,budget,flags,fetchPage,initialize){
 if(!uuid(opts.autoRoundId||opts.autoGuard?.job?.id))return null;
 const I=require('./incremental'),uid=opts.uid;let state=I.prepareUpdateState(dir,kind,uid),initial;
 if(!state){const first=require('./subscription-baseline').observation(dir,kind,uid);if(first){if(first.packets)initial=initialPoint({...first,id:first.head},first.j.id);state={schema:1,uid,kind,anchor:first.head,checkedAt:first.checkedAt,endPolicyVersion:2,observationOnly:true,pending:{head:first.head,since:true,packets:first.packets||[first.ref]}};}}
 const control=readControl(dir,kind,uid);
 if(state&&!state.pending&&control.windows.length)state=reconcile(dir,kind,uid,control);
 const recovery=opts.autoGuard?.job?.automaticRecovery?.kinds?.includes(kind);
 const trial=recovery&&state?.sinceDisabled&&flags?.updateSince?.[kind];
 if(!recovery&&!state?.pending&&!control.windows.length)return null;
 if(recovery&&state&&!state.pending&&state.checkedAt&&state.endPolicyVersion===2&&!state.sinceDisabled)state={...state,pending:{head:state.anchor,since:true,packets:[]}};
 if(!trial&&(!state?.checkedAt||state.endPolicyVersion!==2||state.sinceDisabled||state.pending&&!state.pending.since||!flags?.updateSince?.[kind]))return null;
 let seed;
 if(trial){
  const token=P.token(I.stateFile(dir,kind));seed=boundarySeed(dir,kind,uid,state);
  if(!seed)throw Object.assign(Error('原 since_id 边界证据不足，未开启独立核对'),{code:'AUTO_BASELINE'});
  seed={...seed,boundaryToken:token};
 }else{
  const pendingPoint=state.pending&&leading(dir,kind,uid,refs(state)[0]);
  if(pendingPoint&&pendingPoint.id!==state.pending.head)throw Object.assign(Error('订阅旧窗口头与保存的响应不一致'),{code:'REQUEST_EVIDENCE_INVALID'});
  seed=initial||pendingPoint||emptyHead(dir,kind,uid,state)||proofLeading(dir,kind,uid,proofFor(dir,kind,state))||trustedSeed(dir,kind,uid,state);
  if(!seed)return null;
 }
 const lower=trial?seed:latestBound(dir,kind,uid,state,control,seed);
 const id=opts.autoRoundId||opts.autoGuard.job.id,windowFile=I.stateFile(dir,kind,id);
 if(!fs.existsSync(windowFile))P.atomic(windowFile,{schema:1,uid,kind,anchor:lower.id,checkedAt:state.checkedAt,endPolicyVersion:2,origin:'subscription-observation-window',baselineUnverified:false,pending:null,observationOnly:true,seed:lower,originalAnchor:state.anchor,...(kind==='post-comments'&&lower.id==='0'?{verifiedEmptyBaseline:state.verifiedEmptyBaseline}:{})});
 if(!control.windows.includes(id))control.windows.push(id);
 // Save the index BEFORE collecting: interrupted windows remain discoverable.
 P.atomic(controlFile(dir,kind),control);
 const limit=Number.isFinite(budget)?budget:opts.pageSize;
 let archiveBefore;
 const latest=I.harvestUpdates({...opts,subscriptionWindowId:id},dir,kind,limit,flags,fetchPage,initialize,records=>{archiveBefore=records;});
 const saved=windowState(dir,kind,uid,id),point=leading(dir,kind,uid,saved?.latestObservation||refs(saved)[0]);
 if(point&&BigInt(point.id)>BigInt(lower.id))control.latest=point;
 P.atomic(controlFile(dir,kind),control);
 const global=reconcile(dir,kind,uid,control,{allowEmpty:true,...(trial&&!latest.failed&&!latest.cancelled?{boundaryTrial:{id,token:seed.boundaryToken}}:{})});
 control.windows=control.windows.filter(value=>{const w=windowState(dir,kind,uid,value);return w?.pending&&(w.pending.packets.length||w.latestObservation)||w?.connectedProof&&BigInt(w.connectedProof.upper)>BigInt(w.connectedProof.lower)&&(!global||BigInt(w.anchor)>BigInt(global.anchor));});
 P.atomic(controlFile(dir,kind),control);
 const rows=new Map((latest.rows||[]).map(row=>[row.recordId,row])),added=new Map((latest.newRows||[]).map(row=>[row.recordId,row]));
 // A saved wire-only empty observation cannot introduce a body. Keep an
 // unverified interval unknown without reopening the whole body archive.
 // Replay, partial saves and other outcomes still reconcile saved receipts.
 const empty=(latest.update?.caughtUp===true&&!latest.coverageUnverified||latest.update?.noNewBodies===true&&latest.update.checkpointCommitted===true)&&!latest.failed&&!latest.cancelled&&
  latest.requests>0&&latest.cachedCalls===0&&latest.newFetched===0;
 if(!empty)for(const [recordId,{row}]of (['sent','received'].includes(kind)?require('./subscription-archive').load(dir,kind,uid,lower.id,opts.cacheSession):require('./completeness').loadIndependentArchive(dir,kind,uid,opts.cacheSession)).records){
  if(BigInt(recordId)>BigInt(lower.id)&&!archiveBefore.has(recordId)&&require('./record-body').completeBody(row)){rows.set(recordId,row);added.set(recordId,row);}
 }
 const pending=!global||global.sinceDisabled||!!global.pending||control.windows.length>0;
 const verified=!latest.failed&&!latest.cancelled&&!latest.coverageUnverified;
 const proof=saved?.connectedProof;
 const latestComplete=verified&&latest.update?.caughtUp===true&&!!proof&&!!require('./regular-progress').connection(dir,kind,uid,{schema:1,id:proof.id,uid,kind,anchor:proof.lower,head:proof.upper,deltaComplete:true,phase:'body',since:true,deltaPackets:proof.packets},null,{knownBodyIds:new Set([...archiveBefore.keys(),...rows.keys()])});
 const latestSucceeded=verified&&(point||latestComplete)&&(latest.requests||0)>(latest.cachedCalls||0);
 return {...latest,budget,rows:C.sortRecords([...rows.values()]),newRows:C.sortRecords([...added.values()]),fetched:rows.size,partial:pending,complete:!pending&&!latest.failed,ended:!pending&&!latest.failed,coverageUnverified:pending||latest.coverageUnverified,update:{...latest.update,caughtUp:!pending&&!latest.failed,pending,protection:{latestComplete,latestSucceeded:!!latestSucceeded,latestObservedId:control.latest?.id||lower.id,pendingWindows:control.windows.length,observedReturned:latest.newFetched||0,globalAnchor:global?.anchor||null}},reason:pending&&latestSucceeded?'已检查最新记录，旧区间保留待补':latest.reason};
}
function latestBound(dir,kind,uid,state,control,seed){
 const prior=control.latest?leading(dir,kind,uid,control.latest.ref):null;
 if(control.latest&&prior?.id!==control.latest.id)throw Object.assign(Error('订阅观测头与原响应不一致'),{code:'REQUEST_EVIDENCE_INVALID'});
 // A window is indexed before collection. If the worker exited before
 // updating the monitor, recover its already committed newest-page receipt.
 const windowId=control.windows.at(-1),last=windowId&&windowState(dir,kind,uid,windowId);
 const points=[seed,prior,leading(dir,kind,uid,state.latestObservation),leading(dir,kind,uid,last?.latestObservation)].filter(Boolean);
 return points.reduce((best,point)=>BigInt(point.id)>BigInt(best.id)?point:best,seed);
}
function safeLower(dir,kind,uid,activeWindow){
 if(!['sent','received','post-comments'].includes(kind))return null;
 const s=require('./incremental').readState(dir,kind,uid);
 if(s&&(!s.checkedAt||s.endPolicyVersion!==2||s.sinceDisabled))return null;
 const c=readControl(dir,kind,uid);
 let last=c.windows.at(-1);
 if(activeWindow){
  // Reconstruct the same external evidence the plan saw before this window
  // was registered. An interrupted predecessor can hold an unpublished head.
  if(last!==activeWindow.id)throw Object.assign(Error('本轮独立观测登记已变化'),{code:'REQUEST_EVIDENCE_INVALID'});
  const current=windowState(dir,kind,uid,last);
  if(!current?.pending)throw Object.assign(Error('本轮独立观测范围无法核实'),{code:'REQUEST_EVIDENCE_INVALID'});
  activeWindow.verify(current);
  last=c.windows.at(-2);
 }
 const prior=c.latest&&leading(dir,kind,uid,c.latest.ref);
 if(c.latest&&(!prior||prior.id!==c.latest.id))throw Error('最新观测关联已变化');
 if(!s){
  const first=require('./subscription-baseline').observation(dir,kind,uid);
  if(!first)return null;
  return prior&&BigInt(prior.id)>BigInt(first.head)?prior.id:first.head;
 }
 const empty=emptyHead(dir,kind,uid,s),heads=empty?[empty.id]:[],point=empty?null:s.pending?leading(dir,kind,uid,refs(s)[0]):proofLeading(dir,kind,uid,proofFor(dir,kind,s));
 if(point&&(s.pending?point.id===s.pending.head:point.id===s.anchor))heads.push(point.id);
 if(!heads.length&&s.pending?.head===s.anchor&&!s.pending.packets.length){const stable=trustedSeed(dir,kind,uid,s);if(stable?.id===s.anchor)heads.push(stable.id);}
 if(s.userSelectedHead?.head===s.anchor&&require('./subscription-boundary').trustedHead(dir,kind,uid,s))heads.push(s.userSelectedHead.head);
 if(s.baselinePacket){const p=kind==='post-comments'&&s.anchor==='0'?require('./post-subscription').verifiedBaseline(dir,uid,s):leading(dir,kind,uid,s.baselinePacket);if(p&&p.id===s.anchor)heads.push(p.id);}
 if(prior)heads.push(prior.id);
 for(const point of [leading(dir,kind,uid,s.latestObservation),last&&leading(dir,kind,uid,windowState(dir,kind,uid,last)?.latestObservation)])if(point)heads.push(point.id);
 return heads.reduce((a,b)=>!a||BigInt(b)>BigInt(a)?b:a,null);
}
function observedHead(dir,kind,uid){
 const entry=readControl(dir,kind,uid).latest;
 if(!entry)return null;
 const point=leading(dir,kind,uid,entry.ref);
 if(!point||point.id!==entry.id)throw Error('最新订阅观测关联已变化，原证据保留');
 return point.id;
}
function protect(opts,dir,kind,budget,flags,fetchPage,initialize){return require('./process-lease').withLease(controlFile(dir,kind)+'.lock',()=>protectWork(opts,dir,kind,budget,flags,fetchPage,initialize),'同一方向的订阅观测正在保存');}
module.exports={protect,reconcile,controlFile,safeLower,validateWindow,windowState,observedHead};
