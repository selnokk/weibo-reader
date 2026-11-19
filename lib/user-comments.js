'use strict';
const fs=require('node:fs'),path=require('node:path');
const {MODES,ENDPOINTS,hasBefore,beforeDisplay,plan,rawArray,apiError,preflight,normalize,targetNickname,sortRecords,terminalTarget}=require('./core');
const {indexRead,mappedFolder,commitName,storagePaths,legacy,getOne}=require('./storage');
const {render}=require('./reader');
const {createCreditMeter}=require('./credits');
const {localConversationContext}=require('./conversation-context');
const {limitLabel,sourceIncomplete}=require('./limits');
const {commandName}=require('./config');
const {reportShortcut,createProgress,requestPolicy,sourceSummary}=require('./terminal-report');
const {loadIndependentArchive,createCollectionEvidence,completenessDiagnostics,persistCollectionRun}=require('./completeness');
function harvest(opts,dir,kind,budget,preflightInfo,fetchPage=getOne){
 if(opts.syncOnly&&!opts.autoGuard)return require('./data-update').harvestData({...opts,latestCheck:!!opts.taskScopeId},dir,kind,budget,preflightInfo,fetchPage);
 if(opts.update)return require('./incremental').harvestUpdates(opts,dir,kind,budget,preflightInfo,fetchPage,()=>harvest({...opts,update:false,refresh:true,updateBootstrap:true},dir,kind,budget,preflightInfo,fetchPage));
 if(hasBefore(opts))return harvestBefore(opts,dir,kind,budget,fetchPage);
 const out={kind,budget,rows:[],activityRows:[],fetched:0,newFetched:0,requests:0,cachedCalls:0,cacheTimes:[],name:'',reason:'',ended:false,failed:false};
 if(budget<=0){out.reason='此分类分配 0 条';return out;}
 const session=opts.cacheSession||require('./cache-session').createCacheSession();opts={...opts,cacheSession:session};
 const archive=loadIndependentArchive(dir,kind,opts.uid,session),evidence=createCollectionEvidence(dir,kind,opts.uid);
 const progress=createProgress(opts),endGuard=require('./comment-end').createEndGuard(archive),index=historyIndex(dir,kind,opts.uid,!opts.refresh,{conservativeTerminal:true,session});
 let verifyEnd=false,forceEndCheck=false;out.endVerification={checks:0,status:'not-needed'};
 const uniq=new Map(),cursors=new Set();let maxId='';
 const allowedCursor=kind!=='mentions-comments'||preflightInfo?.commentsMentionCursor!==false;
 for(let page=1;;page++){
   const remaining=budget-uniq.size;if(remaining<=0){out.reason='已达到请求条数预算';break;}
   if(page>1&&!allowedCursor){out.reason='接口未声明 max_id，安全停止';break;}
   const returnRemaining=opts.updateBootstrap?budget-out.newFetched:Infinity;
   if(returnRemaining<=0){out.returnLimited=true;out.reason='达到本次新增返回条数上限，已保存首次基线';break;}
   const wanted=Math.min(verifyEnd?1:opts.pageSize,remaining,returnRemaining),capped=out.requests-out.cachedCalls>=opts.pages;
   let packet;
   if(forceEndCheck&&(opts.offline||capped)){out.coverageUnverified=true;out.reason=opts.offline?'末页缓存与已知记录或总数矛盾，离线无法核实；不能确认已读完':'达到 --pages 上限，末页尚未核实；已有记录保留';break;}
   if(!forceEndCheck&&!opts.refresh&&maxId)packet=index.read(wanted,maxId);
   try{if(!packet)packet=fetchPage({...opts,refresh:opts.refresh||forceEndCheck,offline:opts.offline||capped},dir,kind,wanted,maxId);}catch(error){out.failed=true;out.reason=`第 ${page} 次请求失败：${error.message}`;progress.end();require('./collection-failure').accountFailure(out,error);break;}
   if(!packet){if(verifyEnd)out.coverageUnverified=true;out.reason=capped?'达到 --pages 新增 API 请求上限，尚未取满目标；已有缓存已保留':'离线模式无更多对应缓存，尚未取满目标';break;}
   out.requests++;if(packet.cached)out.cachedCalls++;
   if(packet.cached&&Number.isFinite(packet.cacheTimeMs))out.cacheTimes.push(packet.cacheTimeMs);
   const {raw,cached}=packet,parsed=rawArray(raw,kind);
   if(!parsed||apiError(raw)){out.failed=true;out.reason=apiError(raw)||'响应缺少记录数组';break;}
   const checkingEnd=verifyEnd;
   if(checkingEnd){endGuard.check();out.endVerification.checks=endGuard.checks;}
   evidence.add(packet,wanted,maxId,checkingEnd?'verify-end':'collect');
   if(!out.name)out.name=targetNickname(raw,kind,opts.uid);
   const returned=parsed.items,items=cached?returned.slice(0,wanted):returned;
   if(!cached)out.newFetched+=returned.length;
   let bad='';const ids=[];
   for(const c of items){
    try{const id=historyRecordId(c);ids.push(id);if(maxId&&BigInt(id)>BigInt(maxId)){bad='接口返回 ID 超过 max_id，已停止以免重复或遗漏';continue;}}
    catch(error){bad=error.message;continue;}
    const row=normalize(c,kind,opts.uid),key=row.recordId||`${row.authorUid}/${row.time}/${row.content}`;
    if(kind==='sent'&&row.authorUid!==opts.uid){bad='发出评论的作者 UID 与目标不一致，已停止';continue;}
    // Only unique independent records fulfill --limit; duplicates and quotes do not.
    if(!uniq.has(key)&&uniq.size<budget)uniq.set(key,row);if(!cached&&!maxId)out.activityRows.push(row);
   }
   out.fetched=uniq.size;require('./events').emit('collection',{kind,phase:opts.updateBootstrap?'update':'collect',fetched:uniq.size,budget:Number.isFinite(budget)?budget:null,newReturned:out.newFetched,returnLimit:opts.updateBootstrap&&Number.isFinite(budget)?budget:null});
   progress.update(`${opts.creditMeter?opts.creditMeter.progress()+' · ':''}${ENDPOINTS[kind].label} · ${uniq.size}/${limitLabel(budget)} 条 · API ${out.requests-out.cachedCalls} 次`, `  #${page} ${ENDPOINTS[kind].command.join(' ')} --count ${wanted}${maxId?' --max_id '+maxId:''} | ${cached?'缓存':'API'}返回 ${returned.length} 条，去重 ${uniq.size} / ${limitLabel(budget)} 条`);
   if(bad){out.failed=true;out.reason=bad;break;}
   try{index.add(raw,maxId,'',packet.cacheTimeMs||Date.now(),true,packet);}catch(error){out.failed=true;out.reason=error.message;break;}
   if(!cached&&returned.length>wanted){out.reason='接口返回数超过请求数量，原始响应已保存，已停止后续请求';break;}
   if(uniq.size>=budget){out.reason='已达到请求条数预算';break;}
   let next;
   try{next=historyNext(raw,kind);}catch(error){out.failed=true;out.reason=error.message;break;}
   // A larger cache's continuation belongs to the entire saved page. When
   // using only its prefix, continue from the last consumed ID instead.
   if(cached&&items.length<returned.length)next=null;
   const end=endGuard.inspect(raw,kind,ids,wanted,uniq.size,maxId);out.reportedTotal=endGuard.total;
   if(next==='0'){
    if(items.length&&(checkingEnd||end.suspicious)){
     if(!end.low||BigInt(end.low)<=1n){out.coverageUnverified=true;out.reason='非空末页标记与已知记录矛盾，无法继续核验';break;}
     // A returned probe is a formal independent record and refutes the
     // previous end claim. Resume normal page sizes after that one record.
     verifyEnd=!checkingEnd;forceEndCheck=false;out.endVerification.status='pending';
     next=(BigInt(end.low)-1n).toString();
    }else if(!items.length&&cached&&(checkingEnd||end.suspicious)){
     verifyEnd=true;forceEndCheck=true;out.endVerification.status='pending';
     progress.detail('  旧空页不能核实当前末尾，将用最多 1 条的新请求检查；不作为日期定位或删除证据。');continue;
    }else{
     out.ended=true;out.endVerification.status=cached?'cached-end':'verified';
     out.reason=cached?'已到缓存所示的接口可见末尾（不代表当前或全部历史完整）':'接口返回空页 / 末尾标记，已核验本次当前可见范围末尾';break;
    }
   }else if(checkingEnd){verifyEnd=false;forceEndCheck=false;out.endVerification.status='continued';}

   if(!items.length&&next==null){out.reason='空响应未提供续取游标，无法确认是否到达末尾；已保存现有记录';break;}
   if(next==null){
    if(!ids.length){out.reason='返回记录缺少 ID，无法安全继续';break;}
    const lowest=ids.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);
    if(BigInt(lowest)<=1n){out.ended=true;out.reason='已读到最小有效 ID';break;}
    next=(BigInt(lowest)-1n).toString();
   }
   if(cursors.has(next)||(maxId&&BigInt(next)>=BigInt(maxId))){out.failed=true;out.reason='续取游标重复或未推进，已安全停止，完整性尚未确认';break;}
   if(ids.length&&BigInt(next)>BigInt(ids.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b))){out.failed=true;out.reason='服务器续取游标没有越过本页记录，已停止';break;}
   cursors.add(next);maxId=next;
 }
 progress.end();out.rows=[...uniq.values()];
 const result=evidence.finish(out,archive,opts);
 if(!Number.isFinite(budget)&&endGuard.totalMismatch(result.rows.length)){result.coverageUnverified=true;result.reason+=`；接口报告 ${endGuard.total} 条，本地去重保存 ${result.rows.length} 条，统计 / 可见范围尚有差异，不能认定全部历史完整`;}
 if(result.endVerification.status==='pending'){result.coverageUnverified=true;result.endVerification.status='unverified';}
 return result;
}
const {harvestBefore,historyIndex,historyNext,historyRecordId,HISTORY_PROBE_LIMIT}=require('./history');
function combinedResult(o,results){
 const sent=results.find(r=>r.kind==='sent');
 const received=results.find(r=>r.kind==='received');
 const byId=new Map();
 for(const [res,label] of [[sent,'发出'],[received,'收到']]){
   if(!res)continue;
   for(const r of res.rows){
     const row={...r,type:label,group:'both'};
     const key=r.recordId||`${r.authorUid}/${r.time}/${r.content}`;
     if(byId.has(key))byId.get(key).type='发出/收到';
     else byId.set(key,row);
   }
 }
 return {kind:'both',rows:[...byId.values()],sources:[sent,received].filter(Boolean)};
}
function runUserComments(o){
 o.syncStartedAt=new Date().toISOString();
 const p=plan(o).filter(x=>!o.gapBudget||o.gapBudget.kinds.includes(x.kind));
 let remaining=o.gapBudget?.limit;
 require('./events').emit('plan',{sources:p.map(x=>({kind:x.kind,budget:Number.isFinite(x.budget)?x.budget:null})),update:!!o.update});
 const layout=storagePaths(),root=layout.users,index=indexRead([root,layout.oldUsers,layout.legacy].find(dir=>fs.existsSync(path.join(dir,'.account_names.json')))||root);
 const knownNickname=typeof index[o.uid]?.nickname==='string'?index[o.uid].nickname:'';
 console.log(`目标：${terminalTarget(o.uid,knownNickname)} | ${commandName(o.mode)} | ${Number.isFinite(o.count)?`${o.syncOnly?'本次取数每项最多':o.update?'本次新返回 / 报告每项最多':'每项最多'} ${o.count} 条`:'不限总条数，读取全部可见记录'}`);
 if(o.verbose)console.log(`分页：自动继续；${Number.isFinite(o.pages)?`每接口最多新增 API ${o.pages} 次（缓存不占额度）`:'新增 API 次数不限'}；每页最多 ${o.pageSize} 条。`);
 console.log(requestPolicy(o));
 if(o.syncOnly&&!o.autoGuard)console.log(o.update?'快速检查更新：只保存成功位置之后的新增；没有可靠起点的方向自动首次读取。':'常规更新：新增检查 → 本地完整数据复用 → 按需向前补充；已有正文计入覆盖条数。');
 if(o.update&&o.syncOnly&&!o.syncOperation)console.log(Number.isFinite(o.count)?'增量更新：条数限制本次新增返回量（双向各半）；重复及核对记录也占取数额度。未接回旧记录时保存位置，下次继续。':'增量更新：读取全部新增至接回旧检查点，可能持续计费。只保存数据，不生成 HTML。');
 if(o.update&&!o.syncOnly)console.log(Number.isFinite(o.count)?'增量更新：条数同时限制本次新增返回量和报告条数（双向各半）；重复及核对记录也占取数额度，缓存免费复用。未接回旧记录时保存位置，下次继续。':'增量更新：已选择全部新增，读取至接回旧检查点；可能持续计费。报告合并全部已保存记录。');
 if(!Number.isFinite(o.count)&&!o.offline)console.log('全部读取可能持续调用付费接口；Ctrl+C 可停止，已保存的 JSON 缓存保留；接口不可见内容无法保证取得。');
 if(hasBefore(o)){
   console.log(`截止日期：${beforeDisplay(o)}（包含所选当天）；较新记录不占导出额度`);
   console.log(`历史定位：合并所有已有缓存区间；必要时每次仅探测 1 条，核实边界后开始正常采集。`);
   if(o.verbose)console.log(`定位最多 ${limitLabel(o.seekLimit??HISTORY_PROBE_LIMIT)} 次单条探测 / 接口（--seek-limit 可调整）；${o.offline?'离线，不新增 API 请求':Number.isFinite(o.pages)?`手动限制每接口最多 ${o.pages} 次新增 API 请求（定位 + 采集）`:'采集阶段自动读取目标条数'}；不可见历史仍可能取不满。`);
 }
 if(o.mode==='both'||o.mode==='all'){
   console.log(o.syncOnly?'双向分别使用发出 / 收到额度更新资料库；报告可另行按时间合并选取最新 N 条。':'双向结果按发出 / 收到各自额度合并，并非合并时间排序的全局最新 N 条；缓存及历史补全仅代表已知记录。');
   console.log(Number.isFinite(o.count)?`双向评论：发出最多 ${Math.ceil(o.count/2)} 条 + 收到最多 ${Math.floor(o.count/2)} 条`:o.update?'双向评论：发出、收到分别读取全部新增，接回各自检查点后停止':'双向评论：发出全部 + 收到全部，两个接口独立读取至可见末尾');
 }
 if(o.dryRun){
   if(o.update)console.log('  首次建立基线；已有基线时首请求最多 1 条，随后按需扩大且不超过剩余取数额度；接回检查点或达限后停止，中断可续取。');
   for(const x of p)console.log(`  ${ENDPOINTS[x.kind].command.join(' ')} | ${Number.isFinite(x.budget)?`最多 ${x.budget} 条`:'全部可见记录'}`);
   return;
 }
 fs.mkdirSync(root,{recursive:true});
 const folder=mappedFolder(root,o.uid,index);fs.mkdirSync(folder,{recursive:true});
 // Share decoded, identity-rechecked source bytes within this task only.
 // Both directions still own their independent bounds, budgets and progress.
 o.cacheSession??=require('./cache-session').createCacheSession({maxBytes:16*1024*1024});
 if(o.syncOnly&&!o.offline&&p.some(x=>['sent','received'].includes(x.kind)))try{require('./follow-inbox').initialize(require('./config').BASE,o.uid);}catch(error){console.log('未读状态初始化未完成；已保存的数据仍会保留：'+error.message);}
 const flags=preflight(o,p);
 o.creditMeter=createCreditMeter(o);o.creditMeter.start();
 require('./database-sync').trackNewRecords(o);
 if(o.autoGuard)o.autoGuard.configure(o.endpointMetadata,o.creditMeter.snapshot());
 const update=require('./data-update'),directions=o.syncOnly&&!o.autoGuard&&o.taskScopeId?update.taskDirections(folder,o):null;
 let nickname='';const results=[];
 for(const x of p){
   if(require('./cancellation').cancelled())break;
   console.log(`[${ENDPOINTS[x.kind].label}] 读取中…`);
   if(o.update&&o.syncOnly&&x.budget===0){results.push({kind:x.kind,budget:0,rows:[],newRows:[],fetched:0,stopCode:'DIRECTION_NOT_CHECKED',reason:'该方向分配到 0 条，本轮未检查'});continue;}
   if(o.gapBudget){
     if(remaining<1){
       results.push({kind:x.kind,budget:x.budget,rows:[],newRows:[],newFetched:0,reason:'本次补齐共用返回额度已用完，原方向的续取位置保留',returnLimited:true,resumePending:true,
         readProgress:{pending:true,pendingNew:true,targetCovered:true}});
       continue;
     }
     o.creditMeter.prepare(x.kind);
     if(o.creditMeter.unitPrice(x.kind)==null){
       results.push({kind:x.kind,budget:x.budget,rows:[],newRows:[],newFetched:0,reason:'该方向的每条返回单价未确认，未发起取数',failed:true,resumePending:true,readProgress:{pending:true,pendingNew:true,targetCovered:true}});
       continue;
     }
   }
   const resumeUnstarted=o.resumeScope&&!o.gapBudget&&directions?.unstarted(x.kind);
   if(x.budget>0)directions?.start(x.kind);
   let res;if(o.autoGuard?.job.blockedKinds?.includes(x.kind)||o.autoGuard?.directionError?.(x.kind)){const error=o.autoGuard?.directionError?.(x.kind);res={kind:x.kind,budget:x.budget,rows:[],newRows:[],failed:false,coverageUnverified:true,reason:error?.message||'该方向原请求仍待本地核对；其他安全方向继续',autoStop:{code:error?.code||'AUTO_OUTCOME_UNKNOWN'}};}else try{res=harvest(o.gapBudget?{...o,returnBudget:remaining,fillMiddle:true}:{...o,resumeUnstarted},folder,x.kind,x.budget,flags);}catch(error){if(error.code!=='RESUME_EVIDENCE_INVALID'&&(!o.autoGuard||p.length===1||!['AUTO_BASELINE','REQUEST_EVIDENCE_INVALID','LOCAL_SOURCE_INVALID'].includes(error.code)))throw error;res={kind:x.kind,stopCode:error.code,budget:x.budget,rows:[],newRows:[],failed:error.code!=='AUTO_BASELINE',coverageUnverified:true,reason:error.message,autoStop:{code:error.code}};}
   if(o.gapBudget)remaining=res.billingUnknown?0:Math.max(0,remaining-(res.newFetched||0));
   if(!nickname&&res.name){
     nickname=res.name;
     if(nickname!==knownNickname)console.log(`目标昵称：${terminalTarget(o.uid,nickname)}`);
   }
   if(res.newRows)o.noteNewRecords?.(res.newRows);
   results.push(res);require('./events').emit('collection',{kind:x.kind,phase:o.update?'update':'collect',fetched:res.fetched,budget:Number.isFinite(x.budget)?x.budget:null,done:true,partial:sourceIncomplete(res),newReturned:res.newFetched,returnLimit:o.update&&Number.isFinite(x.budget)?x.budget:null,gap:res.update?.gap||null});
 }
 const named=commitName(root,o.uid,folder,index,nickname);
 const auditFile=persistCollectionRun(named.folder,o,results);
 if(o.syncOnly){
  o.cancelled=require('./cancellation').cancelled();
  for(const r of results)require('./events').emit('source',{kind:r.kind,fetched:r.fetched,budget:Number.isFinite(r.budget)?r.budget:null,reason:r.reason,incomplete:sourceIncomplete(r),update:r.update||null,readProgress:r.readProgress||null,reusedCount:r.reusedCount??0,availability:r.availability||null,missingBodyIds:r.missingBodyIds||[]});
  o.creditMeter.finish({skipFinalBalanceIfLocal:true,skipFinalBalanceIfKnown:!!o.autoGuard});const summary=require('./database-sync').finishSync(o,named.folder,results,named.label);if(results.some(r=>r.failed))process.exitCode=1;return summary;
 }

 let jobs=(o.mode==='both'||o.mode==='all')
    ?[combinedResult(o,results),...(o.mode==='all'?results.filter(r=>r.kind.startsWith('mentions-')).map(r=>({kind:r.kind,rows:r.rows,sources:[r]})):[])]
    :results.map(r=>({kind:r.kind,rows:r.rows,sources:[r]}));
 if(o.mode==='all')jobs=require('./report-selection').combine(jobs);
 const summaries=[],writtenFiles=[];let written=0,exportedRecords=0;
 for(const job of jobs){
   const unique=new Map();
   for(const r of job.rows){const id=r.recordId||`${r.authorUid}/${r.time}/${r.content}`;
     const key=require('./records').recordKey(r);
     if(!unique.has(key))unique.set(key,r);
   }
   const rows=sortRecords([...unique.values()]);exportedRecords+=rows.length;
   const partial=job.sources.some(sourceIncomplete);
   const context=localConversationContext(rows,named.folder,o.uid,{...o,mode:job.kind});

   if(rows.length){
     const file=path.join(require('./data-layout').reportDir(named.folder),require('./report-name').fileName(named.label,{...o,mode:job.kind},rows.length));
     require('./events').emit('phase',{phase:'render',message:'正在生成 HTML 报告'});
     const catalog=require('./report-catalog'),opts={...o,mode:job.kind,reportPartial:partial,conversationContext:context},saved=catalog.write(file,opts,rows,named.label,()=>render(opts,rows,job.sources,named.label),catalog.contentKey(opts,rows,job.sources,named.label));
     written++;writtenFiles.push(saved.file);
   }
   summaries.push(`  ${(ENDPOINTS[job.kind]?.label||MODES[job.kind])}：${rows.length?`导出 ${rows.length} 条`:'0 条（未生成空文件）'}`);
   if(context.length)summaries.push(`    本地会话补充 ${context.length} 条（不计导出条数或排行榜）`);
   for(const source of job.sources){
     summaries.push(...sourceSummary(source,ENDPOINTS[source.kind].label,o));
     if(o.verbose)for(const status of completenessDiagnostics(source))summaries.push('    '+status);
   }
 }
 const newRecords=results.reduce((n,r)=>n+r.newFetched,0);
 const apiCalls=results.reduce((n,r)=>n+r.requests-r.cachedCalls,0);
 const cachedCalls=results.reduce((n,r)=>n+r.cachedCalls,0);
 const errors=results.filter(r=>r.failed).length;
 console.log(`[结果] ${terminalTarget(o.uid,nickname||knownNickname)}`);for(const line of summaries)console.log(line);
 const incomplete=results.some(sourceIncomplete);
 console.log(`${incomplete?'未完成':'完成'}：${written} 个 HTML | API ${apiCalls} 次，返回 ${newRecords} 条 | 缓存 ${cachedCalls} 次`);
 if(results.some(r=>r.recoveredCount||r.completeness?.knownIds))console.log('已知 ID 覆盖不代表全部历史完整；历史补全的当前可见性未核实。');
 if(results.some(r=>r.billingUnknown))console.log('注意：请求失败，计费结果未知，请核对服务端账单。');
 if(o.verbose)console.log('采集来源与完整性记录：'+auditFile);
 require('./events').emit('summary',{written,apiCalls,newRecords,cachedCalls,incomplete,records:exportedRecords,before:require('./core').beforeDisplay(o)});
 for(const r of results)require('./events').emit('source',{kind:r.kind,fetched:r.fetched,budget:Number.isFinite(r.budget)?r.budget:null,reason:r.reason,recovered:r.recoveredCount||0,incomplete:sourceIncomplete(r),update:r.update||null,readProgress:r.readProgress||null,reusedCount:r.reusedCount??0,availability:r.availability||null});
 o.creditMeter.finish();
 for(const file of writtenFiles)reportShortcut(file,o);
 if(errors)process.exitCode=1;
}

module.exports={runUserComments,harvest,harvestBefore,historyIndex,historyNext,HISTORY_PROBE_LIMIT,combinedResult};
