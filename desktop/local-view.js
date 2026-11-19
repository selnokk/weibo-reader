'use strict';
// Local browsing and exports intentionally have no account, price or API client.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {options}=require('../lib/options'),{storagePaths,indexRead,mappedFolder,findPostFolder}=require('../lib/storage');
const {sortRecords,parseBefore}=require('../lib/core'),{recordKey}=require('../lib/records');
// The user inbox contains formal comment IDs, not identically numbered posts.
// Keep the same typed predicate for visual flags and the actual unread count.
function unreadComment(row,ids){return ids.has(row.recordId)&&!row.isContext&&row.group!=='user-posts'&&recordKey(row)==='comment:'+row.recordId;}
function validate(input){const mode=input.mode,target=String(input.target||'').trim(),args=[target,mode,'--database','--limit',input.unlimited?'all':String(input.limit||200)];if(input.from)args.push('--from',input.from);if(input.to)args.push('--to',input.to);const o={...options(args),markUnread:input.markUnread===true||input.unreadOnly===true,unreadOnly:input.unreadOnly===true,unreadContext:input.unreadContext===true};if(o.unreadOnly&&!['sent','received','both','post-comments'].includes(o.mode))throw Error('未读报告仅支持评论');if(o.unreadContext&&(!o.unreadOnly||o.mode!=='both'))throw Error('未读前文仅支持用户互动报告');if(input.peerUid!=null&&typeof input.peerUid!=='string')throw Error('互动对象请填写 UID 或支持的用户主页链接');const raw=(input.peerUid||'').trim();if(raw){if(!['sent','received','both'].includes(o.mode))throw Error('互动对象筛选仅支持用户评论导出');const peerUid=require('./ui/form-utils').uid(raw);if(!peerUid)throw Error('互动对象请填写有效 UID 或用户主页链接');if(peerUid===o.uid)throw Error('互动对象不能是目标用户本人');o.peerUid=peerUid;}return o;}
// Progress checkpoints are separate from the report's bodies and read flags.
function signature(dir) {
 const files = [];
 const children = new Set(['report-snapshots', 'details', 'request-journal', 'exchange-v1']);
 function scan(folder, subdir = '') {
  if (!fs.existsSync(folder)) return;
  for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
   if (entry.isDirectory() && !subdir && children.has(entry.name)) {
    scan(path.join(folder, entry.name), entry.name);
    continue;
   }
   if (!entry.isFile() || !entry.name.endsWith('.json') || /^(?:follow-inbox|post-reading-state)(?:\.|$)/.test(entry.name)) continue;
   // Request reservations, retries and response-recovery bookkeeping do not
   // supply report bodies. Only a published response can affect this selection.
   if (subdir === 'request-journal' && !/^[a-f0-9-]+\.response\.json$/.test(entry.name)) continue;
   const file = path.join(folder, entry.name), stat = fs.statSync(file);
   files.push([file, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  }
 }
 scan(path.join(dir, 'cache'));
 files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
 return crypto.createHash('sha256').update(JSON.stringify(files) + '|' + require('../lib/exchange-store').signatureFor(dir)).digest('hex');
}
function readingContext(selected,all,unread){
 const formal=new Set(selected.map(r=>r.postId+':'+r.recordId)),byId=all instanceof Map?all:new Map(all.filter(r=>r.postId&&r.recordId).map(r=>[r.postId+':'+r.recordId,r])),contexts=new Map();
 selected.forEach((row,i)=>{let id=row.replyId||row.rootId,steps=0;while(id&&steps++<3){const key=row.postId+':'+id,parent=byId.get(key);if(!parent||parent.recordId===row.recordId||parent.ms>row.ms)break;if(!formal.has(key)){if(!contexts.has(key))contexts.set(key,{...parent,isContext:true,isUnread:false,contextSource:'local-cache',contextFor:[],contextSortMs:parent.ms,interactionDirection:parent.authorUid===row.targetUid?'sent':'received',type:'前文',group:'context'});contexts.get(key).contextFor.push(i);}if(parent.replyId===id)break;id=parent.replyId;}});
 return require('../lib/reader').buildConversationRows(selected,[...contexts.values()]).filter(r=>r.isContext);
}
// Use the report's existing exact-ID reply/root resolver. A shared post alone
// does not make unrelated comments part of the selected conversation.
function selectConversation(candidates,selection,all){
 const same=candidates.filter(r=>selection.postId?r.postId===selection.postId:r.recordId===selection.recordId);
 const map=new Map([...all.filter(r=>r.postId===selection.postId),...same].filter(r=>r.recordId).map(r=>[r.recordId,r]));
 const root=require('../lib/reader').rootOf(selection.anchor,map);
 return root?same.filter(r=>r.recordId===root||require('../lib/reader').rootOf(r,map)===root):same.filter(r=>r.recordId===selection.recordId);
}
// Database jobs contain dated records in descending interaction order. Find
// the inclusive date window without copying every older record on each query.
function dateWindow(rows, startMs, endMs) {
 function firstWhere(predicate) {
  let left = 0, right = rows.length;
  while (left < right) {
   const middle = left + Math.floor((right - left) / 2);
   if (predicate(rows[middle].ms)) right = middle;
   else left = middle + 1;
  }
  return left;
 }
 return [Number.isFinite(endMs) ? firstWhere(ms => ms <= endMs) : 0,
         Number.isFinite(startMs) ? firstWhere(ms => ms < startMs) : rows.length];
}

function selectRows(ordered, o, unread) {
 if (o.unreadOnly && !unread.size) return {matched:0, rows:[]};
 const [start, end] = dateWindow(ordered, o.startMs, o.endMs);
 if (!o.peerUid && !o.unreadOnly) {
  return {matched:end - start, rows:ordered.slice(start, Math.min(start + o.count, end))};
 }
 const rows = [];
 let matched = 0, lastSelected = -1;
 const peer = o.peerUid && 'uid:' + o.peerUid;
 for (let i = start; i < end; i++) {
  const row = ordered[i];
  if (peer && row.peerKey !== peer || o.unreadOnly && !unreadComment(row, unread)) continue;
  matched++;
  if (rows.length < o.count) {
   rows.push(row);
   lastSelected = i;
  }
 }
 if (o.unreadContext && lastSelected >= 0) {
  const limit = rows.length + 100;
  for (let i = lastSelected + 1; i < end && rows.length < limit; i++) {
   const row = ordered[i];
   if ((!peer || row.peerKey === peer) && !unreadComment(row, unread)) rows.push(row);
  }
 }
 return {matched, rows};
}

function missingBodyCount(archive, channels) {
 const missing = new Set();
 for (const kind of channels) {
  const isPost = kind === 'mentions-posts';
  const comparable = channels.filter(other => (other === 'mentions-posts') === isPost).map(other => archive[other].records);
  for (const id of archive[kind].knownIds) {
   if (!comparable.some(records => records.has(id))) missing.add((isPost ? 'post:' : 'comment:') + id);
  }
 }
 return missing.size;
}
function createLocalView(base){
 const renderer=require('../lib/report-catalog').renderIdentity();
 function outputKey(value,job){return crypto.createHash('sha256').update(JSON.stringify({renderer,uid:value.o.uid,postId:value.o.postId,mode:job.kind,...(value.o.peerUid?{peerUid:value.o.peerUid,peerName:value.summary.peerName||''}:{}),from:value.o.from||'',to:value.o.to||'',count:Number.isFinite(value.o.count)?value.o.count:null,markUnread:value.o.markUnread,unreadOnly:value.o.unreadOnly,unreadContext:value.o.unreadContext,label:value.label,rows:job.rows,context:job.context,postAuthors:value.postAuthors,commentOrder:job.commentOrder})).digest('hex');}
 function reusable(key,o){return require('../lib/report-catalog').reusable(base,key,o);}

 const datasets=new Map(),prepared=new Map(),archives=new Map(),readingViews=new Map();let parses=0,renders=0;
 function readingView(o){
  const tracked=o.postId||o.uid&&['sent','received','both','all'].includes(o.mode);if(!tracked)return {reading:{items:{}},signature:'none',unread:new Set()};
  const service=o.postId?require('../lib/post-reading-state'):require('../lib/follow-inbox'),id=o.postId||o.uid,file=service.file(base,id),views=require('../lib/file-view-cache');
  // Scope receipt recovery to the selected owner. Reading flags do not force a
  // full body reparse, and local counts leave durable read state untouched.
  const token=()=>o.postId?service.version(base,id):String(views.stamp(file)?.signature||'absent')+'|'+views.manifest(path.join(path.dirname(file),'request-journal'),{filter:/^[a-f0-9-]+\.response\.json$/}).signature;
  let stamp=token();const hit=readingViews.get(file);if(hit?.signature===stamp)return hit;
  for(let attempt=0;attempt<3;attempt++){
   const reading=o.postId?(service.recover(base,id,{dryRun:true})||{items:{}}):service.view(base,id),after=token();if(after!==stamp){stamp=after;continue;}
   const value={reading,signature:after,unread:require('../lib/follow-inbox').unreadIds(reading)};readingViews.delete(file);readingViews.set(file,value);while(readingViews.size>2)readingViews.delete(readingViews.keys().next().value);return value;
  }
  throw Object.assign(Error('阅读状态正在提交，请等待当前保存边界'),{code:'LOCAL_SNAPSHOT_BUSY'});
 }

 function retain(map,key,value,max){map.delete(key);map.set(key,value);while(map.size>max)map.delete(map.keys().next().value);}
 function prepare(input,selection=null){
  const o=validate(input),p=storagePaths(base),root=o.mode==='post-comments'?p.postComments:o.mode==='user-posts'?p.posts:p.users,index=indexRead(root),dir=o.postId?findPostFolder(root,o.postId):mappedFolder(root,o.uid,index),read=readingView(o),readingSignature=read.signature,sig=signature(dir);
  const indexedPost=o.mode==='post-comments'&&!selection,unreadSelection=indexedPost&&o.unreadOnly;
  const key=(o.postId||o.uid)+'|'+o.mode+(indexedPost?'|'+JSON.stringify([o.from,o.to,Number.isFinite(o.count)?o.count:null,unreadSelection]):'');
  if(selection&&sig!==selection.signature)throw Object.assign(Error('搜索命中所属数据已变化，正在核对保存边界'),{code:'LOCAL_SNAPSHOT_BUSY'});
  let data=datasets.get(key);if(!data||data.signature!==sig||unreadSelection&&data.readingSignature!==readingSignature){
   if(indexedPost){
    const display=(archives.get(dir)?.select?archives.get(dir):null)||require('../lib/post-display-index').create(dir,o.postId);
    retain(archives,dir,display,3);
    const result=display.select(o,unreadSelection?read.unread:null);
    data={dir,label:result.label,jobs:[{kind:o.mode,rows:result.rows,matched:result.matched}],contextRows:result.all,postAuthors:result.postAuthors,warnings:result.warnings,missingBodyCount:0,latestInteractionMs:result.latest,signature:sig,readingSignature,indexed:true};
    retain(datasets,key,data,3);parses++;
   }else{const session=require('../lib/cache-session').createCacheSession({maxBytes:16*1024*1024}),archive=(archives.get(dir)?.load?archives.get(dir):null)||require('../lib/local-archive-view').create(base,dir,o.uid);retain(archives,dir,archive,3);let snapshot;
    const load=(_dir,kind)=>{snapshot??=archive.snapshot(session);return snapshot[kind];};
    data = require('../lib/local-database').databaseJobs({...o,count:Infinity,startMs:-Infinity,endMs:Infinity},{base,session,archive:load});
    if (['sent','received','both','all'].includes(o.mode)) {
     data.contextRows = [];
     for (const kind of ['sent','received']) {
      for (const entry of load(dir, kind).records.values()) data.contextRows.push(entry.row);
     }
    } else {
     data.contextRows = data.jobs.flatMap(job => job.rows);
    }
    data.missingBodyCount = 0;
    if (['post-comments','user-posts'].includes(o.mode)) {
     for (const entry of require('../lib/exchange-records').records(dir,o.mode,o.postId||o.uid,{contexts:true}).values()) {
      data.contextRows.push(entry.row);
     }
    } else {
     for (const row of archive.contexts()) data.contextRows.push(row);
     const channels = o.mode === 'both' ? ['sent','received'] :
      o.mode === 'all' ? ['sent','received','mentions-comments','mentions-posts'] : [o.mode];
     data.missingBodyCount = missingBodyCount(snapshot, channels);
    }
    data.signature = sig;
    retain(datasets,key,data,3);
    parses++;
   }
  }
  if (!data.contextIndex) {
   data.contextIndex = new Map();
   let latest = 0;
   for (const row of data.contextRows) {
    if (row.postId && row.recordId) data.contextIndex.set(row.postId + ':' + row.recordId, row);
    latest = Math.max(latest, row.ms || 0);
   }
   data.latestInteractionMs ??= latest;
   // SQLite orders post IDs by length and text. Keep the report comparator
   // for already-selected post rows, including legacy IDs with leading zeros.
   if (indexedPost) for (const job of data.jobs) job.rows = sortRecords(job.rows);
  }
  if(o.peerUid&&!data.attributedJobs)data.attributedJobs=data.jobs.map(job=>({...job,rows:require('../lib/reader').attributeRows([...job.rows,...data.contextRows],o.uid).slice(0,job.rows.length)}));
  const peerName=o.peerUid?(require('./user-profiles').cached(base,o.peerUid).nickname||data.attributedJobs.flatMap(j=>j.rows).find(r=>r.peerUid===o.peerUid)?.peerName||''):'';
  const label=o.uid?require('./user-profiles').cached(base,o.uid).nickname||data.label:data.label;const identity=JSON.stringify({selection:selection?[selection.key,selection.version,selection.recordId,selection.postId]:null,key,sig,readingSignature,label,peerUid:o.peerUid||'',peerName,from:o.from||'',to:o.to||'',count:Number.isFinite(o.count)?o.count:null,markUnread:o.markUnread,unreadOnly:o.unreadOnly,unreadContext:o.unreadContext}),cacheKey=crypto.createHash('sha256').update(identity).digest('hex');
  if(prepared.has(cacheKey)){const value=prepared.get(cacheKey);retain(prepared,cacheKey,value,4);return value;}
  const allUnread=read.unread;
  const unread=o.markUnread?allUnread:new Set();
  const jobs=(o.peerUid?data.attributedJobs:data.jobs).map(job=>{
   const candidates=selection?job.rows.filter(r=>r.recordId!==selection.recordId).concat(selection.anchor?[{...selection.anchor,targetUid:o.uid}]:[]):job.rows;
   const conversation=selection?(job.kind==='user-posts'?candidates.filter(r=>r.recordId===selection.recordId):selectConversation(candidates,selection,data.contextRows)):candidates;
   // A search anchor can be inserted out of order or carry an unknown date.
   const ordered = selection ? sortRecords(conversation.filter(row => Number.isFinite(row.ms))) : conversation;
   const {matched, rows} = selectRows(ordered, o, allUnread);
   return {kind:job.kind, matched:job.matched ?? matched, rows:rows.map(row => ({
    ...row, targetUid:o.uid, isUnread:unreadComment(row, unread),
   }))};
  });
  const all=data.contextRows;for(const job of jobs){job.context=readingContext(job.rows,data.contextIndex,unread);if(job.kind==='post-comments')job.commentOrder=require('../lib/comment-order').savedRanks(dir,o.postId,job.rows);}
  const rows=jobs.flatMap(j=>j.rows),times=rows.map(r=>r.ms),directions=rows.reduce((n,r)=>{const d=r.directions||[r.group];if(d.includes('sent'))n.sent++;if(d.includes('received'))n.received++;return n;},{sent:0,received:0});
  const searchContext=selection?jobs.flatMap(j=>j.context):[],searchVersions=new Map(selection?.matches?.map(r=>[r.id,r.version])||[]),searchMatched=selection?[...rows,...searchContext].filter(r=>searchVersions.get(r.recordId)===require('../lib/local-corpus').version(require('../lib/local-corpus').compact(r))).length:0;
  const summary={...(selection?{searchMatched,contextCount:searchContext.length}:{}),peerUid:o.peerUid||'',peerName,latestInteractionMs:data.latestInteractionMs,matched:jobs.reduce((n,j)=>n+j.matched,0),selected:rows.length,...directions,oldest:times.length?times.reduce((a,b)=>Math.min(a,b),Infinity):null,newest:times.length?times.reduce((a,b)=>Math.max(a,b),-Infinity):null,unread:rows.filter(r=>unreadComment(r,allUnread)).length,totalUnread:allUnread.size,warnings:data.warnings,missingBodyCount:data.missingBodyCount,localOnly:true,credits:0};
  if(signature(dir)!==sig||readingView(o).signature!==readingSignature)throw Object.assign(Error('本地记录正在提交，请等待当前保存边界'),{code:'LOCAL_SNAPSHOT_BUSY'});
  const value={token:'',input:{...input},o,dir,label,jobs,all,summary,htmls:null,signature:sig,unreadIds:unread,postAuthors:data.postAuthors};for(const job of jobs)job.outputKey=outputKey(value,job);value.token=crypto.createHash('sha256').update(JSON.stringify(jobs.map(job=>job.outputKey))).digest('hex');prepared.set(cacheKey,value);while(prepared.size>4)prepared.delete(prepared.keys().next().value);return value;
 }
 function render(value){if(value.htmls)return value.htmls;value.htmls=value.jobs.map(job=>{
  const context=job.context,o={...value.o,mode:job.kind,lazyConversations:true,conversationContext:context,updateInfo:null,postAuthors:value.postAuthors,commentOrder:job.commentOrder};
  const meta={kind:job.kind,rows:job.rows,budget:job.rows.length,fetched:job.rows.length,ended:true,reason:'本地已保存数据；未核实完整线上历史'};
  let html=job.kind==='user-posts'?require('../lib/posts-reader').renderUserPosts(o,meta,value.label):require('../lib/reader').render(o,job.rows,[meta],value.label);
  if(o.peerUid){const {userLink,esc}=require('../lib/core');html=html.replace(/(<h1>[\s\S]*?<\/h1><p class="subtitle">[\s\S]*?)(<\/p>)/,(_,heading,end)=>heading+'<br>互动对象：'+userLink(value.summary.peerName||o.peerUid,o.peerUid)+' · UID '+esc(o.peerUid)+end);}return html;
 });renders++;return value.htmls;}
 function exportCurrent(input,token,selection=null,{retainedSnapshot=false}={}){return require('../lib/report-lifecycle').locked(base,()=>{
  const condition=o=>JSON.stringify([o.uid||'',o.postId||'',o.mode,Number.isFinite(o.count)?o.count:null,o.startMs,o.endMs,o.peerUid||'',o.markUnread,o.unreadOnly,o.unreadContext]);
  // A displayed count owns immutable, already validated formal rows and read flags.
  // Reuse that exact snapshot for this click, even if an automatic round commits
  // newer rows meanwhile. Never accept an arbitrary token or another form's scope.
  let value=retainedSnapshot&&token&&!selection?[...prepared.values()].find(value=>value.token===token):null;
  if(value&&condition(value.o)!==condition(validate(input)))throw Error('本地查看条件已变化，未使用其他范围的快照');
  if(!value)value=prepare(input,selection);
  if(selection&&signature(value.dir)!==selection.signature)throw Object.assign(Error('搜索命中所属数据已变化，正在核对保存边界'),{code:'LOCAL_SNAPSHOT_BUSY'});if(token&&value.token!==token)throw Object.assign(Error('本地数据或查看条件已变化，请查看更新后的结果再导出'),{code:'LOCAL_SNAPSHOT_STALE'});const files=[];let reused=0;
  if(value.o.mode==='post-comments'){
   const lookup=require('../lib/comment-media-local').create(base,{persist:true}),jobs=value.jobs.map(job=>{const result=lookup.enrich(job.rows,value.o.postId);return result.changed?{...job,rows:result.rows}:job;});
   if(jobs.some((job,i)=>job!==value.jobs[i])){value={...value,jobs,htmls:null};for(const job of jobs)job.outputKey=outputKey(value,job);}
  }
  for(let i=0;i<value.jobs.length;i++){const job=value.jobs[i];if(!job.rows.length)continue;const key=job.outputKey,existing=reusable(key,value.o);if(existing){files.push(existing);reused++;continue;}const html=render(value)[i],dir=require('../lib/data-layout').reportDir(value.dir,base);fs.mkdirSync(dir,{recursive:true});require('../lib/data-layout').mirrorImages(value.dir,base);const name=require('../lib/report-name').fileName(value.label,{...value.o,mode:job.kind},job.rows.length),file=path.join(dir,name);
   const saved=require('../lib/report-catalog').write(file,{...value.o,workspace:base,mode:job.kind},job.rows,value.label,()=>html,key);files.push(path.relative(path.join(base,'output'),saved.file));
  }return {files,reused:files.length>0&&reused===files.length,token:value.token,summary:value.summary};
 });}
 return {prepare,render,exportCurrent,exportConversation:(input,selection)=>exportCurrent(input,null,selection),stats:()=>({parses,renders}),cacheStats:()=>({datasets:datasets.size,prepared:prepared.size})};
}
module.exports={validate,signature,readingContext,selectConversation,createLocalView};
