'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {rawArray,apiError,normalize,userId,sortRecords,esc,ts}=require('./core');
function exactId(value){if(typeof value==='number'&&!Number.isSafeInteger(value))return '';return /^\d+$/.test(String(value))&&BigInt(value)>0n?BigInt(value).toString():'';}
function fileProvenance(file,dir,type,stamp=0){return {type,file:file?path.relative(dir,file):'',savedAt:Number.isFinite(stamp)&&stamp>0?new Date(stamp).toISOString():''};}
// These are independently returned top-level records from this account's own
// endpoint cache. Nested quotes never become archived independent records.
function loadIndependentArchive(dir,kind,uid,session=require('./cache-session').createCacheSession()){
 return loadIndependentArchives(dir,[kind],uid,session)[kind];
}
// Read shared receipts/snapshots once for a local multi-direction view. Keep the
// same independent-body selection rules used by each acquisition direction.
function loadIndependentArchives(dir,kinds,uid,session=require('./cache-session').createCacheSession(),projection=null){
 const empty=()=>Object.fromEntries(kinds.map(kind=>[kind,{records:new Map(),warnings:[],knownIds:new Set(),session}]));
 const result=empty(),cache=path.join(dir,'cache');if(!fs.existsSync(cache))return result;
 const warn=(state,kind,name,error)=>state[kind].warnings.push(name+'：'+error.message);
 function packet(state,entry,file,kind,raw,receipt=false){const parsed=rawArray(raw,kind);if(!parsed)return;const part=state[kind];for(const value of (Array.isArray(parsed.container.miss_ids_str??parsed.container.miss_ids)?parsed.container.miss_ids_str??parsed.container.miss_ids:[])){const id=exactId(value);if(id)part.knownIds.add(id);}
  for(const raw of parsed.items){const id=exactId(raw.idstr??raw.id??raw.mid);if(!id||kind==='sent'&&userId(raw.user)!==uid)continue;if(!raw.isContext)part.knownIds.add(id);const row=session.normalize(raw,kind,uid);if(!require('./record-body').completeBody(row,raw))continue;const old=part.records.get(id),incoming={row,stamp:entry.stamp,provenance:{...fileProvenance(file,dir,'archive',entry.stamp),responseHash:entry.hash}};if(old){const main=receipt||old.stamp>entry.stamp?old:incoming,extra=main===old?incoming:old;part.records.set(id,{...main,row:require('./exchange-merge').merge(main.row,extra.row,kind)});}else part.records.set(id,incoming);}
 }
 const projected=[];
 let reusable;
 function mergeSource(part,role){
  for(const kind of kinds){const state=result[kind],incoming=part[kind];for(const id of incoming.knownIds)state.knownIds.add(id);state.warnings.push(...incoming.warnings);
   for(const record of incoming.records){
    const id=record[0];
    const previous=state.records.get(id),saved=reusable?.(kind,id);
    if(saved){if(!previous)state.records.set(id,saved);continue;}
    const entry=incoming.resolve?incoming.resolve(record):record[1];
    if(previous){const keep=role==='snapshot'||(role==='receipt'?previous.stamp>=entry.stamp:previous.stamp>entry.stamp),main=keep?previous:entry,extra=keep?entry:previous;state.records.set(id,{...main,row:require('./exchange-merge').merge(main.row,extra.row,kind)});}else state.records.set(id,entry);
   }
  }
 }
 function source(file,role,build){
  if(projection?.nativeFiles&&!projection.nativeFiles.has(file))return;
  const project=()=>{const part=empty();build(part);projection?.onNativeSource?.(file,part);return part;};
  if(projection?.source)projected.push({load:projection.source(file,role,project),role});
  else mergeSource(project(),role);
 }
 const names=fs.readdirSync(cache);
 for(const kind of kinds){const pattern=new RegExp('^'+kind+'_c(\\d+)_m(\\d+)(?:_s\\d+)?(?:_legacy_[a-f0-9]{16})?\\.json$');for(const name of names){if(!pattern.test(name)&&name!==kind+'_page1.json')continue;const file=path.join(cache,name);source(file,'packet',state=>{try{const entry=session.read(file);packet(state,entry,file,kind,entry.raw);}catch(error){warn(state,kind,name,error);}});}}
 const receipts=path.join(cache,'request-journal');if(fs.existsSync(receipts))for(const name of fs.readdirSync(receipts).filter(n=>/^[a-f0-9-]+\.response\.json$/.test(n))){const file=path.join(receipts,name);source(file,'receipt',state=>{try{const entry=session.read(file),box=entry.raw;if(box.schema!==1||box.query?.uid!==uid||!kinds.includes(box.query.kind)||apiError(box.response))return;packet(state,entry,file,box.query.kind,box.response,true);}catch(error){for(const kind of kinds)warn(state,kind,name,error);}});}
 const snapshots=path.join(cache,'report-snapshots');if(fs.existsSync(snapshots))for(const name of fs.readdirSync(snapshots).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const file=path.join(snapshots,name);source(file,'snapshot',state=>{try{const value=session.read(file);if(value.hash!==name.slice(0,-5)||value.raw.schema!==1||value.raw.uid!==uid||!Array.isArray(value.raw.rows))return;
  for(const row of value.raw.rows){const id=exactId(row.recordId),sent=row.group==='sent'||['发出','发出的评论','发出/收到'].includes(row.type),received=row.group==='received'||['收到','收到的评论','发出/收到'].includes(row.type);if(!id||!require('./record-body').completeBody(row))continue;for(const kind of kinds){const matches=kind==='sent'?sent&&row.authorUid===uid:kind==='received'?received:row.group===kind,part=state[kind];if(!matches||part.records.has(id))continue;part.knownIds.add(id);part.records.set(id,{row,stamp:value.stamp,provenance:{...fileProvenance(file,dir,'archive',value.stamp),responseHash:value.hash}});}}
 }catch(error){for(const kind of kinds)warn(state,kind,name,error);}});}
 // A compact report projection already contains the unchanged imported rows.
 if(projection?.nativeFiles&&!projection.exchange)return result;
 if(projection?.source){reusable=projection.reusable();for(const item of projected)mergeSource(item.load(),item.role);}
 const exchange=projection?.exchange?.();
 if(exchange){for(const kind of kinds)for(const id of exchange[kind].knownIds)result[kind].knownIds.add(id);}
 else for(const entry of require('./exchange-records').iterateEntries(dir)){const value=entry.value;if(value.owner?.id!==uid||value.owner.kind!=='user'||!kinds.includes(value.channel)||!['packet','records'].includes(value.role))continue;const state=result[value.channel];for(const row of require('./exchange-records').rowsOf(value)){const id=exactId(row.recordId);if(id&&!row.isContext)state.knownIds.add(id);}const container=value.role==='packet'?rawArray(value.response,value.channel)?.container:null,missing=container?.miss_ids_str??container?.miss_ids;if(Array.isArray(missing))for(const value of missing){const id=exactId(value);if(id)state.knownIds.add(id);}}
 for(const kind of kinds)for(const [id,e]of exchange?.[kind].records||require('./exchange-records').records(dir,kind,uid)){
  const state=result[kind];if(!e.row.isContext)state.knownIds.add(id);
  const old=state.records.get(id),saved=reusable?.(kind,id);
  if(saved){if(!old)state.records.set(id,saved);continue;}
  if(!old)state.records.set(id,e);
  else if(/^cache\/report-snapshots\//.test(old.provenance?.file||''))state.records.set(id,{...e,row:require('./exchange-merge').merge(e.row,old.row,kind)});
  else state.records.set(id,{...old,row:require('./exchange-merge').merge(old.row,e.row,kind)});
 }
 return result;
}

function createCollectionEvidence(dir,kind,uid){
 const windows=[],observed=new Map();
 function add(packet,count,maxId='',phase='collect',sinceId=''){
  const parsed=rawArray(packet.raw,kind);if(!parsed||apiError(packet.raw))return;
  const box=parsed.container,values=box.miss_ids_str??box.miss_ids,reported=box.miss_count;
  const missing=[],invalid=[];
  for(const value of Array.isArray(values)?values:[]){const id=exactId(value);if(id)missing.push(id);else invalid.push(value);}
  const missingCount=(typeof reported==='number'||typeof reported==='string'&&/^\d+$/.test(reported))&&Number.isSafeInteger(Number(reported))&&Number(reported)>=0?Number(reported):null;
  const nextValue=box.next_cursor_str??box.next_cursor;
  const next=nextValue!=null&&/^\d+$/.test(String(nextValue))&&!(typeof nextValue==='number'&&!Number.isSafeInteger(nextValue))?BigInt(nextValue).toString():null;
  const currentIds=[],stamp=packet.cacheTimeMs||Date.now(),provenance=fileProvenance(packet.file,dir,packet.cached?'cache':'api',stamp);
  for(const raw of parsed.items){
   const id=exactId(raw.idstr??raw.id??raw.mid);if(!id||(maxId&&BigInt(id)>BigInt(maxId)))continue;
   if(kind==='sent'&&userId(raw.user)!==uid)continue;
   const row=normalize(raw,kind,uid);if(!require('./record-body').completeBody(row,raw))row.bodyMissing=true;currentIds.push(id);observed.set(id,{row,provenance,phase});
  }
  const lowest=currentIds.length?currentIds.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b):null;
  // An empty response without continuation proves no numeric interval.
  const rawFloor=next!=null&&next!=='0'?BigInt(next)+1n:lowest?BigInt(lowest):next==='0'&&phase==='collect'?1n:null;
  const floor=sinceId&&rawFloor!=null&&rawFloor<=BigInt(sinceId)?BigInt(sinceId)+1n:rawFloor;
  const safeMissing=missing.filter(id=>(!maxId||BigInt(id)<=BigInt(maxId))&&(next==='0'||floor==null||BigInt(id)>=floor)&&(!sinceId||BigInt(id)>BigInt(sinceId)));
  windows.push({availability:require('./record-availability').inspectPacket(packet,count,maxId,kind,uid),kind,phase,count,maxId,sinceId,next,floor:floor==null?null:floor.toString(),ids:currentIds,missingIds:[...new Set(safeMissing)],missingCount,unidentifiedMissing:Math.max(0,(missingCount||0)-new Set(safeMissing).size),invalidMissingIds:invalid.length+(missing.length-safeMissing.length)+Number(reported!=null&&missingCount==null)+Number(values!=null&&!Array.isArray(values)),hasMissingMetadata:missingCount!=null||Array.isArray(values),cached:!!packet.cached,responseHash:packet.responseHash||'',...provenance});
 }
 function contains(id){return windows.some(w=>w.phase==='collect'&&(w.ids.includes(id)||(w.floor!=null&&BigInt(id)>=BigInt(w.floor)&&(!w.maxId||BigInt(id)<=BigInt(w.maxId)))));}
 function finish(result,archive,options){
  const current=new Map(result.rows.filter(r=>exactId(r.recordId)&&(options.historyRecovery!==false||observed.has(r.recordId))).map(r=>[r.recordId,r]));
  const before=Number.isFinite(options.beforeMs)?options.beforeMs:Infinity;
  const eligible=new Map();
  const allLocal=!Number.isFinite(result.budget)&&!Number.isFinite(options.beforeMs)&&!result.incremental;
  const historicalFragment=Number.isFinite(options.beforeMs)&&(!result.located||(!result.rows.length&&archive.records.size>0));
  for(const [id,entry]of archive.records){if(entry.row.ms>before||entry.row.ms<(options.startMs??-Infinity))continue;if(!contains(id)&&!historicalFragment&&!allLocal)continue;eligible.set(id,entry);}
  if(historicalFragment&&eligible.size&&options.historyRecovery!==false){result.partial=true;result.located=false;result.ended=false;result.reason+='；本地历史仅作为已取得片段补全，未核实日期前最近记录的完整边界';}
  const candidates=new Map(current);
  if(options.historyRecovery!==false)for(const [id,entry]of eligible)if(!candidates.has(id))candidates.set(id,{...entry.row});
  const archivedSources=new Map();
  function archivedProvenance(entry){
   const p=entry.provenance;if(archivedSources.has(p.file))return archivedSources.get(p.file);
   const original=path.join(dir,p.file),hash=p.responseHash;let resolved=p;
   try{if(hash&&fs.existsSync(original)&&archive.session.read(original).hash!==hash){const snapshot=original.replace(/\.json$/,'_legacy_'+hash.slice(0,16)+'.json');if(fs.existsSync(snapshot)&&archive.session.read(snapshot).hash===hash)resolved={...p,file:path.relative(dir,snapshot)};}}catch{}
   archivedSources.set(p.file,resolved);return resolved;
  }
  // Freshly read content wins over older snapshots; archive-only rows are
  // independently saved records, not quotes or proof of present visibility.
  for(const [id,row]of candidates){
   const live=observed.get(id),old=archive.records.get(id);
   if(live&&require('./record-body').completeBody(live.row)){const richer=require('./exchange-merge').merge(live.row,old?.row||row,kind);candidates.set(id,{...richer,provenance:live.provenance,isRecovered:false});}
   else if(old){const carried=result.incremental&&!contains(id),recovered=!carried||result.cachedRecoveryIds?.has(id);candidates.set(id,{...require('./exchange-merge').merge(old.row,row,kind),provenance:{...archivedProvenance(old),...(!recovered?{type:'cache'}:{})},isRecovered:!!recovered});}
  }
  const selected=sortRecords([...candidates.values()]).slice(0,result.budget);
  const safeSelected=selected.filter(r=>exactId(r.recordId)),exportIds=new Set(safeSelected.map(r=>r.recordId));
  const trimmed=Number.isFinite(result.budget)&&selected.length>=result.budget;
  const floor=trimmed&&safeSelected.length?safeSelected.reduce((a,r)=>BigInt(a)<BigInt(r.recordId)?a:r.recordId,safeSelected[0].recordId):null;
  const inScope=id=>(floor==null||BigInt(id)>=BigInt(floor));
  const known=new Set(exportIds),visible=new Set(),missing=new Set();
  for(const [id,value]of observed){
   if(value.row.ms>before||!inScope(id))continue;
   if(value.phase==='collect'||exportIds.has(id)){known.add(id);if(require('./record-body').completeBody(value.row))visible.add(id);}
  }
  for(const [id,entry]of eligible)if(inScope(id))known.add(id);
  const collect=windows.filter(w=>w.phase==='collect');
  for(const w of collect)for(const id of w.missingIds)if(inScope(id)){missing.add(id);known.add(id);}
  const restored=selected.filter(r=>r.isRecovered).length,missingContent=[...known].filter(id=>!exportIds.has(id)),restorable=[...eligible.keys()].filter(id=>!observed.has(id));
  // Missing counts without safe IDs cannot be assigned to a trimmed report
  // or deduplicated across overlapping windows: disclose, never invent 100%.
  const unidentified=collect.reduce((n,w)=>n+w.unidentifiedMissing,0);
  const total=known.size,readableBefore=[...exportIds].filter(id=>visible.has(id)||(result.incremental&&current.has(id)&&!contains(id)&&!result.cachedRecoveryIds?.has(id))).length;
  const allScannedVisible=new Set([...observed].filter(([id,v])=>v.phase==='collect'||current.has(id)).map(([id])=>id));
  const allMissing=new Set(collect.flatMap(w=>w.missingIds));
  result.visibleFetched=result.fetched;result.rows=selected;result.fetched=selected.length;result.recoveredCount=restored;
  result.completeness={schema:1,scope:'export-id-window',historyRecovery:options.historyRecovery!==false,knownIds:total,readable:exportIds.size,beforeReadable:readableBefore,coverageBefore:total?readableBefore/total:null,coverageAfter:total?exportIds.size/total:null,missingKnownIds:missingContent.length,missingIds:missingContent,reportedMissingIds:[...missing].filter(id=>!visible.has(id)).length,unidentifiedMissing:unidentified,missingMetadataComplete:collect.length>0&&collect.every(w=>w.hasMissingMetadata)&&unidentified===0&&collect.every(w=>!w.invalidMissingIds)&&[...eligible.keys()].filter(inScope).every(id=>visible.has(id)||missing.has(id)),recovered:restored,archiveWarnings:archive.warnings.length,scannedVisible:allScannedVisible.size,scannedMissingIds:allMissing.size,scannedRestorable:restorable.length,freshApiPages:collect.filter(w=>!w.cached).length,cachedPages:collect.filter(w=>w.cached).length,scopeFloor:floor};
  result.newRows=sortRecords([...observed].filter(([id,v])=>v.provenance.type==='api'&&!archive.records.has(id)&&Number.isFinite(v.row.ms)&&v.row.ms<=before&&v.row.ms>=(options.startMs??-Infinity)&&(!result.newBoundaryId||BigInt(id)>BigInt(result.newBoundaryId))&&(!result.failed||exportIds.has(id))&&(v.phase==='collect'||v.phase==='verify-end'||exportIds.has(id))&&require('./record-body').completeBody(v.row)).map(([,v])=>({...v.row,provenance:v.provenance,isRecovered:false})));
  result.auditPackets=windows;
  result.availability=require('./record-availability').analyzeAvailability(windows,archive,result,options);
  if(restored)result.reason+='；按最新已知记录重选，含 '+restored+' 条历史补全（不代表当前仍可见）';
  return result;
 }
 return {add,finish,windows,observed};
}
const percentage=n=>n==null?'无法量化':(n*100).toFixed(1)+'%';
function completenessText(result){
 const c=result.completeness;if(!c)return '';
 return `已知 ID 覆盖率 ${percentage(c.coverageBefore)} → ${percentage(c.coverageAfter)}；历史补全 ${c.recovered} 条；本报告范围内仍缺正文 ${c.missingKnownIds} 个已知 ID${c.missingMetadataComplete?'':'；缺失元数据不完整，此比例不代表所有历史完整度'}`;
}
function completenessDiagnostics(result){
 const c=result.completeness;if(!c)return [];
 return [completenessText(result),`扫描区间：取得 ${c.scannedVisible} 条不同记录；接口列出 ${c.scannedMissingIds} 个不同缺失 ID；旧缓存可补回 ${c.scannedRestorable} 条${c.unidentifiedMissing?`；另有 ${c.unidentifiedMissing} 个无法安全对应 ID 的缺失位置`:''}。`,
  `本报告保存 ${c.readable} / 已识别 ${c.knownIds} 个 ID。覆盖率仅针对本报告已知 ID，不代表所有历史完整度；缺失不能直接认定为删除。`];
}
function recoveryNote(rows){
 const recovered=rows.filter(row=>row.isRecovered&&!row.isContext).length;
 return recovered?` <span class="recovery-note" title="此前独立响应保存的记录；当前可见性未核实">（含历史补全 ${recovered} 条）</span>`:'';
}
function provenanceBadge(row){if(row.shareView)return '';return row.isRecovered?'<span class="archive-badge" title="曾作为独立记录保存，本次读取未返回；当前可见性未核实">历史补全</span>':'';}
function provenanceDetails(row){if(row.shareView)return '';
 const p=row.provenance;if(!p)return '';
 return `<p class="provenance-note">记录来源：${row.isContext&&row.contextSource==='local-cache'?'本地会话补充：此前独立获取并保存的评论，仅作为阅读上下文；当前可见性未核实':p.type==='archive'?'历史补全：此前独立接口响应已保存，本次读取未返回；当前可见性未核实':p.type==='cache'?'本次从接口响应缓存读取，未重新核验当前可见性':'本次 API 响应'}${p.savedAt?'；保存于 '+esc(ts(p.savedAt).display)+'':''}${p.file?'；缓存文件：'+esc(p.file):''}。</p>`;
}
function persistCollectionRun(dir,options,results){
 const folder=path.join(dir,'cache','runs');
 const filename=new Date().toISOString().replace(/[:.]/g,'-')+'_'+require('node:crypto').randomUUID()+'.json';
 const run = {
  schema:1, syncOnly:!!options.syncOnly, uid:options.uid, mode:options.mode,
  limit:Number.isFinite(options.count) ? options.count : null, beforeMs:options.beforeMs ?? null,
  createdAt:new Date().toISOString(),
  endpoints:results.map(r => ({
   kind:r.kind, update:r.update || null, budget:Number.isFinite(r.budget) ? r.budget : null,
   reason:r.reason, ended:r.ended, located:r.located, coverageUnverified:!!r.coverageUnverified,
   endVerification:r.endVerification || null, reportedTotal:r.reportedTotal ?? null,
   result:require('./collection-result').collectionResult(r), unknownTimeIds:r.unknownTimeIds || [],
   completeness:r.completeness, availability:r.availability || null, packets:r.auditPackets,
   records:r.rows.map(row => ({id:row.recordId, provenance:row.provenance, isRecovered:!!row.isRecovered})),
  })),
 };
 const file = path.join(folder, filename);
 require('./update-progress').atomic(file, run);
 return file;
}
module.exports={exactId,loadIndependentArchive,loadIndependentArchives,createCollectionEvidence,completenessText,completenessDiagnostics,recoveryNote,provenanceBadge,provenanceDetails,persistCollectionRun};
