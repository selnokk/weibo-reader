'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {inventory,query}=require('../desktop/local-inventory');
const views=require('../lib/file-view-cache'),uid='1234567890',peer='9876543210',post='8888888888';
function fixture(fn){const base=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-inventory-'));const dir=path.join(base,'data/user-comments',uid),postDir=path.join(base,'data/post-comments',post);const save=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data));};save(path.join(base,'data/.layout-v2'),2);const row=(id,author=uid)=>({idstr:String(id),text:'正文 '+id,created_at:'2026-10-29T12:00:00+08:00',user:{idstr:author},status:{idstr:post,user:{idstr:peer}}});const cache=(kind,raw,name=kind+'_c100_m0.json')=>save(path.join(dir,'cache',name),raw);try{return fn({base,dir,postDir,save,row,cache,q:{target:uid,mode:'comments-both'}});}finally{fs.rmSync(base,{recursive:true,force:true});views.clear();}}
test('inventory counts independent bodies once, known missing precisely, quotes never as bodies, independent of form filters',()=>fixture(({base,dir,save,row,cache,q})=>{
 const quoted=row('40',peer);cache('sent',{comments:[{...row('50'),reply_comment:quoted},row('51')],miss_ids:['40','52','52']});cache('received',{comments:[row('50'),{...row('53',peer),text:''}],miss_ids:['54']});
 const value=inventory(base,{...q,limit:1,from:'2020-01-01',to:'2020-01-02',peerUid:peer,markUnread:true});assert.equal(value.records,2);assert.equal(value.missingBodyCount,4);assert.equal(value.localOnly,true);assert.equal(value.credits,0);assert.equal(value.complete,true);
 assert.deepEqual(query({...q,limit:1,from:'invalid'}),{...q,unlimited:true});assert.equal(inventory(base,{...q,mode:'comments-sent'}).missingBodyCount,2);assert.equal(inventory(base,{...q,mode:'comments-received'}).missingBodyCount,2);
 const inbox=path.join(dir,'cache/follow-inbox.json');save(inbox,{schema:1,uid,items:{'50':{readAt:null}}});const before=fs.readFileSync(inbox);inventory(base,q);assert.deepEqual(fs.readFileSync(inbox),before);assert.equal(fs.existsSync(path.join(base,'output')),false);
}));
test('saved response is counted after interrupted processing; restored bodies clear missing count without new requests',()=>fixture(({base,dir,save,row,cache,q})=>{
 cache('received',{comments:[],miss_ids:['70']});const file=path.join(dir,'cache/request-journal','12345678-1234-1234-1234-123456789abc.response.json');save(file,{schema:1,query:{uid,kind:'received'},savedAt:'2026-10-29T00:00:00Z',response:{comments:[row('70',peer)]}});const x=inventory(base,q);assert.equal(x.records,1);assert.equal(x.missingBodyCount,0);save(path.join(dir,'cache/request-journal','bad.response.json'),{schema:1,query:{uid:peer,kind:'received'},response:{comments:[row('99',peer)],miss_ids:['100']}});assert.equal(inventory(base,q).records,1);assert.equal(inventory(base,q).missingBodyCount,0);
}));
test('post inventory includes independent nested replies and missing IDs but ignores quoted parents and other typed objects',()=>fixture(({base,postDir,save,row,cache,q})=>{
 cache('sent',{comments:[row('50')],miss_ids:['55']});const raw={comments:[{...row('60',peer),comments:[row('61')],reply_comment:row('62')}],miss_ids_str:['63']};save(path.join(postDir,'cache/post-comments_c200_m0.json'),raw);
 const x=inventory(base,{target:post,mode:'post-comments'});assert.equal(x.records,2);assert.equal(x.missingBodyCount,1);assert.equal(inventory(base,q).records,1);assert.equal(inventory(base,q).missingBodyCount,1);assert.equal(inventory(base,{target:uid,mode:'post-comments'}).records,0);
}));
test('inventory cache invalidates on atomic replacement, not read-state changes, and malformed files remain explicit',()=>fixture(({base,dir,row,cache,save,q})=>{
 cache('sent',{comments:[row('50')]});inventory(base,q);const read=fs.readFileSync,open=fs.openSync,close=fs.closeSync,handles=new Map();let reads=0;fs.openSync=function(file,...args){const fd=open.call(this,file,...args);handles.set(fd,String(file));return fd;};fs.closeSync=function(fd){handles.delete(fd);return close.call(this,fd);};fs.readFileSync=function(file,...args){if(String(typeof file==='number'?handles.get(file):file).startsWith(dir))reads++;return read.call(this,file,...args);};try{inventory(base,q);assert.equal(reads,0);save(path.join(dir,'cache/follow-inbox.json'),{items:{'50':{readAt:'now'}}});inventory(base,q);assert.equal(reads,0);const file=path.join(dir,'cache/sent_c100_m0.json');save(file+'.tmp',{comments:[row('51')],miss_ids:['52']});fs.renameSync(file+'.tmp',file);const changed=inventory(base,q);assert.equal(changed.records,1);assert.equal(changed.missingBodyCount,1);assert.ok(reads>0);}finally{fs.readFileSync=read;fs.openSync=open;fs.closeSync=close;}
 fs.writeFileSync(path.join(dir,'cache/received_c100_m0.json'),'broken');const broken=inventory(base,q);assert.equal(broken.records,1);assert.equal(broken.complete,false);assert.ok(broken.warnings.some(v=>v.includes('received_c100_m0')));
}));
test('unsafe numeric IDs are not guessed and exact large string IDs remain distinct',()=>fixture(({base,row,cache,q})=>{
 cache('sent',{comments:[row('9007199254740993'),row('9007199254740994')],miss_ids:[9007199254740996,'9007199254740995']});const x=inventory(base,q);assert.equal(x.records,2);assert.equal(x.missingBodyCount,1);
}));

test('persistent totals survive a fresh process without parsing any historical source and update only changed files',()=>fixture(({base,dir,row,cache,q})=>{
 const index=require('../lib/inventory-index');index.clear();for(let n=0;n<80;n++)cache('sent',{comments:[row(String(1000+n))],miss_ids:['2000']},`sent_c100_m${n}.json`);assert.equal(inventory(base,q).records,80);const saved=index.file(dir);assert.ok(fs.existsSync(saved));assert.equal(index.stats().sourceReads,80);
 const {execFileSync}=require('node:child_process'),modulePath=require.resolve('../desktop/local-inventory'),indexPath=require.resolve('../lib/inventory-index');const cold=()=>JSON.parse(execFileSync(process.execPath,['-e',`const x=require(${JSON.stringify(modulePath)}).inventory(${JSON.stringify(base)},${JSON.stringify(q)});console.log(JSON.stringify({x,stats:require(${JSON.stringify(indexPath)}).stats()}));`],{encoding:'utf8'}));
 const restarted=cold();assert.equal(restarted.x.records,80);assert.equal(restarted.stats.sourceReads,0);assert.equal(restarted.stats.rebuilds,0);assert.equal(restarted.stats.indexReads,1);
 cache('received',{comments:[row('2000',peer),row('3000',peer)]});const changed=cold();assert.equal(changed.x.records,82);assert.equal(changed.x.missingBodyCount,0);assert.equal(changed.stats.sourceReads,1);assert.equal(changed.stats.rebuilds,0);assert.equal(changed.stats.updates,1);assert.equal(cold().stats.sourceReads,0);
}));
test('per-source reference counts handle duplicates, removal, body restoration and direction unions without double counting',()=>fixture(({base,dir,row,cache,q})=>{
 cache('sent',{comments:[row('50')],miss_ids:['60']});cache('received',{comments:[row('50')],miss_ids:['60']});inventory(base,q);
 cache('sent',{comments:[row('50'),row('60')]},'sent_c2_m80.json');assert.equal(inventory(base,q).records,2);assert.equal(inventory(base,q).missingBodyCount,0);assert.equal(inventory(base,{...q,mode:'comments-received'}).missingBodyCount,1);
 fs.unlinkSync(path.join(dir,'cache/sent_c2_m80.json'));assert.equal(inventory(base,q).records,1);assert.equal(inventory(base,q).missingBodyCount,1);fs.unlinkSync(path.join(dir,'cache/sent_c100_m0.json'));assert.equal(inventory(base,q).records,1);assert.equal(inventory(base,{...q,mode:'comments-sent'}).records,0);fs.unlinkSync(path.join(dir,'cache/received_c100_m0.json'));assert.equal(inventory(base,q).records,0);assert.equal(inventory(base,q).missingBodyCount,0);
}));
test('derived index corruption rebuilds locally; a failed atomic replacement preserves the previous index and all raw data',()=>fixture(({base,dir,row,cache,q})=>{
 const index=require('../lib/inventory-index');cache('sent',{comments:[row('50')]});inventory(base,q);const file=index.file(dir),before=fs.readFileSync(file);cache('received',{comments:[row('60',peer)]});const rename=fs.renameSync;fs.renameSync=function(a,b){if(b===file)throw Object.assign(Error('模拟磁盘空间不足'),{code:'ENOSPC'});return rename.call(this,a,b);};try{const value=inventory(base,q);assert.equal(value.records,2);assert.equal(value.complete,false);assert.match(value.warnings.join(''),/统计结果未能保存/);assert.deepEqual(fs.readFileSync(file),before);}finally{fs.renameSync=rename;}
 index.clear();assert.equal(inventory(base,q).records,2);const corrupt=JSON.parse(fs.readFileSync(file));corrupt.data.totals.both.records=99999;fs.writeFileSync(file,JSON.stringify(corrupt));index.clear();assert.equal(inventory(base,q).records,2);assert.equal(index.stats().rebuilds,1);assert.equal(fs.readdirSync(path.join(dir,'cache')).filter(n=>n.endsWith('.tmp')).length,0);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'cache/sent_c100_m0.json'))).comments[0].text,'正文 50');
}));
test('saved packets after an interrupted run repair totals on reopen without touching cursors, inbox, fees or snapshots',()=>fixture(({base,dir,save,row,cache,q})=>{
 const index=require('../lib/inventory-index');cache('sent',{comments:[row('50')]});inventory(base,q);const files=['updates/sent.json','follow-inbox.json','billing.json'];for(const name of files)save(path.join(dir,'cache',name),{sentinel:name,anchor:'1000'});const before=files.map(name=>fs.readFileSync(path.join(dir,'cache',name)));
 save(path.join(dir,'cache/request-journal/12345678-1234-1234-1234-123456789abc.response.json'),{schema:1,query:{uid,kind:'sent'},response:{comments:[row('70')]}});index.clear();const value=inventory(base,q);assert.equal(value.records,2);assert.equal(index.stats().sourceReads,1);for(let n=0;n<files.length;n++)assert.deepEqual(fs.readFileSync(path.join(dir,'cache',files[n])),before[n]);
}));
test('typed status and comment IDs, snapshots and imported context stay separate in the shared persistent index',()=>fixture(({base,dir,save,row,cache,q})=>{
 const crypto=require('node:crypto');cache('sent',{comments:[row('50')]});cache('mentions-posts',{statuses:[{...row('50'),text:'被提及微博'}]});assert.equal(inventory(base,{...q,mode:'comments-and-mentions'}).records,2);
 const raw=require('../lib/core').normalize(row('60',peer),'received',uid),quote={...raw,recordId:'61',isContext:true};const snapshot={schema:1,uid,rows:[raw,quote]},bytes=JSON.stringify(snapshot),hash=crypto.createHash('sha256').update(bytes).digest('hex');save(path.join(dir,'cache/report-snapshots',hash+'.json'),snapshot);assert.equal(inventory(base,q).records,2);assert.equal(inventory(base,{...q,mode:'comments-received'}).records,1);
 const value={schema:1,role:'records',owner:{kind:'user',id:uid},channel:'received',savedAt:'2026-10-29T00:00:00Z',rows:[{...raw,recordId:'62'},quote]};const h=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');save(path.join(dir,'cache/exchange-v1',h+'.json'),value);assert.equal(inventory(base,q).records,3);assert.equal(inventory(base,q).missingBodyCount,0);
}));
test('new data saving maintains an existing persistent inventory before reopening a page',()=>{
 const {copyProject}=require('./helpers.cjs'),{execFileSync}=require('node:child_process'),root=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-inventory-save-'));try{copyProject(root);const dir=path.join(root,'data/user-comments',uid);fs.mkdirSync(path.join(dir,'cache'),{recursive:true});fs.writeFileSync(path.join(root,'data/.layout-v2'),'2');const code=`const dir=${JSON.stringify(dir)},id=${JSON.stringify(uid)};require('./lib/inventory-index').update(dir,{id,category:'user-comments'});const fs=require('fs');fs.writeFileSync(dir+'/cache/sent_c1_m0.json',JSON.stringify({comments:[{idstr:'50',text:'正文',created_at:'2026-10-29T12:00:00+08:00',user:{idstr:id}}]}));require('./lib/database-sync').finishSync({uid:id,mode:'sent',count:1,syncOnly:true},dir,[{kind:'sent',rows:[],newRows:[],budget:1,fetched:1,ended:true}],id);const state=JSON.parse(fs.readFileSync(require('./lib/inventory-index').file(dir))).data;console.log('RESULT:'+JSON.stringify(state.totals.sent));`;const result=execFileSync(process.execPath,['-e',code],{cwd:root,encoding:'utf8'});assert.match(result,/RESULT:\{"records":1,"missingBodyCount":0\}/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('statistics memory stays bounded across many identities, and eviction reuses persisted source totals',()=>{
 const index=require('../lib/inventory-index'),base=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-inventory-lru-'));index.clear();
 try{
  for(let n=0;n<14;n++){
   const id=String(1234567800+n),dir=path.join(base,id),file=path.join(dir,'cache/sent_c1_m0.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({comments:[{idstr:'100',text:'独立正文',created_at:'2026-10-29T12:00:00+08:00',user:{idstr:id}}]}));
   assert.equal(index.inventory(dir,{id,category:'user-comments'},'both').records,1);assert.ok(index.stats().entries<=8);assert.ok(index.stats().estimatedBytes<=index.stats().maxBytes);
  }
  const before=index.stats();assert.equal(index.inventory(path.join(base,'1234567800'),{id:'1234567800',category:'user-comments'},'both').records,1);assert.equal(index.stats().sourceReads,before.sourceReads);assert.equal(index.stats().indexReads,before.indexReads+1);
 }finally{index.clear();fs.rmSync(base,{recursive:true,force:true});}
});

test('an owner change cannot reuse the previous owner’s in-memory inventory at the same path', () =>
 fixture(({dir, row, cache}) => {
  const index = require('../lib/inventory-index');
  cache('sent', {comments:[row('501'), row('502', peer)]});
  const original = {id:uid, category:'user-comments'}, other = {...original, id:peer};
  index.inventory(dir, original, 'sent');
  assert.equal(index.snapshot(dir, other), null);
  assert.deepEqual([...index.completeIds(dir, other, ['501','502'])], ['502']);
  assert.deepEqual([...index.completeIds(dir, original, ['501','502'])], ['501']);
 }));
