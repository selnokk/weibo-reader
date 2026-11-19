'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {rawArray,normalize,sortRecords,targetNickname,ENDPOINTS}=require('./core');
const {getOne}=require('./storage');
const {createWindows,completeBody}=require('./data-windows');
const {createCollectionEvidence,exactId}=require('./completeness');
const {readState,stateFile,restorePacket,withLock,atomicJson}=require('./incremental');
const cancel=require('./cancellation'),latest=require('./latest-interaction');
function progressFile(dir,kind,o){const scope=[o.from||'',o.to||'',o.beforeMs??'recent',o.taskScopeId||''].join('|');return path.join(dir,'cache/data-updates',kind+'_'+crypto.createHash('sha256').update(scope).digest('hex').slice(0,16)+'.json');}
const resumeError=()=>Object.assign(Error('原任务的方向、范围或续取证据无法核实，原文件保留，未发起该方向的取数请求'),{code:'RESUME_EVIDENCE_INVALID'});
function readProgress(dir,kind,o){
 const file=progressFile(dir,kind,o);
 let saved;
 try{saved=JSON.parse(require('./regular-file').read(file,{maxBytes:16*1024*1024}));}
 catch(error){if(error.code==='ENOENT')return null;throw resumeError();}
 const id=value=>typeof value==='string'&&(/^\d+$/.test(value)||value==='');
 if(saved?.schema!==1||saved.uid!==o.uid||saved.kind!==kind||!['pending','complete'].includes(saved.status)||
    !Array.isArray(saved.ownerScopes)||!saved.ownerScopes.includes(o.taskScopeId)||!['delta','body'].includes(saved.phase)||
    !id(saved.cursor)||!id(saved.anchor)||!id(saved.head)||!Array.isArray(saved.selectedIds)||saved.selectedIds.some(value=>!exactId(value))||
    !Array.isArray(saved.packets)||!/^([a-f0-9-]{36})$/.test(saved.id||'')||saved.scope?.from!==(o.from||'')||saved.scope?.to!==(o.to||'')||
    saved.request&&(!Number.isSafeInteger(saved.request.count)||saved.request.count<1||!id(saved.request.max)||!id(saved.request.since)||!['collect','seek'].includes(saved.request.phase)))throw resumeError();
 return saved;
}
function taskDirections(dir,o){
 const file=path.join(dir,'cache/data-updates',o.taskScopeId+'.directions');
 let value;
 try{value=JSON.parse(require('./regular-file').read(file,{maxBytes:8192}));}
 catch(error){if(error.code!=='ENOENT')throw resumeError();}
 const query={uid:o.uid,mode:o.mode,from:o.from||'',to:o.to||'',beforeMs:o.beforeMs??null,limit:Number.isFinite(o.count)?o.count:null,quick:!!o.update};
 const kinds=require('./core').plan(o).map(p=>p.kind);
 if(value&&(value.schema!==1||value.scope!==o.taskScopeId||JSON.stringify(value.query)!==JSON.stringify(query)||!Array.isArray(value.started)||value.started.some(kind=>!kinds.includes(kind))))throw resumeError();
 if(!value&&!o.resumeScope){value={schema:1,scope:o.taskScopeId,query,started:[]};atomicJson(file,value);}
 return {
  unstarted:kind=>!!value&&!value.started.includes(kind),
  start(kind){if(value&&!value.started.includes(kind)){value.started.push(kind);atomicJson(file,value);}}
 };
}
const reference=(packet,count,maxId,sinceId='')=>({file:packet.file,hash:packet.responseHash,count,maxId,sinceId});
const samePacket=(a,b)=>a.hash===b.hash&&a.file===b.file&&a.count===b.count&&a.maxId===b.maxId&&(a.sinceId||'')===(b.sinceId||'');
function deltaStep(w,kind,journal,cursor,knownIds=[]){
 if(w.echo)return {connected:false,next:(BigInt(w.low)-1n).toString(),verify:true};
 return require('./update-end').updateStep(w.packet.raw,kind,journal.timeScan?'0':journal.anchor,cursor,w.ids,{knownIds});
}
function verifyDeltaResume(saved,windows,dir,kind,uid,current){
 const refs=saved.deltaPackets||[];
 const originalPackets=new Set(saved.packets.map(ref=>ref.hash+'\0'+ref.file));
 // Older journals used the original packet list for their delta prefix.
 const chain=refs.length?refs:saved.packets.filter(ref=>(!saved.ready||!samePacket(ref,saved.ready))&&(ref.maxId===''||ref.sinceId&&ref.sinceId===saved.anchor));
 let cursor='',echo=false,verify=false,head='',connected=false;
 const since=saved.since?saved.anchor:'';
 for(const [index,ref] of chain.entries()){
  const packet=restorePacket(ref,dir),q=packet.query;
  const scoped=q?.taskId===saved.id;
  if(originalPackets.has(ref.hash+'\0'+ref.file)&&!scoped)throw resumeError();
  if(!Number.isSafeInteger(ref.count)||ref.count<1||ref.count>200||q&&(q.uid!==uid||q.kind!==kind||q.page!==1)||!q&&packet.file!==require('./storage').cacheFile(dir,kind,ref.count,ref.maxId,ref.sinceId||'',1))throw resumeError();
  if(index===0&&(!scoped||ref.maxId!==''||(ref.sinceId||'')!==since))throw resumeError();
  if(q&&/^cache\/request-journal\//.test(ref.file))require('./request-journal').verifySavedResponse(dir,ref);
  const w=windows.add(packet,ref.count,ref.maxId,ref.sinceId||'',false,{allowEcho:current});
  if(connected)throw resumeError();
  if(scoped||w.echo){if(ref.maxId!==cursor||w.sinceId!==since)throw resumeError();}
  else if(saved.timeScan||!cursor||w.floor==null||w.upper==null||BigInt(cursor)<w.floor||BigInt(cursor)>w.upper||BigInt(w.sinceId||0)>BigInt(saved.anchor))throw resumeError();
  if(!head&&w.ids.length)head=w.ids[0];
  const terminalIds=!w.ids.length&&w.next==='0'?[...windows.bodies].filter(([id,e])=>!saved.timeScan||latest.newer({id:saved.anchor,ms:saved.comparisonMs},{id,ms:e.row.ms}).id===id).map(([id])=>id):[];
  const step=deltaStep(w,kind,saved,cursor,terminalIds);
  if(step.ambiguous||w.echo&&echo||!step.connected&&!step.next)throw resumeError();
  connected=step.connected;
  cursor=connected?saved.anchor:step.next;echo=!!w.echo;verify=!connected&&step.verify&&!verify;
 }
 if(connected!==saved.deltaComplete||(head||connected&&saved.anchor||'')!==saved.head)throw resumeError();
 if(saved.phase==='body')return;
 if(connected||cursor!==saved.cursor||!!saved.cursorVerification!==echo||!!saved.verifyDelta!==verify)throw resumeError();
 if(saved.request&&(saved.request.phase!=='collect'||saved.request.max!==cursor||saved.request.since!==since))throw resumeError();
 if(saved.ready){
  if(saved.ready.maxId!==cursor||(saved.ready.sinceId||'')!==since||chain.some(ref=>samePacket(ref,saved.ready))||!saved.packets.some(ref=>samePacket(ref,saved.ready)))throw resumeError();
  const {query}=require('./request-journal').verifySavedResponse(dir,saved.ready);
  if(query.uid!==uid||query.kind!==kind||query.taskId!==saved.id||query.page!==1||query.count!==saved.ready.count||query.maxId!==cursor||query.sinceId!==since)throw resumeError();
 }
}
function checkMiddleResume(dir,kind,opts){
 try{
  const saved=readProgress(dir,kind,opts);
  if(!saved?.anchor)throw resumeError();
  verifyDeltaResume(saved,createWindows(dir,kind,opts.uid,opts.cacheSession),dir,kind,opts.uid,!!saved.currentComparison);
 }catch{throw resumeError();}
}
function reliable(state){return !!state?.checkedAt&&state.origin==='data-update-v1'&&!state.baselineUnverified;}
function harvestData(opts,dir,kind,budget,flags={},fetchPage=getOne){
 if(budget<=0)return {kind,budget,rows:[],fetched:0,newFetched:0,requests:0,cachedCalls:0,reason:'该方向额度为 0',ended:false};
 const quick=opts.update||opts.syncOperation==='quick';
 const current=opts.latestCheck&&latest.supported(kind)&&!(opts.from||opts.to)&&!Number.isFinite(opts.beforeMs)&&!opts.autoInitialBaseline&&!opts.legacyQuickResume;
 if(current&&opts.resumeScope&&quick&&!fs.existsSync(progressFile(dir,kind,opts))){
  const state=readState(dir,kind,opts.uid);
  if(state?.pending?.ownerScopes?.includes(opts.taskScopeId)&&state.pending.packets?.length){
   for(const ref of state.pending.packets){const p=restorePacket(ref,dir);if(p.query&&(p.query.uid!==opts.uid||p.query.kind!==kind))throw resumeError();}
   return harvestData({...opts,legacyQuickResume:true},dir,kind,budget,flags,fetchPage);
  }
 }
 if(current)return regular({...opts,currentComparison:true,quick},dir,kind,budget,flags,fetchPage);
 if(quick){
  const state=require('./incremental').prepareUpdateState(dir,kind,opts.uid),pending=progressFile(dir,kind,{beforeMs:null});
  if((!reliable(state)&&!state?.pending)||fs.existsSync(pending)&&JSON.parse(fs.readFileSync(pending)).status==='pending'&&!state){
   require('./events').emit('phase',{phase:'baseline',kind,message:ENDPOINTS[kind].label+'：正在首次读取，按当前上限建立可靠更新起点'});
   console.log(`[${ENDPOINTS[kind].label}] 正在首次读取：按当前上限常规更新，更早历史另行记录。`);
   const result=regular({...opts,update:false,syncOperation:'regular',beforeMs:null,startMs:undefined,from:'',to:''},dir,kind,budget,flags,fetchPage);result.initialRead=true;return result;
  }
  // The incremental engine owns independent pending chains and never pads the
  // quick operation with older history. Its first returned body is reused.
  let wire=0;const maxReturn=opts.returnBudget??budget;
  const result=require('./incremental').harvestUpdates({...opts,quickOnly:true,strictBaseline:true},dir,kind,Math.min(budget,maxReturn),flags,(o,d,k,n,max,since)=>{
   cancel.check();const allowed=Math.min(n,maxReturn-wire);if(allowed<1)throw Error('达到本次新增返回预算，位置保留');
   const p=fetchPage(o,d,k,allowed,max,since);if(p&&!p.cached)wire+=rawArray(p.raw,k)?.items.length||0;return p;
  });
  result.cancelled=cancel.cancelled();result.reusedCount=result.rows.filter(r=>r.provenance?.type!=='api').length;result.coveredCount=result.rows.length;
  return result;
 }
 return regular(opts,dir,kind,budget,flags,fetchPage);
}
function regular(opts,dir,kind,budget,flags,fetchPage){return withLock(dir,kind,()=>{
 const current=opts.currentComparison,quick=opts.quick;
 const windows=createWindows(dir,kind,opts.uid,opts.cacheSession),archive=windows.archive,evidence=createCollectionEvidence(dir,kind,opts.uid),selected=new Map(),local=new Set();
 const out={kind,budget,rows:[],fetched:0,newFetched:0,requests:0,cachedCalls:0,cacheTimes:[],name:'',reason:'',ended:false,failed:false,regular:true};
 const dated=!!(opts.from||opts.to)||Number.isFinite(opts.beforeMs);
 const returnLimit=opts.returnBudget??budget,oldState=dated||current?readState(dir,kind,opts.uid):require('./incremental').prepareUpdateState(dir,kind,opts.uid,{locked:true});
 const baseline=!dated&&(reliable(oldState)||oldState?.pending)?oldState:null;
 const comparison=current&&(!opts.resumeScope||opts.resumeUnstarted)?latest.comparison(dir,kind,opts.uid,windows.bodies,oldState):null;
 const file=progressFile(dir,kind,opts);
 if(current&&quick&&!comparison)out.initialRead=true;
 if(opts.autoInitialBaseline){if(oldState?.checkedAt||oldState?.pending||oldState?.sinceDisabled)throw require('./auto-follow-budget').safety('AUTO_BASELINE','原检查点或未完成区间已变化，未重新初始化');opts.autoGuard.beginInitial(kind,dir);}
 const initialIds=new Set(windows.bodies.keys()),knownWireIds=new Set(initialIds),maxCalls=opts.pages??Infinity;let emptyWindows=0,wireCalls=0,firstWire=true,journal,timeKnown=null;
 const save=()=>atomicJson(file,journal);
 function packetRef(p,count,max,since){if(p.receipt)return {...p.receipt,count,maxId:max,sinceId:since,stamp:p.cacheTimeMs};if(!p.file||!p.responseHash)throw Error('原始响应尚未保存，不能提交读取进度');return {...reference(p,count,max,since),file:path.relative(dir,p.file)};}
 function receive(count,max='',since='',phase='collect'){
  cancel.check();if(opts.offline)throw Object.assign(Error('离线数据不足以核实范围；未发起联网请求'),{code:'OFFLINE_LIMIT'});
  if(opts.autoInitialBaseline&&max){
   const firstBody=journal.packets.findIndex(ref=>rawArray(restorePacket(ref,dir).raw,kind)?.items.length);
   if(firstBody>=0){
    const first=journal.packets[firstBody],low=rawArray(restorePacket(first,dir).raw,kind).items.at(-1);
    const id=exactId(low.idstr??low.id);
    if(journal.packets.length!==firstBody+1||!id||BigInt(max)>=BigInt(id))throw Object.assign(Error('首次订阅只检查最新窗口，较早区间保留'),{code:'REQUEST_LIMIT'});
   }
  }
  const previous=journal.request;
  if(previous){
   if(previous.max!==max||previous.since!==since||previous.phase!==phase)throw resumeError();
   const original={uid:opts.uid,kind,count:previous.count,maxId:max,sinceId:since,page:1,taskId:journal.id};
   if(require('./request-journal').recover(dir,original))count=previous.count;
   else{if(require('./request-journal').unknown(dir,original))throw Object.assign(Error('原请求结果尚未核实，未重复取数'),{code:'REQUEST_EVIDENCE_INVALID'});count=Math.min(count,returnLimit-out.newFetched);}
  }else count=Math.min(count,returnLimit-out.newFetched);
  if(opts.autoInitialBaseline&&count>0&&!previous){
   count=opts.autoGuard.maxCount(kind,count);
   if(count<1)throw require('./auto-follow-budget').safety(opts.autoGuard.stopCode,opts.autoGuard.stopReason);
  }
  if(wireCalls>=maxCalls)throw Object.assign(Error('达到新增请求上限，数据和续取位置已保存'),{code:'REQUEST_LIMIT'});
  if(count<1)throw Object.assign(Error('达到本次新增返回预算，数据和续取位置已保存'),{code:'RETURN_LIMIT'});
  journal.request={count,max,since,phase};save();
  let packet;try{packet=fetchPage({...opts,dataTaskId:journal.id,knownRecordIds:knownWireIds,refresh:true,offline:false},dir,kind,count,max,since);}catch(error){wireCalls+=require('./collection-failure').accountFailure(out,error).apiCalls;throw error;}
  if(!packet)throw Error('未取得有效数据响应');out.requests++;if(packet.cached)out.cachedCalls++;else{wireCalls++;out.newFetched+=rawArray(packet.raw,kind)?.items.length||0;}
  evidence.add(packet,count,max,phase,since);let w;
  try{w=windows.add(packet,count,max,since,true,{allowEcho:current});}catch(error){
   // A lower bound is only an optimization for a manual older-history gap.
   // Retain the rejected response and its real return cost, never certify it.
   // Automatic/new-interval checks keep their strict since_id safety stop.
   if(error.code!=='SINCE_BOUNDARY_IGNORED'||!since||journal.phase!=='body'||phase!=='collect'||opts.autoGuard)throw error;
   journal.gapSinceDisabled=true;journal.ready=null;delete journal.request;journal.rejectedPackets??=[];
   const ref=packetRef(packet,count,max,since);if(!journal.rejectedPackets.some(p=>p.hash===ref.hash))journal.rejectedPackets.push({...ref,reason:'since-boundary-ignored'});save();
   require('./events').emit('phase',{phase:'verify-history',kind,message:'历史分页下界未生效：保留已返回数据，用最多 1 条核验上界后继续'});
   return receive(1,max,'',phase);
  }
  if(!out.name)out.name=targetNickname(packet.raw,kind,opts.uid);
  const missing=require('./update-end').missingMetadata(packet.raw,kind,{anchor:since,cursor:max,next:w.next});
  if(phase==='collect'&&missing.uncertain){out.coverageUnverified=true;journal.unknownMissing=true;}
  journal.gapIds=[...new Set([...(journal.gapIds||[]),...w.ids.filter(id=>!windows.bodies.has(id)),...[...missing.ids].filter(id=>!windows.bodies.has(id))])];
  if((!packet.cached||packet.recoveredRequest)&&packet.file){const ref=packetRef(packet,count,max,since);if(!journal.packets.some(p=>p.hash===ref.hash&&p.file===ref.file))journal.packets.push(ref);journal.ready=ref;}
  delete journal.request;
  // Raw bytes are atomically stored by getOne before any position is saved.
  save();
  if(phase==='collect'&&opts.noteNewRecords)opts.noteNewRecords(w.rows.filter(row=>isNewBody(row.recordId)&&w.completeIds.has(row.recordId)));
  return w;
 }
 function isNewBody(id){return !initialIds.has(id)&&(!journal.quickOnly||qualifies(id,windows.bodies.get(id)?.row));}
 function eligible(row){return completeBody(row)&&row.ms<=(opts.beforeMs??Infinity)&&row.ms>=(opts.startMs??-Infinity);}
 function qualifies(id,row){return eligible(row)&&(!journal?.quickOnly||id!==journal.anchor&&(!Number.isFinite(journal.comparisonMs)||latest.newer({id:journal.anchor,ms:journal.comparisonMs},{id,ms:row.ms}).id===id));}
 function select(id){const e=windows.bodies.get(id);if(!e||!qualifies(id,e.row)||selected.has(id))return;
  selected.set(id,{...e.row,provenance:e.provenance});if(initialIds.has(id))local.add(id);if(selected.size>budget){const keep=new Set(sortRecords([...selected.values()]).slice(0,budget).map(r=>r.recordId));for(const old of selected.keys())if(!keep.has(old)){selected.delete(old);local.delete(old);}}}
 const neededGap=id=>!windows.bodies.has(id)&&(journal?.timeScan||!selected.size||selected.size<budget||BigInt(id)>=BigInt(sortRecords([...selected.values()]).at(-1).recordId));
 function notify(){out.fetched=selected.size;require('./events').emit('collection',{kind,phase:'collect',regular:true,fetched:selected.size,budget:Number.isFinite(budget)?budget:null,newReturned:out.newFetched,reused:local.size,returnLimit:Number.isFinite(returnLimit)?returnLimit:null});}
 function writeProgress(value){const result=require('./update-progress').commit(stateFile(dir,kind),journal.checkpointToken,value);if(result.ok){journal.checkpointToken=result.token;save();return true;}journal.superseded=true;out.progressConflict=true;out.progressNotice=result.reason;return false;}
 const ownsCheckpoint=()=>!current||(!oldState||!oldState.importedEvidence&&journal.anchor===oldState.anchor&&(!oldState.pending||oldState.pending.id===journal.id));
 function checkpoint(){
  if(dated||!journal.head||journal.usedEcho||journal.timeScan||!ownsCheckpoint()||current&&(!journal.latestChecked||!journal.deltaComplete||out.coverageUnverified))return;
  // A first finite baseline certifies only the requested recent range. A
  // preexisting anchor can move only after its entire new interval connects.
  if(baseline&&!journal.deltaComplete||!baseline&&out.coverageUnverified)return;
  if(journal.checkpointCommitted)return;
  if(oldState?.anchor===journal.head&&(journal.ownerScopes||[]).length&&journal.ownerScopes.every(scope=>require('./update-progress').connectedScope(stateFile(dir,kind),scope))){journal.checkpointCommitted=true;save();return;}
  const unresolved=new Set([...(oldState?.gaps?.unresolvedIds||[]),...journal.gapIds.filter(id=>baseline&&BigInt(id)>BigInt(journal.anchor)&&BigInt(id)<=BigInt(journal.head))]);for(const id of unresolved)if(windows.bodies.has(id))unresolved.delete(id);
  const state={...(oldState||{}),gaps:{...(oldState?.gaps||{}),unresolvedIds:[...unresolved]},schema:1,uid:opts.uid,kind,anchor:journal.head,checkedAt:new Date().toISOString(),pending:null,baselineUnverified:false,connectedProof:{id:journal.id,scopes:journal.ownerScopes||[],lower:baseline?journal.anchor:null,upper:journal.head,initial:!baseline,packets:journal.deltaPackets?.length?journal.deltaPackets:[...journal.packets,...(journal.reusedDeltaPackets||[])]},origin:'data-update-v1',endPolicyVersion:2,visibleEnd:!!out.ended,scope:{recentLimit:Number.isFinite(budget)?budget:null,olderHistoryComplete:!!out.ended},lastAttempt:{at:new Date().toISOString(),connected:true,reason:out.reason},proof:journal.packets};
  if(writeProgress(state)){journal.checkpointCommitted=true;save();}
 }
 try{
  let saved=null;
  if(opts.resumeScope){saved=readProgress(dir,kind,opts);if(!saved&&!opts.resumeUnstarted)throw resumeError();}
  else try{if(fs.existsSync(file))saved=JSON.parse(fs.readFileSync(file));}catch{out.reason='上次读取进度无法识别，原文件保留；重新核实本地分页关系。';}
  if(!oldState?.userSkippedTasks?.includes(saved?.id)&&!oldState?.userSkippedScopes?.includes(opts.taskScopeId)&&(saved?.status==='pending'||saved?.status==='complete'&&opts.taskScopeId)&&saved.schema===1&&saved.uid===opts.uid&&saved.kind===kind&&Array.isArray(saved.packets)&&Array.isArray(saved.selectedIds)){
   for(const ref of saved.packets){const p=restorePacket(ref,dir);if(opts.resumeScope&&(p.query&&(p.query.uid!==opts.uid||p.query.kind!==kind||p.query.taskId!==saved.id)||!p.query&&!path.basename(ref.file).startsWith(kind+'_')))throw resumeError();windows.add(p,ref.count,ref.maxId,ref.sinceId||'',true,{allowEcho:current});}
   if(opts.resumeScope&&saved.ready&&!saved.packets.some(ref=>samePacket(ref,saved.ready)))throw resumeError();
   if(opts.resumeScope&&(saved.phase==='delta'||opts.fillMiddle&&saved.anchor))verifyDeltaResume(saved,windows,dir,kind,opts.uid,current);
   journal=saved;firstWire=!saved.cursor;for(const id of saved.selectedIds)select(id);out.resumed=true;
  }else{
   if(opts.resumeScope&&(!opts.resumeUnstarted||opts.fillMiddle))throw resumeError();
   const anchor=current?comparison?.id||'':opts.autoInitialBaseline?'':baseline?.anchor||windows.latest()?.ids[0]||'';
   journal={id:crypto.randomUUID(),...(current?{currentComparison:true,firstComparison:!comparison,quickOnly:!!quick&&!!comparison}:{}),checkpointToken:require('./update-progress').token(stateFile(dir,kind)),schema:1,uid:opts.uid,kind,status:'pending',startedAt:new Date().toISOString(),scope:{from:opts.from||'',to:opts.to||''},cursor:'',phase:anchor?'delta':'body',anchor,head:'',deltaComplete:!anchor,selectedIds:[],packets:[],missingAttempts:[],since:!!flags.updateSince?.[kind]&&!oldState?.sinceDisabled&&(!current||!comparison||comparison.id===baseline?.anchor||!Array.from(windows.bodies).some(([id,e])=>BigInt(id)>BigInt(comparison.id)&&e.row.ms<comparison.ms))};
   if(journal.quickOnly){
    // A lower numeric bound can hide a later comment the first time ID and
    // timestamp order disagree. Follow the visible pagination without it.
    if(Number.isFinite(comparison.ms))journal.comparisonMs=comparison.ms;
    journal.timeScan=true;journal.since=false;
   }
  }
  journal.ownerScopes=[...new Set([...(journal.ownerScopes||[]),...(!current||baseline?.pending?.id===journal.id?baseline?.pending?.ownerScopes||[]:[]),...(opts.taskScopeId?[opts.taskScopeId]:[])])];journal.id??=crypto.randomUUID();journal.checkpointToken??=journal.anchor===oldState?.anchor?require('./update-progress').token(stateFile(dir,kind)):'legacy-stale';journal.gapIds??=[];journal.historicalMissingIds??=[...new Set([...(current?[]:oldState?.gaps?.unresolvedIds||[]),...(saved?.schema===1&&saved.uid===opts.uid&&saved.kind===kind?[...(saved.gapIds||[]),...(saved.historicalMissingIds||[])]:[])])].map(exactId).filter(Boolean);journal.lastAttemptAt=new Date().toISOString();save();
  if(journal.timeScan)timeKnown=new Set([...initialIds].filter(id=>qualifies(id,windows.bodies.get(id).row)&&!selected.has(id)));
  if(Number.isFinite(opts.beforeMs)){
   // Date location reuses hash-checked boundary capsules and cached windows.
   // The same budget/cancellation wrapper covers navigation AND collection.
   const r=require('./history').harvestBefore({...opts,refresh:false,syncRegular:true},dir,kind,budget,(o,d,k,n,max,since)=>receive(n,max,since,'seek').packet);
   Object.assign(out,r);out.rows=r.rows.filter(completeBody);out.fetched=out.rows.length;out.newFetched=Math.max(out.newFetched,r.newFetched);out.regular=true;out.reusedCount=out.rows.filter(r=>initialIds.has(r.recordId)).length;
   out.cancelled=cancel.cancelled();if(out.rows.length<r.rows.length){out.coverageUnverified=true;out.reason+='；不完整正文不计覆盖条数';}
   journal.status=out.cancelled||require('./limits').sourceIncomplete(out)?'pending':'complete';journal.reason=out.reason;journal.lastAttemptAt=new Date().toISOString();journal.selectedIds=out.rows.map(r=>r.recordId);save();out.resumePending=journal.status==='pending';out.readProgress={deltaConnected:!!journal.deltaComplete,targetCovered:out.fetched>=budget||out.ended,status:out.cancelled?'interrupted':journal.status,covered:out.fetched,reused:out.reusedCount,newReturned:out.newFetched,pending:out.resumePending,from:opts.from||'',to:opts.to||'',lastAttemptAt:journal.lastAttemptAt};return out;
  }
  if(!current&&!out.resumed&&baseline?.pending){const p=baseline.pending;for(const ref of p.packets){const packet=restorePacket(ref,dir);windows.add(packet,ref.count,ref.maxId,p.since?baseline.anchor:'');journal.packets.push({...ref,sinceId:p.since?baseline.anchor:''});for(const item of rawArray(packet.raw,kind).items)if(BigInt(item.idstr??item.id)>BigInt(baseline.anchor))select(String(item.idstr??item.id));}journal.deltaPackets=p.packets.map(ref=>({...ref,sinceId:p.since?baseline.anchor:''}));journal.cursor=p.cursor;journal.head=p.head;journal.phase='delta';journal.since=p.since;journal.selectedIds=[...selected.keys()];firstWire=false;save();}
  function fillMissing(id,hints=[]){
   if(opts.autoInitialBaseline){out.coverageUnverified=true;journal.missingAttempts.push(id);return;}
   const cached=windows.missingProbe(id),observed=!opts.recheckMissing&&windows.missingObservation(id);let checked=[id];
   if(observed){checked=observed.observedMissing.filter(value=>neededGap(value)&&!journal.missingAttempts.includes(value));out.coverageUnverified=true;journal.missingObservations??=[];journal.missingObservations.push({ids:checked,response:packetRef(observed.packet,observed.count,observed.maxId,observed.sinceId)});require('./events').emit('phase',{phase:'repair-bodies',kind,message:ENDPOINTS[kind].label+'：复用刚保存的 '+checked.length+' 个暂缺正文观测，沿服务端游标继续；不代表删除或历史完整'});}
   else if(cached){out.requests++;out.cachedCalls++;evidence.add(cached.packet,cached.count,cached.maxId,'collect',cached.sinceId);}
   else{
    const band=windows.at(id);
    const targets=flags.updateSince?.[kind]&&!journal.gapSinceDisabled?[...new Set([id,...journal.gapIds,...hints])].filter(value=>neededGap(value)&&!journal.missingAttempts.includes(value)&&!windows.missingProbe(value)&&BigInt(value)<=BigInt(id)&&(value===id||band&&band.floor!=null&&band.upper!=null&&BigInt(value)>=band.floor&&BigInt(value)<=band.upper)).sort((a,b)=>BigInt(a)>BigInt(b)?-1:1).slice(0,Math.min(opts.pageSize,Math.max(1,returnLimit-out.newFetched))):[id];
    const since=targets.length>1?(BigInt(targets.at(-1))-1n).toString():'';
    require('./events').emit('phase',{phase:'repair-bodies',kind,message:ENDPOINTS[kind].label+'：正在核对 '+targets.length+' 个已知缺正文 ID；缺失与历史未知范围保留'});
    const w=receive(targets.length||1,id,since);
    checked=targets.filter(value=>value===id||w.floor!=null&&w.upper!=null&&BigInt(value)>=w.floor&&BigInt(value)<=w.upper);
    if(targets.length>1){journal.missingBatches??=[];journal.missingBatches.push({ids:checked,response:packetRef(w.packet,w.count,w.maxId,w.sinceId)});}
   }
   journal.missingAttempts=[...new Set([...journal.missingAttempts,...checked])];journal.ready=null;for(const value of checked)select(value);save();
  }
  if(current&&out.resumed&&journal.status==='complete'&&journal.deltaComplete){
   out.ended=!!journal.ended;
  }
  const localOnly=current&&opts.offline&&!out.resumed&&!quick;
  if(localOnly){
   for(const id of windows.bodies.keys())select(id);
   if(selected.size<budget)throw Object.assign(Error('本地资料不足以达到本次条数目标'),{code:'OFFLINE_LIMIT'});
   journal.deltaComplete=true;
  }
  const visited=new Set();
  while(!(current&&out.resumed&&journal.status==='complete'&&journal.deltaComplete)&&!((journal.quickOnly||opts.fillMiddle)&&journal.deltaComplete)&&(selected.size<budget||journal.cursorVerification||out.resumed&&journal.phase==='delta'&&!journal.deltaComplete||journal.gapIds.some(id=>neededGap(id)&&!journal.missingAttempts.includes(id)))){
   const gap=!opts.autoInitialBaseline&&!journal.request&&journal.gapIds.find(id=>neededGap(id)&&!journal.missingAttempts.includes(id));if(gap){fillMissing(gap);continue;}
   cancel.check();const sig=journal.phase+'/'+journal.cursor;if(visited.has(sig))throw Error('分页位置重复，已停止异常循环');visited.add(sig);
   if(journal.phase==='delta'){
    const anchor=journal.anchor,remaining=Math.max(1,budget-selected.size);let w;
    if(journal.ready&&journal.ready.maxId===journal.cursor){w=windows.add(restorePacket(journal.ready,dir),journal.ready.count,journal.ready.maxId,journal.ready.sinceId||'',true,{allowEcho:current});journal.ready=null;}
    else if(journal.cursor&&!journal.timeScan&&!journal.request)w=windows.at(journal.cursor,anchor,{localProof:current});
    if(!w)w=receive(Math.min(firstWire||journal.verifyDelta||journal.cursorVerification?1:opts.pageSize,remaining),journal.cursor,journal.since?anchor:'');
    else{out.requests++;out.cachedCalls++;evidence.add(w.packet,w.count,w.maxId,'collect',w.sinceId);}
    firstWire=false;journal.ready=null;
    if(current&&(!journal.cursor||journal.latestChecked)){
     journal.latestChecked=true;
     journal.observedHead=w.rows.reduce((best,row)=>latest.newer(best,w.completeIds.has(row.recordId)?latest.point(row,kind,opts.uid):null),journal.observedHead||null);
    }
    if(!journal.head&&w.ids.length)journal.head=w.ids[0];
    if(journal.timeScan){for(const id of w.ids)if(w.completeIds.has(id)){select(id);timeKnown.delete(id);}}
    else for(const id of [...windows.bodies.keys()].filter(id=>BigInt(id)>BigInt(anchor)&&(!journal.cursor||BigInt(id)<=BigInt(journal.cursor))&&w.floor!=null&&BigInt(id)>=w.floor).sort((a,b)=>BigInt(a)>BigInt(b)?-1:1))select(id);
    if(w.echo&&journal.cursorVerification)throw Object.assign(Error('收到评论接口再次返回原游标，已保留完整评论和待核对位置'),{code:'PAGINATION_BOUNDARY'});
    journal.cursorVerification=!!w.echo;
    if(w.echo)journal.usedEcho=true;
    const missing=require('./update-end').missingMetadata(w.packet.raw,kind,{anchor:journal.since?anchor:'',cursor:journal.cursor,next:w.next});
    if(missing.uncertain){out.coverageUnverified=true;journal.unknownMissing=true;}
    const step=deltaStep(w,kind,journal,journal.cursor,[...(timeKnown||initialIds)]);
    if(step.ambiguous){out.coverageUnverified=true;throw Object.assign(Error('新增结束依据不足，保留原始区间和成功位置'),{code:'DELTA_END_UNVERIFIED'});}
    const deltaRef=packetRef(w.packet,w.count,w.maxId,w.sinceId),refs=journal.deltaPackets||!journal.cursor?(journal.deltaPackets??=[]):(journal.reusedDeltaPackets??=[]);if(!refs.some(p=>p.hash===deltaRef.hash&&p.maxId===deltaRef.maxId))refs.push(deltaRef);
    if(step.connected){journal.deltaComplete=true;journal.phase='body';journal.cursor=anchor;if(!journal.head)journal.head=anchor;journal.verifyDelta=false;}
    else{
     journal.cursor=step.next;journal.verifyDelta=step.verify&&!journal.verifyDelta;
     emptyWindows=w.ids.length?0:emptyWindows+1;
     if(emptyWindows>=(opts.emptyWindowLimit??20)){
      journal.selectedIds=[...selected.keys()];save();
      throw Object.assign(Error('达到连续空窗口保护上限，已保存本次核对位置'),{code:'REQUEST_LIMIT'});
     }
    }
   }else{
    const cursor=journal.cursor;let w=journal.ready&&journal.ready.maxId===cursor?windows.add(restorePacket(journal.ready,dir),journal.ready.count,journal.ready.maxId,journal.ready.sinceId||'',true,{allowEcho:current}):cursor&&!journal.cursorVerification&&!journal.request?windows.at(cursor):null;journal.ready=null;
    if(opts.autoInitialBaseline&&journal.head&&cursor&&!journal.request&&(w||initialIds.has(cursor))){
     out.initialWindowComplete=true;
     break;
    }
    if(w?.echo){
     for(const id of w.ids)select(id);
     if(journal.cursorVerification)throw Object.assign(Error('收到评论接口再次返回原游标，已保留完整评论和待核对位置'),{code:'PAGINATION_BOUNDARY'});
     journal.cursor=(BigInt(w.low)-1n).toString();journal.cursorVerification=true;journal.usedEcho=true;
     journal.selectedIds=[...selected.keys()];save();notify();continue;
    }
    if(w){
     out.requests++;out.cachedCalls++;evidence.add(w.packet,w.count,w.maxId,'collect',w.sinceId);
     const ids=[...windows.bodies.keys()].filter(id=>(!cursor||BigInt(id)<=BigInt(cursor))&&BigInt(id)>=w.floor).sort((a,b)=>BigInt(a)>BigInt(b)?-1:1);
     for(const id of ids)select(id);
     // A missing body inside a needed window gets one targeted attempt; an
     // unavailable response never counts as complete and never loops forever.
     const metadata=require('./update-end').missingMetadata(w.packet.raw,kind,{anchor:w.sinceId,cursor,next:w.next});
     const missing=[...w.ids,...metadata.ids].filter(id=>!windows.bodies.has(id)&&(!cursor||BigInt(id)<=BigInt(cursor))&&BigInt(id)>=w.floor);
     for(const id of missing){if(selected.size>=budget&&BigInt(id)<BigInt([...selected.keys()].at(-1)))continue;if(journal.missingAttempts.includes(id)){out.coverageUnverified=true;continue;}fillMissing(id,missing);if(!windows.bodies.has(id))out.coverageUnverified=true;}
     journal.cursorVerification=false;
     journal.cursor=(w.floor-1n).toString();
     if(w.rows.some(r=>r.ms<(opts.startMs??-Infinity))){out.ended=true;out.rangeComplete=true;break;}
    }else if(cursor&&windows.point(cursor)&&!journal.request){
     select(cursor);journal.cursor=(BigInt(cursor)-1n).toString();
    }else{
     const older=journal.cursorVerification||(opts.autoInitialBaseline||current&&!journal.latestChecked)&&!cursor?null:windows.bandBelow(cursor),since=older&&flags.updateSince?.[kind]&&!journal.gapSinceDisabled?older.id:'';
     // Without a usable lower bound, narrow gap probes avoid bulk-returning
     // an already saved band. Every real return still counts against budget.
     // A single latest row provides the cursor needed to reuse saved bands on a first check.
     const probeHead=!cursor&&(opts.autoInitialBaseline||current&&windows.windows.length>0);
     const count=Math.min(opts.pageSize,Math.max(1,budget-selected.size),journal.cursorVerification||probeHead||older&&!since||journal.verifyEnd?1:Infinity);
     w=receive(count,cursor,journal.request?.since??since);journal.ready=null;if(!journal.head&&w.ids.length)journal.head=w.ids[0];
     if(current&&!journal.anchor&&!journal.observedHead){
      if(!cursor)journal.latestChecked=true;
      if(journal.latestChecked)journal.observedHead=w.rows.reduce((best,row)=>latest.newer(best,w.completeIds.has(row.recordId)?latest.point(row,kind,opts.uid):null),journal.observedHead||null);
     }
     for(const id of w.ids)select(id);
     if(w.echo){
      if(journal.cursorVerification)throw Object.assign(Error('收到评论接口再次返回原游标，已保留完整评论和待核对位置'),{code:'PAGINATION_BOUNDARY'});
      journal.cursor=(BigInt(w.low)-1n).toString();journal.cursorVerification=true;journal.usedEcho=true;
      journal.selectedIds=[...selected.keys()];save();notify();continue;
     }
     journal.cursorVerification=false;
     if(w.rows.some(r=>r.ms<(opts.startMs??-Infinity))){out.ended=true;out.rangeComplete=true;break;}
     if(!w.ids.length){emptyWindows++;if(w.next==null)throw Error('空响应没有续取游标，范围尚未核实');}else emptyWindows=0;
     if(emptyWindows>=(opts.emptyWindowLimit??20)&&w.next!=='0')throw Error('达到连续空窗口保护上限，位置已保存；可调整上限后继续');
     if(w.next==='0'){
      if(opts.autoInitialBaseline&&w.ids.length&&cursor){out.initialWindowComplete=true;journal.cursor=since;break;}
      if(w.sinceId){journal.cursor=w.sinceId;}
      else if(w.ids.length){journal.cursor=(BigInt(w.low)-1n).toString();journal.verifyEnd=!opts.autoInitialBaseline;}
      else{const olderBodies=[...windows.bodies.keys()].filter(id=>!cursor||BigInt(id)<=BigInt(cursor)),terminal=require('./update-end').updateStep(w.packet.raw,kind,'0',cursor,[],{knownIds:olderBodies});if(terminal.ambiguous){out.coverageUnverified=true;throw Error('空末页与已保存的更早数据矛盾，不能宣称历史已读完');}for(const id of olderBodies)select(id);out.ended=true;break;}
     }else{if(!w.next&&!w.low)throw Error('没有可靠续取位置');journal.cursor=w.next||(BigInt(w.low)-1n).toString();journal.verifyEnd=false;}
    }
   }
   journal.selectedIds=[...selected.keys()];save();
   if(!journal.timeScan&&!journal.usedEcho&&ownsCheckpoint()&&baseline&&!journal.deltaComplete&&journal.cursor&&BigInt(journal.cursor)>BigInt(baseline.anchor)){const refs=journal.deltaPackets?.[0]?.maxId===''?journal.deltaPackets:journal.packets.filter(p=>!p.sinceId||p.sinceId===baseline.anchor);if(refs.length&&refs[0].maxId==='')writeProgress({...oldState,pending:{id:journal.id,ownerScopes:journal.ownerScopes||[],verify:!!journal.verifyDelta,cursor:journal.cursor,head:journal.head||baseline.anchor,page:refs.length,startedAt:journal.startedAt,packets:refs,since:journal.since}});}
   notify();
   if(opts.fillMiddle&&journal.deltaComplete&&!journal.cursorVerification)break;
   if(journal.cursor==='0'&&journal.phase==='body'){out.ended=true;break;}
  }
  if(journal.usedEcho){
   out.coverageUnverified=true;
   out.stopCode='PAGINATION_BOUNDARY';
   out.reason='收到评论接口曾回显原游标，完整返回已保存；原区间仍待核实';
  }
  if(journal.unknownMissing||[...journal.gapIds,...(journal.historicalMissingIds||[])].some(neededGap))out.coverageUnverified=true;
  if(!journal.usedEcho)out.reason=out.rangeComplete?'已读取至起始日期（包含当天），本次日期范围已完成':out.ended?'已到本次接口可见末尾（不代表从未保存或不可见的历史完整）':'已覆盖本次目标范围';
  if(journal.quickOnly&&(!journal.timeScan||!Number.isFinite(journal.comparisonMs)))out.coverageUnverified=true;
  if(journal.quickOnly&&journal.deltaComplete&&!journal.usedEcho)out.reason=out.coverageUnverified?'本次检查的新增范围仍待核实':selected.size?'已保存本次检查返回的新增互动':'检查完成，未发现新增';
  if(!journal.usedEcho&&(selected.size>=budget||out.ended||out.initialWindowComplete||journal.quickOnly&&journal.deltaComplete)){
   journal.status='complete';journal.ended=out.ended;journal.completedWithMissingBodies=!!out.coverageUnverified;checkpoint();
  }
  if(!wireCalls&&local.size&&!journal.usedEcho)out.reason='本地复用 '+local.size+' 条';
  if([...journal.gapIds,...(journal.historicalMissingIds||[])].some(neededGap))out.reason+='；部分已知正文未返回，缺失证据已保留';
  if(!current&&baseline&&!journal.deltaComplete){journal.status=selected.size>=budget?'complete':'pending';out.pendingNew=true;out.reason+='；仍有新增待读取，成功检查位置未推进';}
 }catch(error){if(opts.resumeScope&&!journal)throw resumeError();out.stopCode=error.code||null;out.cancelled=error.code==='USER_CANCELLED'||cancel.cancelled();out.failed=!out.cancelled&&!['REQUEST_LIMIT','RETURN_LIMIT'].includes(error.code);out.returnLimited=error.code==='RETURN_LIMIT';if(journal?.cursorVerification)out.coverageUnverified=true;out.reason=error.message;journal??={id:crypto.randomUUID(),checkpointToken:'invalid-journal',schema:1,uid:opts.uid,kind,packets:[],selectedIds:[],gapIds:[]};journal.status='pending';}
 if(current)out.pendingNew=false;
 if(current&&!journal.firstComparison&&journal.anchor&&!journal.deltaComplete&&journal.latestChecked&&journal.cursor){
  journal.status='pending';
  if(!out.resumed&&!out.failed&&!out.cancelled&&(selected.size>=budget||['REQUEST_LIMIT','RETURN_LIMIT'].includes(out.stopCode))){
   out.pendingNew=true;out.reason+='；本次新增与读取开始时的记录之间仍有未读取区间';
  }else if(out.resumed&&!out.failed&&!out.cancelled)out.pendingNew=true;
 }
 // A complete newest body is independent of the later pagination result.
 // An interrupted initial observation still has to finish before initializing.
 const canRecordLatest=current&&journal.latestChecked&&(journal.firstComparison
  ?!journal.pointSaved&&journal.status==='complete'&&!out.failed&&!out.cancelled&&!out.coverageUnverified
  :!out.resumed);
 if(canRecordLatest){
  const initialPoint=journal.observedHead;
  const success=journal.status==='complete'&&journal.deltaComplete&&!out.failed&&!out.cancelled&&!out.coverageUnverified;
  if(initialPoint||success&&(journal.anchor||out.ended&&windows.bodies.size===0)){
   latest.remember(dir,kind,opts.uid,initialPoint||null,{success,external:!!journal.timeScan});
   journal.pointSaved=true;
  }
 }
 if(opts.fillMiddle&&!journal.usedEcho&&journal.deltaComplete&&!out.failed&&!out.cancelled&&!journal.cursorVerification){journal.status='complete';out.pendingNew=false;}
 if(opts.fillMiddle&&journal.status==='pending'&&journal.cursor)out.pendingNew=true;
 out.unknownMissing=!!journal.unknownMissing;
 if(journal.quickOnly){
  const timeOrderVerified=!!journal.timeScan&&Number.isFinite(journal.comparisonMs)&&!!journal.latestChecked&&!!journal.deltaComplete&&!out.failed&&!out.cancelled&&!out.coverageUnverified;
  out.update={resumed:!!out.resumed,reusedCount:local.size,newReturned:out.newFetched,returnLimit:Number.isFinite(returnLimit)?returnLimit:null,limited:['REQUEST_LIMIT','RETURN_LIMIT'].includes(out.stopCode),anchor:journal.anchor,caughtUp:timeOrderVerified,timeOrderVerified,verifiedNoNew:timeOrderVerified&&!selected.size,pending:journal.status==='pending',newCount:[...selected.keys()].filter(id=>!initialIds.has(id)).length,intervalId:journal.id,checkpointCommitted:journal.status==='pending'&&!!journal.cursor};
 }
 out.rows=sortRecords([...selected.values()]);out.fetched=out.rows.length;out.coveredCount=out.fetched;out.reusedCount=local.size;out.returnLimit=Number.isFinite(returnLimit)?returnLimit:null;
 journal.selectedIds=[...selected.keys()];journal.lastAttemptAt=new Date().toISOString();journal.reason=out.reason;save();out.resumePending=journal.status==='pending'||!!out.pendingNew;
 out.partial=out.resumePending||out.cancelled;out.readProgress={deltaConnected:!!journal.deltaComplete&&!journal.usedEcho,targetCovered:out.fetched>=budget||out.ended,status:out.cancelled?'interrupted':out.resumePending?'pending':journal.status,covered:out.fetched,reused:local.size,newReturned:out.newFetched,pending:out.resumePending,pendingNew:!!out.pendingNew,cursor:journal.cursor,from:opts.from||'',to:opts.to||'',lastAttemptAt:journal.lastAttemptAt,scopeFinishedAt:journal.status==='complete'?journal.lastAttemptAt:null,lastSuccessAt:readState(dir,kind,opts.uid)?.checkedAt||null};
 if(out.progressNotice)out.reason+='；'+out.progressNotice;notify();const result=evidence.finish({...out,incremental:true},archive,opts);result.rows=out.rows;result.fetched=out.fetched;result.newRows=sortRecords([...windows.bodies].filter(([id])=>isNewBody(id)).map(([,e])=>({...e.row,provenance:e.provenance})));result.reusedCount=out.reusedCount;result.coveredCount=out.fetched;result.missingBodyIds=[...new Set([...journal.gapIds,...(journal.historicalMissingIds||[])])].filter(neededGap);return result;
});}
module.exports={harvestData,progressFile,reliable,taskDirections,readProgress,checkMiddleResume,resumeError};
