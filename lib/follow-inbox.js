'use strict';
// Personal reading state stays in data/, never in a shared report.
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto'),views=require('./file-view-cache'),summaries=new WeakMap(),held=new Set();
const {atomic,read}=require('./auto-follow-budget'),{storagePaths,indexRead,mappedFolder}=require('./storage'),{loadIndependentArchive,exactId}=require('./completeness');
function folder(base,uid){if(!/^\d{5,20}$/.test(uid))throw Error('用户 UID 无效');const root=storagePaths(base).users;return mappedFolder(root,uid,indexRead(root));}
function file(base,uid){return path.join(folder(base,uid),'cache/follow-inbox.json');}
function archive(base,uid){const dir=folder(base,uid),session=require('./cache-session').createCacheSession(),rows=new Map();for(const kind of ['sent','received'])for(const [id,e]of loadIndependentArchive(dir,kind,uid,session).records)rows.set(id,{...e.row,group:kind});return rows;}
function preserveInvalid(target){if(!fs.existsSync(target))return;const bytes=fs.readFileSync(target),backup=target.replace(/\.json$/,'.invalid_'+crypto.createHash('sha256').update(bytes).digest('hex').slice(0,16)+'.json');try{fs.writeFileSync(backup,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
function loaded(base,uid,target=file(base,uid)){
 const key='follow-inbox\0'+target;
 const manifest=()=>views.manifest(path.join(path.dirname(target),'request-journal'),{filter:/^[a-f0-9-]+\.response\.json$/}),version=receipts=>(views.stamp(target)?.signature||'absent')+'/'+receipts.signature;
 for(let attempt=0;attempt<3;attempt++){
  const receipts=manifest(),token=version(receipts);
  const entry=views.memo(key,token,()=>locked(base,uid,()=>{
   if(version(manifest())!==token)return {token:null};
   function readBox(){let value=null,invalid=false;try{value=read(target,null);}catch{invalid=true;}if(value?.schema===1&&value.uid===uid&&value.items&&typeof value.items==='object'&&!Array.isArray(value.items))return reconcileReceipts(base,uid,value,receipts);if(invalid||value!=null)preserveInvalid(target);const rows=archive(base,uid);value={schema:1,uid,items:{},lastSent:null,lastReceived:null,initializedAt:new Date().toISOString(),...(invalid||value!=null?{recoveryWarning:'本地未读索引已从保存的数据重建；原文件保留，先前已读状态无法完全还原。'}:{})};updateTimes(value,[...rows.values()],uid);atomic(target,value);return value;}
   const box=readBox();return {box,token:version(manifest())};
  }));
  // Never attach a box read before lock release to a newly observed version.
  // Own receipt recovery writes and concurrent atomic replacement both retry.
  if(entry.token===token&&version(manifest())===token)return entry.box;
 }
 throw Object.assign(Error('阅读状态正在变化，请稍后重试'),{code:'LOCAL_SOURCE_INVALID'});
}
function locked(base,uid,fn){const lock=file(base,uid)+'.lock';if(held.has(lock))return fn();const lease=require('./process-lease').acquire(lock,'未读状态正在保存，请稍后重试');held.add(lock);try{return fn();}finally{held.delete(lock);lease.release();}}
function load(base,uid){return structuredClone(loaded(base,uid));}
function initialize(base,uid){return locked(base,uid,()=>{const box=structuredClone(loaded(base,uid));if(!Number.isFinite(Date.parse(box.initializedAt))){box.initializedAt=new Date().toISOString();atomic(file(base,uid),box);}return box;});}
function view(base,uid){return fs.existsSync(file(base,uid))?load(base,uid):{schema:1,uid,items:{}};}
function preview(base,uid){
 const target=file(base,uid),manifest=()=>views.manifest(path.join(folder(base,uid),'cache/request-journal'),{filter:/^[a-f0-9-]+\.response\.json$/});
 const version=receipts=>(views.stamp(target)?.signature||'absent')+'/'+receipts.signature;
 for(let attempt=0;attempt<3;attempt++){
  const receipts=manifest(),token=version(receipts),value=read(target,null);
  if(value!=null&&(value.schema!==1||value.uid!==uid||!value.items||typeof value.items!=='object'||Array.isArray(value.items)))throw Object.assign(Error('本地未读索引格式无效，预览未修改原文件'),{code:'LOCAL_SOURCE_INVALID'});
  const box=value==null?{schema:1,uid,items:{}}:reconcileReceipts(base,uid,value,receipts,false);
  if(version(manifest())===token)return box;
 }
 throw Object.assign(Error('阅读状态正在变化，请稍后重试'),{code:'LOCAL_SOURCE_INVALID'});
}
function reconcileReceipts(base,uid,box,manifest,persist=true){
 if(!Number.isFinite(Date.parse(box.initializedAt)))return box;
 const seen=new Set(box.receipts||[]),versions={...(box.receiptVersions||{})};let changed=false;
 for(const {file:source,signature}of manifest.files){const name=path.basename(source);if(seen.has(name)&&versions[name]===signature)continue;try{const q=views.fileView(source,'follow-receipt',value=>value);if(q.schema!==1||q.query?.uid!==uid||!['sent','received'].includes(q.query.kind))continue;seen.add(name);versions[name]=signature;changed=true;if(Date.parse(q.savedAt)<Date.parse(box.initializedAt))continue;const wanted=new Set(q.firstSavedIds||[]),rows=[];for(const raw of require('./core').rawArray(q.response,q.query.kind)?.items||[]){const r=require('./core').normalize(raw,q.query.kind,uid);if(!exactId(raw.idstr??raw.id??raw.mid)||q.query.kind==='sent'&&r.authorUid!==uid||!require('./record-body').completeBody(r,raw))continue;rows.push(r);if(wanted.has(r.recordId)&&!box.items[r.recordId])box.items[r.recordId]={id:r.recordId,ms:r.ms,group:q.query.kind,firstSeenAt:q.savedAt,readAt:null};}updateTimes(box,rows,uid);}catch{}}
 if(changed){box.receipts=[...seen];box.receiptVersions=versions;if(persist)atomic(file(base,uid),box);}return box;
}
function updateTimes(box,rows,uid){for(const row of rows){if(!Number.isFinite(row.ms)||row.isContext)continue;const field=row.group==='sent'?'lastSent':row.group==='received'?'lastReceived':row.authorUid===uid?'lastSent':'lastReceived';if(!box[field]||row.ms>box[field].ms)box[field]={ms:row.ms,time:row.time,id:row.recordId};}}
function isUnread(id, row) {
 return exactId(id) && row?.id === id && !row.isContext && !row.readAt;
}

function unreadIds(box) {
 const ids = new Set();
 for (const [id, row] of Object.entries(box.items || {})) {
  if (isUnread(id, row)) ids.add(id);
 }
 return ids;
}

function ingest(base, uid, batchId) {
 return locked(base, uid, () => {
  const box = load(base, uid);
  if (!batchId || box.batches?.includes(batchId)) return box;

  const batch = require('./database-sync').readBatch(folder(base, uid), batchId);
  if (batch.uid !== uid || batch.category !== 'user-comments') throw Error('更新批次与用户不匹配');
  const rows = batch.rows.filter(row => ['sent', 'received', 'both'].includes(row.group) &&
   exactId(row.recordId) && !row.isContext && require('./record-body').completeBody(row));
  updateTimes(box, rows, uid);
  const predatesTracking = Date.parse(batch.createdAt) < Date.parse(box.initializedAt);
  if (!predatesTracking) {
   const keys = new Set(batch.newKeys);
   for (const row of rows) {
    const id = row.recordId;
    if (keys.has('comment:' + id) && !box.items[id]) {
     box.items[id] = {id, ms:row.ms, group:row.group, firstSeenAt:batch.createdAt, readAt:null};
    }
   }
  }
  box.batches = [...(box.batches || []), batchId];
  atomic(file(base, uid), box);
  return box;
 });
}
function summarize(box){if(!summaries.has(box))summaries.set(box,{unread:unreadIds(box).size,lastSent:box.lastSent,lastReceived:box.lastReceived,...(box.recoveryWarning?{warning:box.recoveryWarning}:{})});return structuredClone(summaries.get(box));}
function summary(base, uid, batchId = '') {
 const box = loaded(base, uid);
 if (!batchId || box.batches?.includes(batchId)) return summarize(box);
 ingest(base, uid, batchId);
 return summarize(loaded(base, uid));
}
function existingSummary(base,uid){const target=file(base,uid);return fs.existsSync(target)?summarize(loaded(base,uid,target)):{unread:0};}
function markRead(base, uid, ids) {
 return locked(base, uid, () => {
  const box = loaded(base, uid);
  const pending = [...new Set(ids)].filter(id => Object.hasOwn(box.items, id) && isUnread(id, box.items[id]));
  if (!pending.length) return {changed:0, ...summarize(box)};

  const items = {...box.items}, readAt = new Date().toISOString();
  for (const id of pending) items[id] = {...items[id], readAt};
  const next = {...box, items};
  atomic(file(base, uid), next);
  return {changed:pending.length, ...summarize(next)};
 });
}
function peek(base,uid){const box=read(file(base,uid),null);return box?.schema===1&&box.uid===uid?box:{schema:1,uid,items:{}};}
module.exports={unreadIds,initialize,view,preview,peek,folder,file,load,ingest,summary,existingSummary,markRead};
