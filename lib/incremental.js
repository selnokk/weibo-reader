'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {rawArray,apiError,normalize,targetNickname,sortRecords,ENDPOINTS}=require('./core');
const {getOne}=require('./storage');
const {historyNext,historyRecordId}=require('./history');
const {exactId,loadIndependentArchive,createCollectionEvidence}=require('./completeness');
const {createProgress}=require('./terminal-report');

// An update boundary belongs to one account AND one independent endpoint.
// It certifies a newly traversed interval, never all of the older history.
function stateFile(dir,kind,windowId=''){if(windowId&&!/^[a-f0-9-]{36}$/.test(windowId))throw Error('订阅观测窗口身份无效');return windowId?path.join(dir,'cache','updates','subscription-windows',kind,windowId+'.json'):path.join(dir,'cache','updates',kind+'.json');}
function atomicJson(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';
 try{fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function readState(dir,kind,uid,{windowId=''}={}){
 const file=stateFile(dir,kind,windowId);if(!fs.existsSync(file))return null;
 const state=JSON.parse(require('./regular-file').read(file,{maxBytes:16*1024*1024}));
 if(state.schema!==1||state.uid!==uid||state.kind!==kind||!(exactId(state.anchor)||kind==='post-comments'&&state.anchor==='0'&&state.verifiedEmptyBaseline))throw Error('增量检查点格式或账户不匹配，原文件已保留；请检查 cache/updates 中对应接口的检查点');
 if(state.pending&&((state.pending.cursor!==''&&!exactId(state.pending.cursor))||!(exactId(state.pending.head)||kind==='post-comments'&&state.pending.head==='0'&&state.verifiedEmptyBaseline)||!Array.isArray(state.pending.packets)||!Number.isSafeInteger(state.pending.page)||state.pending.page<0||state.pending.page!==state.pending.packets.length||state.pending.cursor&&BigInt(state.pending.cursor)<=BigInt(state.anchor)||BigInt(state.pending.head)<BigInt(state.anchor)))throw Error('增量续取位置无效，原文件已保留');
 if(kind==='post-comments'&&state.anchor==='0')restorePacket(state.verifiedEmptyBaseline,dir);
 return state;
}
function withLock(dir,kind,fn,windowId=''){
 return require('./process-lease').withLease(stateFile(dir,kind,windowId)+'.lock',fn,'该账户的同一接口正在更新，请等待当前任务结束');
}
function previousRecovery(dir,kind,uid){
 const folder=path.join(dir,'cache','runs');if(!fs.existsSync(folder))return [];
 for(const name of fs.readdirSync(folder).filter(name=>name.endsWith('.json')).sort().reverse()){
  try{const run=JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));if(run.uid!==uid)continue;const source=run.endpoints?.find(s=>s.kind===kind);if(source&&Array.isArray(source.records))return source.records.filter(r=>r.isRecovered&&exactId(r.id)).map(r=>r.id);}catch{}
 }
 return [];
}
function bootstrapState(dir,kind,uid,archive){
 // Only a true latest-page response establishes a starting boundary. A dated
 // max_id probe or a nested quotation must never silently become that boundary.
 let anchor='',visibleEnd=false;
 for(const [id,entry]of archive.records){
  if(!new RegExp('^cache/'+kind+'_(?:c\\d+_m0(?:_legacy_[a-f0-9]{16})?|page1)\\.json$').test(entry.provenance.file.split(path.sep).join('/')))continue;
  if(!anchor||BigInt(id)>BigInt(anchor))anchor=id;
 }
 if(!anchor)return null;
 // This flag only records an observed older visible end; later updates do not
 // upgrade a finite, disconnected archive into a complete historical export.
 for(const name of fs.readdirSync(path.join(dir,'cache'))){
  if(!new RegExp('^'+kind+'_(?:c\\d+_m0|page1)\\.json$').test(name))continue;
  try{const raw=JSON.parse(fs.readFileSync(path.join(dir,'cache',name),'utf8'));if(!apiError(raw)&&historyNext(raw,kind)==='0'&&rawArray(raw,kind)?.items.some(r=>historyRecordId(r)===anchor))visibleEnd=true;}catch{}
 }
 const recoveredIds=previousRecovery(dir,kind,uid),recoveredHashes=Object.fromEntries(recoveredIds.filter(id=>archive.records.has(id)).map(id=>[id,archive.records.get(id).provenance.responseHash]));
 return {schema:1,uid,kind,anchor,visibleEnd,recoveredIds,recoveredHashes,recoveryCheckedAt:Date.now(),checkedAt:null,pending:null};
}
function packetReference(packet,dir){
 if(packet.receipt)return {...packet.receipt,stamp:packet.cacheTimeMs};
 if(!packet.file)return null;return {file:path.relative(dir,packet.file),hash:packet.responseHash||crypto.createHash('sha256').update(fs.readFileSync(packet.file)).digest('hex'),stamp:packet.cacheTimeMs};
}
function restorePacket(ref,dir){
 if(typeof ref.file!=='string'||!/^cache[\\/]/.test(ref.file)||!/^([a-f0-9]{64})$/.test(ref.hash||''))throw Error('增量响应索引无效');
 const base=path.resolve(dir,'cache'),original=path.resolve(dir,ref.file);
 if(!original.startsWith(base+path.sep))throw Error('增量响应路径越界');
 const candidates=[original,original.replace(/\.json$/,'_legacy_'+ref.hash.slice(0,16)+'.json')];
 for(const file of candidates){
  if(!fs.existsSync(file)||!fs.realpathSync(file).startsWith(fs.realpathSync(base)+path.sep))continue;
  const bytes=/[\\/]exchange-v1[\\/]/.test(file)?require('./exchange-records').bytes(file):require('./regular-file').read(file);if(crypto.createHash('sha256').update(bytes).digest('hex')!==ref.hash)continue;
  const value=JSON.parse(bytes),envelope=!!ref.envelope||value.schema===1&&!!value.query&&!!value.response;if(envelope&&(value.schema!==1||!value.query||value.query.count!==ref.count||value.query.maxId!==ref.maxId||(ref.sinceId!==undefined&&value.query.sinceId!==ref.sinceId)||(ref.uid!==undefined&&value.query.uid!==ref.uid)||(ref.kind!==undefined&&value.query.kind!==ref.kind)||(ref.page!==undefined&&value.query.page!==ref.page)))throw Error('请求响应关联不匹配');return {raw:envelope?value.response:value,cached:true,file,responseHash:ref.hash,cacheTimeMs:ref.stamp,...(envelope?{query:value.query,savedAt:value.savedAt}:{}),receipt:envelope?{file:ref.file,hash:ref.hash,envelope:true,uid:value.query.uid,kind:value.query.kind,page:value.query.page}:undefined};
 }
 throw Object.assign(Error('待续取响应已缺失或改变；保留旧检查点并从已确认位置重新核对'),{code:'REQUEST_EVIDENCE_INVALID'});
}
function harvestUpdates(opts,dir,kind,budget,flags,fetchPage=getOne,initialize,captureArchive){
 if(budget<=0)return {kind,budget,rows:[],fetched:0,newFetched:0,requests:0,cachedCalls:0,reason:'此分类分配 0 条',ended:false};
 if(opts.autoGuard&&!opts.subscriptionWindowId){const protectedResult=require('./subscription-latest').protect(opts,dir,kind,budget,flags,fetchPage,initialize);if(protectedResult)return protectedResult;}
 if(opts.autoGuard&&!opts.subscriptionWindowId&&['sent','received'].includes(kind)&&flags?.updateSince?.[kind]){const initial=prepareUpdateState(dir,kind,opts.uid);if(!initial?.checkedAt&&!initial?.pending&&!initial?.sinceDisabled)return require('./subscription-baseline').initialize(opts,dir,kind,budget,flags,fetchPage);}
 const windowId=opts.subscriptionWindowId||'',progressFile=stateFile(dir,kind,windowId);
 if(windowId&&!opts.autoGuard)throw Error('订阅观测只能由受预算保护的调度器使用');
 return withLock(dir,kind,()=>{
  const checkpoints=require('./update-progress');let expected=checkpoints.token(progressFile);
  function persist(value){const write=checkpoints.commit(progressFile,expected,value);if(!write.ok)throw Object.assign(Error(write.reason),{code:'PROGRESS_CONFLICT'});expected=write.token;return write.state;}
  let state=windowId?readState(dir,kind,opts.uid,{windowId}):prepareUpdateState(dir,kind,opts.uid,{locked:true});
  const loadArchive=()=>opts.autoGuard&&state&&['sent','received'].includes(kind)?require('./subscription-archive').load(dir,kind,opts.uid,state.anchor,opts.cacheSession):loadIndependentArchive(dir,kind,opts.uid,opts.cacheSession);
  let archive=loadArchive();state??=bootstrapState(dir,kind,opts.uid,archive);
  captureArchive?.(archive.records);
  // Local recovery may atomically commit an already saved response chain.
  // Subsequent writes belong to that recovered revision, not the stale token.
  expected=checkpoints.token(progressFile);
  let boundaryProbe=null;if(opts.autoGuard&&state?.sinceDisabled&&flags?.updateSince?.[kind])boundaryProbe=require('./subscription-boundary').recheck(opts,dir,kind,state,fetchPage,persist);
  if(opts.autoGuard&&(!state||!state.checkedAt||state.endPolicyVersion!==2||state.sinceDisabled||!flags?.updateSince?.[kind]||state.pending&&!state.pending.since))throw require('./auto-follow-budget').safety('AUTO_BASELINE','该方向没有可靠 since_id 检查点，或旧证据不足以安全核验；请修复本地证据或手动建立并核实基线');
  if(!state){
   const result=initialize();archive=loadArchive();state=bootstrapState(dir,kind,opts.uid,archive);
   if(state&&!require('./limits').sourceIncomplete(result)){state.recoveredIds=result.rows.filter(r=>r.isRecovered).map(r=>r.recordId);state.recoveredHashes=Object.fromEntries(state.recoveredIds.filter(id=>archive.records.has(id)).map(id=>[id,archive.records.get(id).provenance.responseHash]));state.recoveryCheckedAt=Date.now();state.checkedAt=new Date().toISOString();state.endPolicyVersion=2;persist(state);}
   result.update={initialized:true,caughtUp:!!state&&!require('./limits').sourceIncomplete(result),newCount:result.newRows?.length||0,newRecordIds:(result.newRows||[]).map(r=>r.recordId),reusedCount:0,newReturned:result.newFetched,returnLimit:Number.isFinite(budget)?budget:null,limited:!!result.returnLimited};
   result.reason+='；首次建立最新记录基线，之后 --update 只读取新增区间';return result;
  }
  state.recoveredIds=(state.recoveredIds||[]).filter(id=>{const entry=archive.records.get(id),previous=state.recoveredHashes?.[id];return !entry||(previous?entry.provenance.responseHash===previous:!(entry.stamp>=state.recoveryCheckedAt+1));});
  persist(state);
  const out={kind,budget,rows:[],fetched:0,newFetched:0,requests:0,cachedCalls:0,cacheTimes:[],name:'',reason:'',ended:!!state.visibleEnd,failed:false,incremental:true,quickOnly:!!opts.quickOnly,autoFollow:!!opts.autoGuard,newBoundaryId:state.anchor,cachedRecoveryIds:new Set((state.recoveredIds||[]).filter(exactId))};
  for(const {row}of archive.records.values()){const name=row.authorUid===opts.uid?row.author:row.replyAuthorUid===opts.uid?row.replyAuthor:row.postAuthorUid===opts.uid?row.postAuthor:'';if(name&&name!=='未知用户'){out.name=name;break;}}
  const evidence=createCollectionEvidence(dir,kind,opts.uid),fresh=new Map(),newIds=new Set(),activity=new Map(),emptyBodyIds=new Set(),positions=new Set(),progress=createProgress(opts),boundary=BigInt(state.anchor);
  const update={anchor:state.anchor,caughtUp:false,newCount:0,reusedCount:0,overlapCount:0,resumed:!!state.pending};out.update=update;
  if(opts.autoGuard&&state.pending?.cursor)throw require('./auto-follow-budget').safety('AUTO_BASELINE','旧续取位置保留在待补区间，订阅只检查最新记录');
  let pending=state.pending||{id:crypto.randomUUID(),cursor:'',head:state.anchor,page:0,startedAt:new Date().toISOString(),packets:[],since:!state.sinceDisabled&&!!flags?.updateSince?.[kind]};
  pending.id??=crypto.randomUUID();pending.ownerScopes=[...new Set([...(pending.ownerScopes||[]),...(opts.taskScopeId?[opts.taskScopeId]:[])])];state.pending=pending;persist(state);
  opts={...opts,dataTaskId:pending.id,knownRecordIds:new Set(archive.records.keys())};let cursor=pending.cursor,head=pending.head,page=pending.page,verify=!!pending.verify,emptyWindows=0,latestPage=null,localTail=false,firstPage=null,freshEmptyStart=false;
  const knownIds=[...archive.records.keys()],end=require('./update-end');
  function savedPage(maxId){
   const scope={uid:opts.uid,kind,maxId,sinceId:state.anchor};
   for(const packet of require('./request-journal').savedContinuations(dir,scope)){
    const parsed=rawArray(packet.raw,kind);
    if(!parsed||apiError(packet.raw)||parsed.items.length>packet.receipt.count)continue;
    const ids=parsed.items.map(historyRecordId);
    if(ids.some((id,i)=>!archive.records.has(id)||BigInt(id)<=boundary||BigInt(id)>BigInt(maxId)||i>0&&BigInt(id)>=BigInt(ids[i-1])))continue;
    const next=historyNext(packet.raw,kind),missing=end.missingMetadata(packet.raw,kind,{anchor:state.anchor,cursor:maxId,next});
    if(missing.uncertain||missing.ids.size||!ids.length&&next!=='0')continue;
    if(!end.updateStep(packet.raw,kind,state.anchor,maxId,ids,{knownIds}).ambiguous)return packet;
   }
   return null;
  }
  function ingest(packet,count,maxId,wire=false){
   const parsed=rawArray(packet.raw,kind);if(!parsed||apiError(packet.raw))throw Error(apiError(packet.raw)||'响应缺少记录数组');
   const items=parsed.items,ids=items.map(historyRecordId);if(kind==='post-comments')require('./post-comments').postPageRows(packet.raw,opts.postId);let previous=null;
   if(!maxId)firstPage={empty:items.length===0,complete:!!items[0]&&require('./record-body').completeBody(normalize(items[0],kind,opts.uid),items[0])};
   if(opts.autoGuard){for(const id of ids)positions.add(id);for(const id of require('./update-end').missingMetadata(packet.raw,kind,{anchor:state.anchor,cursor:maxId,next:historyNext(packet.raw,kind)}).ids)positions.add(id);}
   for(let i=0;i<items.length;i++){
    const id=BigInt(ids[i]);let row=normalize(items[i],kind,opts.uid);
    if(opts.autoGuard&&id<=boundary){state.sinceDisabled=true;throw require('./auto-follow-budget').safety('AUTO_SINCE_IGNORED','接口未遵守 since_id（返回旧检查点或更旧记录），订阅已暂停，原始响应保留');}
    if(maxId&&id>BigInt(maxId))throw Error('接口未遵守 max_id，增量边界尚未确认');
    if(previous!=null&&id>previous)throw Error('接口未按 ID 倒序返回，增量边界尚未确认');previous=id;
    if(!require('./record-body').completeBody(row,items[i])){
     const saved=archive.records.get(ids[i])?.row;
     // Exact-ID independent bodies may repair a known missing body. Keep the
     // original incomplete response and do not invent a complete leading head.
     if(!saved||!maxId&&i===0||!require('./record-body').completeBody(saved)||['authorUid','postId','postAuthorUid','replyAuthorUid'].some(key=>row[key]&&saved[key]&&row[key]!==saved[key])){
      if(!opts.autoGuard)throw Object.assign(Error('增量记录缺少完整独立正文或可识别日期，已保留原始响应，未推进检查点'),{code:'AUTO_BODY_MISSING'});
      if(kind==='sent'&&row.authorUid&&row.authorUid!==opts.uid)throw Error('发出评论的作者 UID 与目标不一致，已停止');
      emptyBodyIds.add(ids[i]);continue;
     }
     row=saved;
    }
    if(kind==='sent'&&row.authorUid!==opts.uid)throw Error('发出评论的作者 UID 与目标不一致，已停止');
    if(id>boundary){newIds.add(ids[i]);if(id>BigInt(head))head=ids[i];}
    else{update.overlapCount++;if(id<boundary&&pending.since){state.sinceDisabled=true;update.sinceIgnored=true;}}
    fresh.set(ids[i],row);if(wire&&!maxId)activity.set(ids[i],row);
   }
   evidence.add(packet,count,maxId,'collect',pending.since&&!state.sinceDisabled?state.anchor:'');
   if(!out.name)out.name=targetNickname(packet.raw,kind,opts.uid);
   return {items,ids};
  }
  // Replaying already saved responses is free. Never resume a cursor if its
  // supporting packet has vanished, or silently commit an incomplete prefix.
  if(state.pending){
   try{
    let expected='';
    for(const ref of pending.packets){
     if(ref.maxId!==expected||!Number.isSafeInteger(ref.count)||ref.count<1||ref.count>200)throw Error('增量响应链不连续');
     if(ref.localReplay)require('./request-journal').verifyContinuation(dir,ref,{uid:opts.uid,kind,maxId:expected,sinceId:state.anchor});
     const packet=restorePacket(ref,dir),parsed=ingest(packet,ref.count,ref.maxId);
     const step=end.updateStep(packet.raw,kind,state.anchor,ref.maxId,parsed.ids);expected=step.next||'0';
     if(BigInt(expected)<=boundary||(ref.maxId&&BigInt(expected)>=BigInt(ref.maxId)))throw Error('增量响应链边界异常');
     out.requests++;out.cachedCalls++;
    }
    if(expected!==pending.cursor)throw Error('增量响应链与续取位置不一致');
   }
   catch(error){if(opts.autoGuard)throw Object.assign(Error('已保存的增量链无法核实，保留原续取位置并等待本地恢复'),{code:'REQUEST_EVIDENCE_INVALID',cause:error});pending={id:crypto.randomUUID(),cursor:'',head:state.anchor,page:0,startedAt:new Date().toISOString(),packets:[],since:!state.sinceDisabled&&!!flags?.updateSince?.[kind]};cursor='';head=state.anchor;page=0;fresh.clear();newIds.clear();evidence.windows.length=0;evidence.observed.clear();update.restartReason=error.message;opts={...opts,dataTaskId:pending.id};state.pending=pending;persist(state);}
  }
  try{
   for(;;){
    require('./cancellation').check();
    if(page>=1&&kind==='mentions-comments'&&flags?.commentsMentionCursor===false){out.reason='接口未声明 max_id，增量尚未完成';break;}
    if(out.requests-out.cachedCalls>=opts.pages){out.stopCode='REQUEST_LIMIT';out.reason='达到 --pages 新增 API 请求上限；增量尚未接回旧检查点，下次 --update 将继续';break;}
    const remaining=budget-Math.max(out.newFetched,opts.autoGuard?positions.size:0);
    if(remaining<=0){out.stopCode='RETURN_LIMIT';update.limited=true;out.reason='达到本次新增返回条数上限；续取位置已保存，下次 --update 继续';break;}
    // A subscription may fill the same newest page after its one-row probe.
    // Any terminal check fits inside the same window and uses an exclusive
    // upper bound. A prior round's cursor never reaches the network again.
    const localOverlap=opts.autoGuard&&page&&cursor&&knownIds.some(id=>BigInt(id)>boundary&&BigInt(id)<=BigInt(cursor));
    const replay=localOverlap||localTail?savedPage(cursor):null;
    if(!replay&&(localTail||localOverlap&&archive.records.has(cursor))){
     out.stopCode='LATEST_WINDOW_LIMIT';
     out.reason='最新窗口已到达已保存的记录，较早区间保留待补';
     break;
    }
    const single=opts.autoGuard?(!page||localOverlap||page>1&&verify):verify||!page;
    let count=replay?.receipt.count??Math.min(opts.pageSize,single?1:Infinity,remaining);
    if(opts.autoGuard&&!boundaryProbe&&!replay){count=opts.autoGuard.maxCount(kind,count);if(count<1){out.autoStop={code:opts.autoGuard.stopCode,message:opts.autoGuard.stopReason};out.reason=opts.autoGuard.stopReason;update.limited=true;break;}}
    if(opts.autoGuard&&page&&(!cursor||latestPage?.low&&BigInt(cursor)>=BigInt(latestPage.low))){
     out.coverageUnverified=true;
     out.stopCode='DELTA_END_UNVERIFIED';
     out.reason='分页未证明继续向前，已保存原响应';
     break;
    }
    let packet;try{if(replay){packet=replay;localTail=true;}else if(boundaryProbe){packet=boundaryProbe;boundaryProbe=null;count=1;}else{
     const request=()=>fetchPage({...opts,refresh:true,offline:false},dir,kind,count,cursor,pending.since&&!state.sinceDisabled?state.anchor:'');
     try{packet=request();}catch(error){
      // Only a durable, zero-wire refusal can be rechecked locally. The full
      // original boundary/choice/budget guards run again; never retry an SDK
      // invocation, unknown charge, changed source or failed save this way.
      if(!opts.autoGuard||error.code!=='REQUEST_EVIDENCE_INVALID'||error.sdkNotInvoked!==true||error.billingUnknown||error.notSentFailureCode)throw error;
      try{packet=request();}catch(retryError){throw retryError.apiAttempt===true||retryError.billingUnknown||retryError.notSentFailureCode?retryError:error;}
     }
    }}
    catch(error){out.failed=true;out.reason='增量请求失败：'+error.message;require('./collection-failure').accountFailure(out,error);if(opts.autoGuard)out.autoStop={code:error.code||'AUTO_FAILED',message:error.message};break;}
    if(!packet){out.reason='增量响应不可用，未推进检查点';break;}
    out.requests++;if(packet.cached)out.cachedCalls++;else out.newFetched+=rawArray(packet.raw,kind)?.items.length||0;
    const {items,ids}=ingest(packet,count,cursor,!packet.cached);
    const ref=packetReference(packet,dir);
    if(!packet.cached&&opts.noteNewRecords)opts.noteNewRecords(ids.filter(id=>BigInt(id)>boundary&&!archive.records.has(id)&&fresh.has(id)).map(id=>fresh.get(id)));
    require('./events').emit('collection',{kind,phase:'update',fetched:newIds.size,budget:Number.isFinite(budget)?budget:null,newReturned:out.newFetched,returnLimit:Number.isFinite(budget)?budget:null});
    progress.update(`${opts.creditMeter?opts.creditMeter.progress()+' · ':''}${ENDPOINTS[kind].label} · 新区间 ${newIds.size} 条 · API ${out.requests-out.cachedCalls} 次`, `  增量 #${page+1} ${ENDPOINTS[kind].command.join(' ')} --count ${count}${cursor?' --max_id '+cursor:''}${pending.since&&!state.sinceDisabled?' --since_id '+state.anchor:''} | 返回 ${items.length} 条，新区间去重 ${newIds.size} 条`);
    if(items.length>count){out.reason='接口返回数超过请求数量，原始响应已保存；未推进增量检查点';break;}
    if(opts.autoGuard&&!cursor&&ids[0]&&fresh.has(ids[0])&&!emptyBodyIds.has(ids[0])&&ref){
     const observed={...ref,count,maxId:'',sinceId:state.anchor};
     state.latestObservation=observed;persist(state);
    }
    latestPage={low:ids.at(-1),count,returned:items.length};
    const next=historyNext(packet.raw,kind);
    if(opts.autoGuard&&end.missingMetadata(packet.raw,kind,{anchor:state.anchor,cursor,next}).uncertain){out.coverageUnverified=true;out.stopCode='DELTA_END_UNVERIFIED';out.reason='响应的缺失位置格式或范围无法核实，已保存原响应';break;}
    if(opts.autoGuard&&!items.length&&next==null){out.coverageUnverified=true;out.autoStop={code:'AUTO_EMPTY_UNKNOWN',message:'空响应未证明新增区间结束，停止自动请求，等待人工核实'};out.reason=out.autoStop.message;break;}
    if(next!=null&&next!=='0'&&((cursor&&BigInt(next)>=BigInt(cursor))||(ids.length&&BigInt(next)>BigInt(ids.at(-1)))))throw Error('增量续取游标与扫描记录矛盾，检查点未推进');
    const step=end.updateStep(packet.raw,kind,state.anchor,cursor,ids,{knownIds});
    if(step.ambiguous){out.stopCode='DELTA_END_UNVERIFIED';out.coverageUnverified=true;out.reason='新增结束依据不足，原区间与正文保留，未推进检查点';break;}
    // An empty first page may lead to more bodies, a quota stop or an
    // unverified continuation. Only describe the window after its last page.
    if(opts.autoGuard&&!page&&!cursor&&!packet.cached&&ref&&next!=null&&!fresh.size)freshEmptyStart=true;
    if(step.connected){
     if(freshEmptyStart&&!fresh.size&&ref&&!packet.cached&&!out.cachedCalls)update.noNewBodies=true;
     if(opts.autoGuard&&!firstPage?.complete&&(!firstPage?.empty||head!==state.anchor)){
      state.unverifiedObservation={id:pending.id,lower:state.anchor,upper:head,packets:[...pending.packets,{...ref,count,maxId:cursor,sinceId:pending.since?state.anchor:''}]};
      out.coverageUnverified=true;out.stopCode='LATEST_WINDOW_LIMIT';out.reason='本轮可见评论已保存，缺失正文保留提示，未使用空正文更改检查点';break;
     }
     update.caughtUp=true;out.reason='新增区间已接回旧检查点';state.connectedProof={id:pending.id,scopes:pending.ownerScopes||[],lower:state.anchor,upper:head,packets:[...pending.packets,{...ref,count,maxId:cursor,sinceId:pending.since?state.anchor:''}]};state.anchor=head;state.endPolicyVersion=2;state.checkedAt=pending.startedAt;state.pending=null;
     break;
    }
    const continuation=step.next;
    verify=step.verify&&!verify;
    if(!ref)throw Error('增量原始响应未保存，无法安全记录续取位置');
    pending={...pending,verify,cursor:continuation,head,page:page+1,packets:[...pending.packets,{...ref,count,maxId:cursor,sinceId:pending.since&&!state.sinceDisabled?state.anchor:''}]};state.pending=pending;
    persist(state);cursor=continuation;page++;
    if(opts.autoGuard&&ids.some(id=>archive.records.has(id)))localTail=true;
    emptyWindows=items.length?0:emptyWindows+1;if(emptyWindows>=(opts.emptyWindowLimit??20)){out.reason='达到连续空窗口保护上限，续取位置已保存；新增区间尚未接通';update.limited=true;break;}
   }
  }catch(error){out.failed=true;out.reason=error.message;if(opts.autoGuard){out.autoStop={code:error.code||'AUTO_BOUNDARY',message:error.message};if(out.autoStop.code!=='AUTO_BODY_MISSING')opts.autoGuard.halt(out.autoStop.code,out.autoStop.message);}}
  finally{progress.end();}
  // Finite quotas bound both new billable returns and the rolling report.
  // Reaching a quota never commits past unread comments; pending packets
  // are replayed for free on the next invocation.
  const candidates=new Map([...archive.records].map(([id,entry])=>[id,entry.row]));for(const [id,row]of fresh)candidates.set(id,row);
  out.rows=sortRecords(opts.quickOnly?[...fresh].filter(([id])=>BigInt(id)>boundary).map(([,row])=>row):[...candidates.values()]).slice(0,budget);out.fetched=out.rows.length;
  update.intervalId=pending.id;update.head=head;update.newReturned=out.newFetched;update.returnLimit=Number.isFinite(budget)?budget:null;
  update.newCount=[...newIds].filter(id=>!archive.records.has(id)).length;update.intervalCount=newIds.size;
  update.reusedCount=out.rows.filter(r=>!fresh.has(r.recordId)).length;update.checkedAt=state.checkedAt;update.pending=!!state.pending;if(opts.autoGuard){update.pendingCursor=state.pending?.cursor||null;update.pendingHead=state.pending?.head||null;}
  const unresolved=new Set((state.gaps?.unresolvedIds||[]).filter(exactId)),reported=new Set();let anonymous=0;
  for(const id of emptyBodyIds){reported.add(id);unresolved.add(id);}
  for(const w of evidence.windows){for(const id of w.missingIds)if(BigInt(id)>boundary){reported.add(id);unresolved.add(id);}anonymous+=w.unidentifiedMissing;}
  const resolved=[];for(const id of [...unresolved])if(fresh.has(id)||archive.records.has(id)){unresolved.delete(id);resolved.push(id);}
  state.gaps={unresolvedIds:[...unresolved],unidentifiedMissing:Math.max(state.gaps?.unidentifiedMissing||0,anonymous)};
  update.gap={connected:update.caughtUp,reported:reported.size,reportedIds:[...reported],restored:resolved.length,unresolvedIds:[...unresolved],unidentifiedMissing:state.gaps.unidentifiedMissing};
  if(!update.caughtUp)out.reason+='；新旧记录之间仍有未读取区间';
  if(unresolved.size||state.gaps.unidentifiedMissing)out.reason+=`；增量缺口：仍缺 ${unresolved.size} 个已知 ID${state.gaps.unidentifiedMissing?'，另有未能对应 ID 的缺失位置':''}`;
  require('./events').emit('collection',{kind,phase:'update',fetched:newIds.size,budget:Number.isFinite(budget)?budget:null,newReturned:out.newFetched,returnLimit:update.returnLimit,done:update.caughtUp,gap:update.gap});
  state.lastAttempt={at:new Date().toISOString(),connected:update.caughtUp,failed:out.failed===true,reason:out.reason};
  out.cancelled=require('./cancellation').cancelled();if(out.cancelled){out.failed=false;out.partial=true;}
  const result=evidence.finish(out,archive,opts.quickOnly?{...opts,historyRecovery:false}:opts);result.activityRows=[...activity.values()];
  update.newRecordIds=(result.newRows||[]).map(r=>r.recordId);update.newCount=update.newRecordIds.length;
  const recovery=new Set(state.recoveredIds||[]);for(const id of fresh.keys())recovery.delete(id);for(const row of result.rows)if(row.isRecovered)recovery.add(row.recordId);state.recoveredIds=[...recovery];state.recoveredHashes=Object.fromEntries(state.recoveredIds.flatMap(id=>archive.records.has(id)?[[id,archive.records.get(id).provenance.responseHash]]:opts.autoGuard&&state.recoveredHashes?.[id]?[[id,state.recoveredHashes[id]]]:[]));state.recoveryCheckedAt=Date.now();
  try{persist(state);update.checkpointCommitted=true;}catch(error){result.coverageUnverified=true;result.reason+='；'+error.message;update.checkpointCommitted=false;update.caughtUp=false;}
  if(!update.caughtUp){result.partial=true;result.ended=false;}
  return result;
 },windowId);
}
function prepareUpdateState(dir,kind,uid,{locked=false}={}){const state=readState(dir,kind,uid);if(state&&!state.pending)return state;const recover=()=>{const current=readState(dir,kind,uid)||require('./subscription-baseline').recoverInitialHead(dir,kind,uid);return current?.pending?require('./regular-progress').reconcile(dir,kind,uid,current):current;};return locked?recover():withLock(dir,kind,recover);}
function atomicText(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,text);fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
module.exports={atomicText,withLock,atomicJson,harvestUpdates,stateFile,readState,restorePacket,prepareUpdateState};
