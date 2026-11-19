'use strict';
// Deliberately has no API client: arbitrary date ranges select saved independent records.
const fs=require('node:fs'),path=require('node:path');
const {storagePaths,indexRead,mappedFolder,findPostFolder,postSourceFromFolder}=require('./storage');
const {plan,MODES,sortRecords,userName,userId,rawArray,apiError}=require('./core');
const {loadIndependentArchive}=require('./completeness');
const {recordKey}=require('./records');
function cachedFiles(dir,pattern){return require('./regular-file').list(path.join(dir,'cache'),pattern);}
function localPosts(o,dir,{enrich=true}={}){
 const {normalizeUserPost,mergePostDetail,safePostId}=require('./user-posts'),records=new Map(),warnings=[];
 for(const file of cachedFiles(dir,/^user-posts_.*\.json$/))try{
  const packet=require('./cache-session').createCacheSession({maxBytes:0}).read(file),saved=packet.raw;if(saved.query?.uid!==o.uid||saved.endpoint!=='statuses user_timeline/other')continue;
  const parsed=rawArray(saved.response,'user-posts');if(!parsed||apiError(saved.response))continue;
  const stamp=packet.stamp;
  for(const raw of parsed.items){if(userId(raw.user)!==o.uid)continue;const row=normalizeUserPost(raw);if(!row.id||!Number.isFinite(row.ms))continue;if(!records.has(row.id)||records.get(row.id).stamp<=stamp)records.set(row.id,{row,stamp});}
 }catch(e){warnings.push(path.basename(file)+'：'+e.message);}
 if(enrich)for(const {row}of records.values())try{const file=path.join(dir,'cache/details',row.id+'.json');if(fs.existsSync(file)){const raw=require('./file-view-cache').readJSON(file);if(safePostId(raw)===row.id&&userId(raw.user)===o.uid)mergePostDetail(row,raw);}}catch(error){warnings.push(row.id+'：'+error.message);}
 for(const [id,e]of require('./exchange-records').records(dir,'user-posts',o.uid)){const old=records.get(id);if(!old)records.set(id,e);else if(enrich)old.row=require('./exchange-merge').merge(old.row,e.row,'user-posts');}
 const rows=[...records.values()].map(e=>e.row);
 return {rows:enrich?require('./exchange-records').imageRows(rows,dir):rows,warnings};
}
function localPostComments(o,dir){
 const {postPageRows}=require('./post-comments'),records=new Map(),warnings=[];
 function add(raw,stamp){if(apiError(raw))return;const parsed=postPageRows(raw,o.postId);for(const row of parsed.rows)if(row.recordId&&require('./record-body').completeBody(row)){const old=records.get(row.recordId),incoming={row,stamp};if(!old)records.set(row.recordId,incoming);else{const main=old.stamp<=stamp?incoming:old,extra=main===old?incoming:old;records.set(row.recordId,{...main,row:require('./exchange-merge').merge(main.row,extra.row,'post-comments')});}}}
 for(const file of cachedFiles(dir,/^post-comments_c\d+_m\d+(?:_s\d+)?(?:_p\d+)?(?:_legacy_[a-f0-9]{16})?\.json$/))try{const saved=require('./cache-session').createCacheSession({maxBytes:0}).read(file);add(saved.raw,saved.stamp);}catch(e){warnings.push(path.basename(file)+'：'+e.message);}
 const journal=path.join(dir,'cache/request-journal');for(const file of require('./regular-file').list(journal,/^[a-f0-9-]+\.response\.json$/))try{const box=require('./file-view-cache').readJSON(file);if(box.schema===1&&box.query?.kind==='post-comments'&&box.query.uid===o.postId)add(box.response,Date.parse(box.savedAt));}catch(e){warnings.push(path.basename(file)+'：'+e.message);}
 for(const [id,e]of require('./exchange-records').records(dir,'post-comments',o.postId))if(!records.has(id))records.set(id,e);else records.get(id).row=require('./exchange-merge').merge(records.get(id).row,e.row,'post-comments');
 return {rows:[...records.values()].map(e=>e.row),warnings};
}
function selectRange(rows,o,budget=Infinity){return sortRecords(rows.filter(row=>Number.isFinite(row.ms)&&row.ms>=o.startMs&&row.ms<=o.endMs)).slice(0,budget);}
function databaseJobs(o,{base=require('./config').BASE,session=require('./cache-session').createCacheSession(),archive=loadIndependentArchive}={}){
 const paths=storagePaths(base),post=o.mode==='post-comments',posts=o.mode==='user-posts',root=post?paths.postComments:posts?paths.posts:paths.users,index=post?{}:indexRead(root),dir=post?findPostFolder(root,o.postId):mappedFolder(root,o.uid,index),label=post?userName(postSourceFromFolder(dir,o.postId).user)||'未知作者':index[o.uid]?.nickname||o.uid;
 const warnings=[],jobs=[],postAuthors=post&&!o.dryRun&&fs.existsSync(dir)?require('./post-display-index').create(dir,o.postId).authors():undefined;
 const batch=o.batch?require('./database-sync').readBatch(dir,o.batch):null;
 if(batch&&(batch.target!==(o.postId||o.uid)||batch.category!==(post?'post-comments':posts?'posts':'user-comments')||!post&&batch.uid!==o.uid))throw Error('更新批次与目标用户或功能不匹配');
 const inbox=o.unread?require('./follow-inbox'):null,unreadIds=inbox?inbox.unreadIds(o.dryRun?inbox.preview(base,o.uid):inbox.view(base,o.uid)):null;
 if(batch){
  const wanted=new Set(plan(o).map(p=>p.kind)),newKeys=new Set(batch.newKeys),selected=batch.rows.filter(row=>(post||posts||wanted.has(row.group))&&(!o.newOnly||newKeys.has(require('./database-sync').key(row)))&&(!unreadIds||unreadIds.has(row.recordId)));
  const grouped=new Map();for(const original of selected){const kind=post||posts?o.mode:['sent','received'].includes(original.group)&&['both','all'].includes(o.mode)?'both':original.group;if(!grouped.has(kind))grouped.set(kind,new Map());const rows=grouped.get(kind),key=recordKey(original),old=rows.get(key),row={...original,provenance:original.provenance?{...original.provenance,type:original.isRecovered?'archive':'cache'}:undefined};rows.set(key,kind==='both'&&old&&old.type!==row.type?{...require('./exchange-merge').merge(old,row,old.group),type:'发出/收到',directions:[...new Set([...(old.directions||[old.group]),...(row.directions||[row.group])])]}:old?require('./exchange-merge').merge(old,row,old.group):row);}
  for(const [kind,rows]of grouped){const matching=selectRange([...rows.values()],o);jobs.push({kind,rows:(o.unread?matching.reverse():matching).slice(0,o.count)});}
  return {dir,label,jobs:o.mode==='all'?require('./report-selection').combine(jobs):jobs,warnings,batch,postAuthors,updateInfo:{batchId:batch.id,updatedAt:batch.createdAt,newKeys:batch.newKeys,addedTotal:batch.newKeys.length,newOnly:!!o.newOnly,incomplete:!!batch.incomplete}};
 }

 if(post||posts){const data=post?localPostComments(o,dir):localPosts(o,dir);warnings.push(...data.warnings);jobs.push({kind:o.mode,rows:selectRange(data.rows,o,o.count)});}
 else{
  // Per-direction archives are keyed by exact record ID. Merge the requested
  // directions first, then sort the resulting records once by interaction time.
  const grouped = new Map();
  for (const part of plan(o)) {
   const source = archive(dir, part.kind, o.uid, session);
   warnings.push(...source.warnings);
   if (!grouped.has(part.output)) grouped.set(part.output, new Map());
   const records = grouped.get(part.output);
   for (const entry of source.records.values()) {
    const original = entry.row;
    if (!(Number.isFinite(original.ms) && original.ms >= o.startMs && original.ms <= o.endMs)) continue;
    if (unreadIds && !unreadIds.has(original.recordId)) continue;
    const key = recordKey(original), old = records.get(key);
    if (old && old.type !== original.type) {
     records.set(key, {...old, type:'发出/收到', directions:[...new Set([...(old.directions || [old.group]), original.group])]});
    } else {
     records.set(key, {
      ...original,
      directions:original.directions || (original.type === '发出/收到' ? ['sent','received'] : [part.kind]),
      provenance:{...entry.provenance, type:original.isRecovered ? 'archive' : 'cache'},
     });
    }
   }
  }
  for (const [kind, records] of grouped) {
   const rows = sortRecords(records.values());
   if (o.unread) rows.reverse();
   jobs.push({kind, rows:rows.length > o.count ? rows.slice(0, o.count) : rows});
  }
 }
 return {dir,label,jobs:o.mode==='all'?require('./report-selection').combine(jobs):jobs,warnings,postAuthors};
}
function runDatabase(o){
 const {emit}=require('./events'),{render}=require('./reader'),{renderUserPosts}=require('./posts-reader'),{reportShortcut}=require('./terminal-report');
 const data=databaseJobs(o);console.log(`目标：${data.label}${o.uid?'（UID '+o.uid+'）':''} | 本地资料库导出`);console.log(`日期：${require('./date-range').label(o.from,o.to,'全部已保存日期')}（包含起止日期） · 不联网，新增费用 0 credits`);
 emit('credits',{offline:true,estimatedCredits:0,returnedRecords:0,unknownRequests:0});
 let written=0,records=0;const files=[];
 for(const job of data.jobs){
  console.log(`  ${MODES[job.kind]}：本地匹配 ${job.rows.length} 条`);records+=job.rows.length;
  if(o.dryRun||!job.rows.length)continue;
  const partial=!!data.batch?.incomplete;const note=(partial?'该更新批次的采集范围尚未完成；':'')+'仅包含本地已保存的独立记录；日期内未保存或当前不可见的内容不在本次导出范围。',meta={kind:job.kind,rows:job.rows,budget:job.rows.length,fetched:job.rows.length,ended:true,complete:true,coverageUnverified:partial,reason:note,requests:0,cachedCalls:0,newFetched:0,apiCalls:0};
  const file=path.join(require('./data-layout').reportDir(data.dir),require('./report-name').fileName(data.label,{...o,mode:job.kind},job.rows.length));
  fs.mkdirSync(data.dir,{recursive:true});require('./data-layout').mirrorImages(data.dir);const owner=job.kind==='post-comments'?require('./post-links').savedPostAuthor([...job.rows,...(data.postAuthors||[])],o.postId).uid:o.uid;const catalog=require('./report-catalog'),opts={...o,uid:owner,mode:job.kind,reportPartial:partial,postAuthors:data.postAuthors},key=require('node:crypto').createHash('sha256').update(JSON.stringify({renderer:catalog.renderIdentity(),scope:'cli-database-v1',uid:owner,postId:o.postId,mode:job.kind,label:data.label,from:o.from,to:o.to,count:Number.isFinite(o.count)?o.count:null,unread:!!o.unread,shareReport:o.shareReport,partial,rows:job.rows,postAuthors:data.postAuthors})).digest('hex'),saved=catalog.write(file,opts,job.rows,data.label,()=>job.kind==='user-posts'?renderUserPosts(o,meta,data.label):render({...opts,updateInfo:null},job.rows,[meta],data.label),key);written++;files.push(path.relative(path.join(require('./config').BASE,'output'),saved.file));reportShortcut(saved.file,o);
 }
 if(files.length){const catalog=require('./report-catalog'),base=require('./config').BASE;catalog.defer(base,files);try{if(catalog.maintainPending(base).deferred)console.error('报告已保存；旧报告正在等待打开回执或其他进程，之后自动整理。');}catch(error){console.error('报告已保存；旧报告等待安全清理：'+error.message);}}
 for(const warning of data.warnings)console.log('本地记录未采用：'+warning);
 if(!records)console.log('该日期范围暂无已保存记录，未生成空报告；这不表示没有发生互动。');
 emit('summary',{written,records,apiCalls:0,newRecords:0,cachedCalls:0,incomplete:!!data.batch?.incomplete,database:true,batchId:o.batch||null,addedRecords:data.updateInfo?data.jobs.flatMap(j=>j.rows).filter(row=>data.updateInfo.newKeys.includes(require('./database-sync').key(row))).length:0,preview:!!o.dryRun,from:o.from,to:o.to});
 console.log(`本地导出${o.dryRun?'预览':''}：${records} 条 · 新增消耗 0 credits；未核实线上完整性。`);
}
module.exports={cachedFiles,localPosts,localPostComments,selectRange,databaseJobs,runDatabase};
