'use strict';
// Explicit local user decisions are not connected-range proofs. Keep the skipped
// chain durably before choosing a verified latest response as a future baseline.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('../lib/update-progress'),I=require('../lib/incremental'),access=require('../lib/workspace-access'),regular=require('../lib/regular-file');
const root=base=>path.join(require('../lib/data-layout').readerRoot(base),'gap-choices');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const local=(base,folder)=>access.directory(base,path.relative(base,folder));
function token(task,states){return crypto.createHash('sha256').update(JSON.stringify([task.id,task.status,task.query?._scopeId,task.summary?.sources,states.map(s=>s&&[s.kind,s.anchor,s.revision,s.pending])])).digest('hex');}
function dirFor(base,uid){const S=require('../lib/storage'),p=S.storagePaths(base);return S.mappedFolder(p.users,uid,S.indexRead(p.users));}
const Proof=require('../lib/gap-choice-proof'),{verifiedHead}=Proof;
// A preview is a read-only, short-lived proposal. It is never itself authority
// for a request; only a committed, revalidated decision can be used by reserve.
const previews=new Map(),PREVIEW_MS=5*60000;
function futureState(state,decision,proof){
 if(decision.baselineAction==='retain-current-head')return {...state,userUnknownChoices:[...(state?.userUnknownChoices||[]),decision.id],userUnknownChoiceHashes:{...state?.userUnknownChoiceHashes,[decision.id]:decision.authorizationHash}};
 const scopes=[...new Set([...(state?.pending?.ownerScopes||[]),decision.manual.scope])],tasks=[state?.pending?.id].filter(Boolean),previous=state?.anchor||null;
 const value={...(state||{}),schema:1,uid:decision.uid,kind:decision.kind,anchor:proof.head,checkedAt:proof.checkedAt,pending:null,origin:'data-update-v1',endPolicyVersion:2,baselineUnverified:false,visibleEnd:false,scope:{recentLimit:1,olderHistoryComplete:false},
  gaps:{...state?.gaps,unresolvedIds:[...new Set([...(state?.gaps?.unresolvedIds||[]),...(proof.missingIds||[])])],unidentifiedMissing:Math.max(state?.gaps?.unidentifiedMissing||0,proof.unidentifiedMissing||0)},
  baselineScope:'user-selected-latest-head',userGapChoices:[...(state?.userGapChoices||[]),decision.id],userUnknownChoices:[...(state?.userUnknownChoices||[]),decision.id],userUnknownChoiceHashes:{...state?.userUnknownChoiceHashes,[decision.id]:decision.authorizationHash},
  userSkippedScopes:[...new Set([...(state?.userSkippedScopes||[]),...scopes])],userSkippedTasks:[...new Set([...(state?.userSkippedTasks||[]),...tasks])],
  userSelectedHead:{decisionId:decision.id,at:decision.at,previousAnchor:previous,head:proof.head,proof:proof.ref,packets:proof.packets,adoptions:proof.adoptions,historyStatus:'user-skipped-unverified',unknownRequests:decision.unknowns.length},
  lastAttempt:{...state?.lastAttempt,userDecisionAt:decision.at,reason:'用户保留旧未确认区间及费用证据，仅从本次已校验手动响应继续后续新评论'}};
 delete value.connectedProof;return value;
}
function futureProjection(base,input){
 const manual=Proof.manualEvidence(base,input),{uid,kind,taskId}=input,dir=manual.dir,state=I.readState(dir,kind,uid),checkpoint=P.token(I.stateFile(dir,kind));
 if(Proof.usedManual(base,dir,uid,kind,taskId,manual.taskBinding))throw Error('该手动响应已经用于明确授权，原历史续读仍保留，请勿重复确认');
 if(state&&BigInt(state.anchor)>=BigInt(manual.proof.head)&&state.pending)throw Error('当前相同或更高起点仍有独立待读区间，未用旧手动响应清除；请先核对该区间');
 const retained=state&&BigInt(state.anchor)>BigInt(manual.proof.head)?Proof.retainedHead(dir,kind,uid,state):null;
 if((state?.userUnknownChoices||[]).length>=128)throw Error('本地选择记录数量已达安全上限，请先检查原证据');
 const unknowns=Proof.unknownSnapshot(base,dir,uid,kind,manual.proof.checkedAt),{file,task,...savedManual}=manual;
 const binding={schema:1,workspace:fs.realpathSync(base),uid,kind,taskId,checkpoint,manual:savedManual,unknowns,pendingToken:Proof.pendingToken(base,uid,kind),retainedHeadProof:retained};
 delete binding.manual.dir;
 return {binding,dir,state};
}
function previewFuture(base,input,{now=Date.now}={}){
 const at=now(),{binding}=futureProjection(base,input);
 for(const [key,value]of previews)if(value.expiresAt<=at)previews.delete(key);
 if(previews.size>=16)previews.delete(previews.keys().next().value);
 const token=crypto.randomUUID(),expiresAt=at+PREVIEW_MS;previews.set(token,{binding,createdAt:at,expiresAt});
 return {schema:1,token,expiresAt:new Date(expiresAt).toISOString(),uid:binding.uid,kind:binding.kind,source:'cli',targetKind:'user',taskId:binding.taskId,scope:binding.manual.scope,head:binding.manual.proof.head,currentHead:binding.retainedHeadProof?.head||binding.manual.proof.head,checkedAt:binding.manual.proof.checkedAt,responseHash:binding.manual.proof.ref.hash,query:JSON.parse(require('../lib/regular-file').read(I.restorePacket(binding.manual.proof.ref,dirFor(base,binding.uid)).file)).query,
  requests:binding.unknowns.map(v=>({roundId:v.roundId,requestId:v.requestId,at:v.request.at,count:v.request.count,maxId:v.request.maxId||'',sinceId:v.request.sinceId||'',status:'unknown',requestHash:v.requestHash,reservedCredits:v.request.reservedCredits})),
  retainedReservedCredits:Number(binding.unknowns.reduce((n,v)=>n+v.request.reservedCredits,0).toFixed(6)),
  warning:'保留旧未确认区间及费用证据，基于本次已校验完整手动响应继续后续新评论；这不表示旧区间已补齐，不会自动联网、启停订阅或标记已读。'};
}
function futureCandidates(base,{uid,kind,limit=20}){
 if(typeof uid!=='string'||!/^\d{5,20}$/.test(uid)||!['sent','received'].includes(kind)||!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('候选任务的用户、方向或数量无效');
 const candidates=[],warnings=[],tasks=require('./user-workspace').tasks(base).filter(t=>t.uid===uid&&(t.query?.source||'cli')==='cli'&&['comments-'+kind,'comments-both'].includes(t.query?.mode)).slice(0,80);
 for(const task of tasks){
  if(candidates.length>=limit)break;
  try{const evidence=Proof.manualEvidence(base,{uid,kind,taskId:task.id});if(Proof.usedManual(base,evidence.dir,uid,kind,task.id,evidence.taskBinding))continue;candidates.push({taskId:task.id,scope:evidence.scope,uid,kind,source:'cli',targetKind:'user',status:task.status,startedAt:task.startedAt,finishedAt:task.finishedAt||null,head:evidence.proof.head,checkedAt:evidence.proof.checkedAt,responseHash:evidence.proof.ref.hash});}
  catch{if(warnings.length<8)warnings.push({taskId:task.id,message:'该手动任务缺少可核实的完整最新响应，未列为可选择起点'});}
 }
 return {uid,kind,candidates,warnings};
}
function chooseFuture(base,{uid,kind,taskId,expected,confirmation,authorization},hooks={}){
 if(confirmation!=='preserve-unknown-use-manual-head')throw Error('请先明确确认保留旧未知区间及费用，只继续未来新评论');
 const held=previews.get(expected),at=(hooks.now||Date.now)();
 if(!held||at<held.createdAt||at>=held.expiresAt||held.binding.workspace!==fs.realpathSync(base)||held.binding.uid!==uid||held.binding.kind!==kind||held.binding.taskId!==taskId)throw Error('恢复预览已过期或不属于当前对象，请重新预览');
 if(pending(base).length)throw Error('另一次本地选择尚待安全保存，请先完成本地恢复');
 const {binding,dir,state}=futureProjection(base,{uid,kind,taskId,responseHash:held.binding.manual.proof.ref.hash});
 if(Proof.digest(binding)!==Proof.digest(held.binding))throw Error('检查位置、手动响应或未知请求已改变，请重新预览');
 const audit=authorization==null?{source:'local-explicit-confirmation'}:authorization;
 if(!audit||!['local-explicit-confirmation','user-via-adviser'].includes(audit.source)||Object.keys(audit).some(k=>!['source','reference','statementHash'].includes(k))||audit.source==='local-explicit-confirmation'&&Object.keys(audit).some(k=>k!=='source')||audit.source==='user-via-adviser'&&(typeof audit.reference!=='string'||audit.reference.length<1||audit.reference.length>160||/[\r\n\x00-\x1f]/.test(audit.reference)||!/^[a-f0-9]{64}$/.test(audit.statementHash||'')))throw Error('明确授权的审计来源无效');
 const decision={schema:1,id:crypto.randomUUID(),mode:'future-from-manual',baselineAction:state&&BigInt(state.anchor)>=BigInt(binding.manual.proof.head)?'retain-current-head':'select-manual-head',authorizedLower:binding.manual.proof.head,retainedHeadProof:binding.retainedHeadProof,source:'cli',targetKind:'user',workspace:binding.workspace,uid,kind,taskId,scope:binding.manual.scope,manual:binding.manual,unknowns:binding.unknowns,pendingToken:binding.pendingToken,expectedCheckpoint:binding.checkpoint,originalStateHash:Proof.digest(state),authorization:{...audit},at:new Date(at).toISOString(),status:'prepared',reason:'user-preserved-unknown-future-head',steps:[]};
 decision.authorizationHash=Proof.futureAuthorization(decision);
 const value=futureState(state,decision,binding.manual.proof);decision.steps.push({kind,expected:binding.checkpoint,previous:state,value,proof:binding.manual.proof.ref});
 require('../lib/workspace-access').directory(base,path.relative(base,root(base)),{create:true});
 const file=path.join(root(base),decision.id+'.json');require('../lib/durable-write').atomic(file,decision);previews.delete(expected);hooks.fault?.('after-intent');apply(base,file,hooks);
 return {id:decision.id,uid,kind,head:value.anchor,retainedUnknownRequests:decision.unknowns.length};
}
function applyFuture(base,file,decision,{fault=()=>{}}={}){
 require('../lib/workspace-access').directory(base,path.relative(base,root(base)));
 if(decision.workspace!==fs.realpathSync(base)||decision.source!=='cli'||decision.targetKind!=='user'||!['sent','received'].includes(decision.kind)||decision.steps.length!==1||!Array.isArray(decision.unknowns)||!decision.unknowns.length||decision.unknowns.length>128)throw Error('后续起点选择身份无效，原证据保留');
 const {uid,kind}=decision,dir=dirFor(base,uid),step=decision.steps[0],target=I.stateFile(dir,kind),current=I.readState(dir,kind,uid),manual=Proof.manualEvidence(base,{uid,kind,taskId:decision.taskId,responseHash:decision.manual?.proof?.ref?.hash},decision.manual);
 if(step.kind!==kind||step.value?.userUnknownChoiceHashes?.[decision.id]!==decision.authorizationHash||decision.authorizedLower!==manual.proof.head||BigInt(step.value.anchor)<BigInt(manual.proof.head)||step.expected!==decision.expectedCheckpoint||Proof.digest(step.previous)!==decision.originalStateHash||decision.authorizationHash!==Proof.futureAuthorization(decision)||!['retain-current-head','select-manual-head'].includes(decision.baselineAction)||decision.baselineAction==='retain-current-head'&&(BigInt(step.previous?.anchor||0)<BigInt(manual.proof.head)||step.previous?.pending))throw Error('后续起点的原始响应无法核实');
 if(decision.retainedHeadProof&&Proof.digest(Proof.retainedHead(dir,kind,uid,step.previous))!==Proof.digest(decision.retainedHeadProof))throw Error('保留的更高起点证据发生变化');
 if(decision.baselineAction!=='retain-current-head'&&manual.task.userGapChoice&&manual.task.userGapChoice.id!==decision.id)throw Error('原手动任务已有不同选择，原数据保留');
 for(const q of decision.unknowns)Proof.sameUnknown(base,dir,uid,kind,q);
 if(!current?.userUnknownChoices?.includes(decision.id)){
  if(P.token(target)!==step.expected||Proof.pendingToken(base,uid,kind)!==decision.pendingToken)throw Error('检查位置或未知请求已更新，原数据保留，请重新预览');
  const saved=P.commit(target,step.expected,futureState(current,decision,manual.proof));if(!saved.ok)throw Error(saved.reason);fault('after-progress',kind);
 }else if(BigInt(current.anchor)<BigInt(manual.proof.head))throw Error('已保存选择的后续起点不一致');
 if(decision.baselineAction!=='retain-current-head')P.atomic(manual.file,{...manual.task,userGapChoice:{id:decision.id,at:decision.at,reason:decision.reason}});fault('after-task');
 // The prepared decision remains replayable until dependent writes are durable.
 for(const targetFile of [target,...(decision.baselineAction==='retain-current-head'?[]:[manual.file])]){const fd=require('../lib/regular-file').open(targetFile);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const parent=fs.openSync(path.dirname(targetFile),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
 decision.status='committed';decision.committedAt=new Date().toISOString();require('../lib/durable-write').atomic(file,decision);return decision;
}
function selectedState(state,decision,proof){
 const p=state.pending,scopes=[...new Set(p.ownerScopes||[])];
 const value={...state,anchor:proof.head,pending:null,checkedAt:proof.checkedAt,origin:'data-update-v1',endPolicyVersion:2,baselineUnverified:false,visibleEnd:false,
   gaps:{...state.gaps,unresolvedIds:[...new Set([...(state.gaps?.unresolvedIds||[]),...(proof.missingIds||[])])],...(proof.unidentifiedMissing?{unidentifiedMissing:Math.max(state.gaps?.unidentifiedMissing||0,proof.unidentifiedMissing)}:{})},
   baselineScope:'user-selected-latest-head',userGapChoices:[...(state.userGapChoices||[]),decision.id],userSkippedScopes:[...new Set([...(state.userSkippedScopes||[]),...scopes])],userSkippedTasks:[...new Set([...(state.userSkippedTasks||[]),p.id])],
   userSelectedHead:{decisionId:decision.id,at:decision.at,previousAnchor:state.anchor,head:proof.head,proof:proof.ref,packets:proof.packets,adoptions:proof.adoptions,historyStatus:'user-skipped-unverified'},
   lastAttempt:{...state.lastAttempt,userDecisionAt:decision.at,reason:'用户忽略中间未读取区间，后续检查从已核实的最新保存记录继续'}};
 delete value.connectedProof;return value;
}
function readChoice(file){
 const id=path.basename(file,'.json');
 const invalid=()=>Error('忽略区间的本地恢复记录损坏：'+path.basename(file));
 if(!uuid(id))throw invalid();
 const decision=JSON.parse(regular.read(file,{maxBytes:16*1024*1024}));
 if(decision?.schema!==1||decision.id!==id||typeof decision.uid!=='string'||!/^\d{5,20}$/.test(decision.uid)||!uuid(decision.taskId)||!uuid(decision.scope)||!['prepared','committed'].includes(decision.status))throw invalid();
 return decision;
}
function pendingEntries(base){
 const folder=local(base,root(base));if(!fs.existsSync(folder))return [];
 const entries=[];
 for(const name of fs.readdirSync(folder).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
  const file=path.join(folder,name);
  try{const decision=readChoice(file);if(decision.status==='prepared')entries.push({file,decision});}
  catch(error){entries.push({file,error});}
 }
 return entries;
}
function pending(base){return pendingEntries(base).map(e=>e.file);}
function taskEnded(task,legacy){
 if(['partial','complete','interrupted','failed'].includes(task.status))return true;
 if(!legacy||task.status!=='running'||!Number.isSafeInteger(task.pid)||task.pid<1)return false;
 try{process.kill(task.pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
function boundChoice(base,decision){
 const {uid,steps}=decision,invalid=()=>Error('原用户、评论方向或任务身份无法核实，忽略记录保留');
 if(!Array.isArray(steps)||!steps.length||steps.length>2)throw invalid();
 const kinds=steps.map(step=>step?.kind);
 if(new Set(kinds).size!==kinds.length||steps.some(step=>!['sent','received'].includes(step?.kind)||step.value?.uid!==uid||step.value.kind!==step.kind))throw invalid();
 if(decision.mode==='future-from-manual'){
  if(decision.workspace!==fs.realpathSync(base)||decision.source!=='cli'||decision.targetKind!=='user'||kinds.length!==1||decision.kind!==kinds[0]||decision.authorizationHash!==Proof.futureAuthorization(decision))throw invalid();
 }else if(decision.mode!==undefined||decision.reason!=='user-ignored-middle-interval'||steps.some(step=>step.value.userSelectedHead?.decisionId!==decision.id))throw invalid();
 const tasks=local(base,path.join(require('../lib/data-layout').readerRoot(base),'manual-tasks'));
 const taskFile=path.join(tasks,decision.taskId+'.json'),task=JSON.parse(regular.read(taskFile,{maxBytes:16*1024*1024})),q=task?.query;
 const parseUid=require('./ui/form-utils').uid;
 if(task?.schema!==1||task.id!==decision.taskId||task.uid!==uid||task.automatic||!taskEnded(task,decision.mode===undefined)||!q?.syncOnly||q.source&&q.source!=='cli'||parseUid(q.target)!==uid||q.subject&&(q.subject.kind!=='user'||q.subject.uid!==uid)||q._scopeId!==decision.scope||q.from||q.to||q.before||kinds.some(kind=>!['comments-'+kind,'comments-both'].includes(q.mode))||task.userGapChoice&&task.userGapChoice.id!==decision.id)throw invalid();
 return {uid,kinds,taskFile,task};
}
function apply(base,file,hooks={},decision=readChoice(file),binding=boundChoice(base,decision)){
 const {fault=()=>{}}=hooks;
 if(decision.status==='committed')return decision;
 if(decision.mode==='future-from-manual')return applyFuture(base,file,decision,hooks);
 if(binding.task.resumedBy)throw Error('原任务已有后续任务，忽略记录保留');
 const dir=dirFor(base,decision.uid);local(base,path.join(dir,'cache/updates'));
 for(const step of decision.steps){
  if(!['sent','received'].includes(step.kind)||step.value?.uid!==decision.uid||step.value.kind!==step.kind||step.value.userSelectedHead?.decisionId!==decision.id)throw Error('忽略区间恢复身份无效');
  const target=I.stateFile(dir,step.kind),current=I.readState(dir,step.kind,decision.uid);
  if((current?.userGapChoices||[]).includes(decision.id))continue;
  // A later successful run or a different pending chain cannot be overwritten.
  if(P.token(target)!==step.expected)throw Error('检查位置已被另一任务更新；原数据保留，请重新关闭当前提示');
  if(!current?.pending?.ownerScopes?.includes(decision.scope))throw Error('当前待补区间不属于原任务，忽略记录保留');
  const proof=verifiedHead(dir,step.kind,decision.uid,current);
  if(proof.head!==step.value.anchor||proof.ref.hash!==step.proof.hash)throw Error('忽略区间的最新响应发生变化');
  const write=P.commit(target,step.expected,selectedState(current,decision,proof));if(!write.ok)throw Error(write.reason);
  fault('after-progress',step.kind);
 }
 const current=boundChoice(base,decision);
 if(Proof.digest(current.task)!==Proof.digest(binding.task))throw Error('原任务发生变化，忽略记录保留');
 if(!current.task.userGapChoice)P.atomic(current.taskFile,{...current.task,userGapChoice:{id:decision.id,at:decision.at,reason:'user-ignored-middle-interval'}});fault('after-task');
 decision.status='committed';decision.committedAt=new Date().toISOString();P.atomic(file,decision);return decision;
}
function reviewPending(base,retry,message='忽略区间的本地操作尚待安全保存'){
 let entries;try{entries=pendingEntries(base);}catch(error){return [{file:'gap-choices',uid:null,message:error.message}];}
 const issues=[];
 for(const {file,decision,error} of entries){
  let bound;
  try{if(error)throw error;bound=boundChoice(base,decision);if(retry){apply(base,file,{},decision,bound);continue;}}
  catch(error){issues.push({file:path.basename(file),uid:bound?.uid||null,kinds:bound?.kinds,message:error.message});continue;}
  issues.push({file:path.basename(file),uid:bound.uid,kinds:bound.kinds,message});
 }
 return issues;
}
function blockedKinds(issues,entry){
 if(entry?.targetKind==='post'||(entry?.source||'cli')!=='cli')return [];
 const kinds=entry?.mode==='sent'||entry?.mode==='received'?[entry.mode]:['sent','received'];
 return kinds.filter(kind=>issues.some(issue=>!issue.uid||issue.uid===entry?.uid&&(!issue.kinds||issue.kinds.includes(kind))));
}
function recover(base){return reviewPending(base,true);}
function issues(base,message){return reviewPending(base,false,message);}
function choose(base,{uid,id,expected},hooks={}){
 if(!/^\d{5,20}$/.test(uid)||!/^[a-f0-9-]{36}$/.test(id))throw Error('用户或原任务编号无效');
 const recoverErrors=recover(base);if(recoverErrors.length)throw Error(recoverErrors.map(e=>e.message).join('；'));
 const task=require('./user-workspace').tasks(base).find(t=>t.id===id&&t.uid===uid);
 if(!task||task.resumedBy||task.status==='running')throw Error('原任务已改变，请刷新后重试');
 if(task.userGapChoice)return {id:task.userGapChoice.id,uid,repeated:true};
 const dir=dirFor(base,uid),states=['sent','received'].map(kind=>I.readState(dir,kind,uid));
 if(token(task,states)!==expected)throw Error('该提示的进度已改变，请刷新后重试');
 const description=require('./task-status').describe(task,require('./task-status').journals(dir,uid),states,dir);
 if(!description.targetCovered||!description.directions?.some(d=>d.pendingNew))throw Error('这不是已满足条数的中间待补区间，保留原任务');
 const scope=task.query?._scopeId;if(!scope||task.query.from||task.query.to||task.query.before)throw Error('指定日期任务不能改变全局检查起点');
 const decision={schema:1,id:crypto.randomUUID(),uid,taskId:id,scope,at:new Date().toISOString(),status:'prepared',reason:'user-ignored-middle-interval',steps:[]};
 for(const state of states){
  const p=state?.pending;if(!p||!p.ownerScopes?.includes(scope))continue;
  const proof=verifiedHead(dir,state.kind,uid,state);
  // The original pending packets, fixed lower boundary and all historical
  // missing-body evidence remain in this write-ahead decision record.
  const value=selectedState(state,decision,proof);
  delete value.connectedProof;decision.steps.push({kind:state.kind,expected:P.token(I.stateFile(dir,state.kind)),previous:state,value,proof:proof.ref});
 }
 if(!decision.steps.length)throw Error('未找到与原任务绑定的最新响应；未修改检查位置');
 boundChoice(base,decision);
 const file=path.join(access.directory(base,path.relative(base,root(base)),{create:true}),decision.id+'.json');P.atomic(file,decision);hooks.fault?.('after-intent');apply(base,file,hooks);return {id:decision.id,uid,heads:decision.steps.map(s=>({kind:s.kind,anchor:s.value.anchor}))};
}
module.exports={token,verifiedHead,pending,recover,issues,blockedKinds,choose,previewFuture,chooseFuture,futureCandidates};
