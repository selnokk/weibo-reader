'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,uid,peer,post,save}=require('./insights-fixtures.cjs'),S=require('../lib/local-search'),C=require('../lib/local-corpus');
async function run(fn){const f=fixture();try{return await fn(f);}finally{f.close();}}
const query=(base,text='关键词',extra={})=>S.search(base,{text,...extra});
test('oversized obsolete owner indexes are rejected before reading; current data rebuilds in bounded source parts',()=>run(async f=>{
 const source=f.cache(f.dir,'sent',[f.row('5000000000000001')]),before=fs.readFileSync(source),owner=C.objects(f.base).objects.find(o=>o.key==='user-comments:'+uid),name=S.indexFile(f.base,owner);fs.mkdirSync(path.dirname(name),{recursive:true});const fd=fs.openSync(name,'w');fs.ftruncateSync(fd,10*1024*1024);fs.closeSync(fd);
 const read=fs.openSync;let oversizedReads=0;fs.openSync=(file,...options)=>{if(file===name&&fs.statSync(file).size>4*1024*1024){oversizedReads++;throw Error('OVERSIZED_INDEX_MUST_NOT_BE_READ');}return read(file,...options);};try{const result=await query(f.base);assert.equal(result.total,1);assert.equal(result.state,'ready');assert.equal(oversizedReads,0);assert.equal(JSON.parse(fs.readFileSync(name)).version,require('../lib/search-source-index').VERSION);assert(fs.statSync(name).size<10000);assert.deepEqual(fs.readFileSync(source),before);}finally{fs.openSync=read;}
}));
test('a worker memory failure rejects its request and the next search starts a fresh offline worker',()=>run(async f=>{
 const {EventEmitter}=require('events'),{Worker}=require('worker_threads');f.cache(f.dir,'sent',[f.row('5000000000000001')]);let count=0;const service=require('../desktop/local-insights').create(f.base,{makeWorker:(...args)=>{if(++count>1)return new Worker(...args);const w=new EventEmitter();w.ref=w.unref=()=>{};w.terminate=()=>{};w.postMessage=()=>queueMicrotask(()=>w.emit('error',Object.assign(Error('synthetic OOM'),{code:'ERR_WORKER_OUT_OF_MEMORY'})));return w;}});
 try{await assert.rejects(service.request('search',{text:'关键词'}),{code:'ERR_WORKER_OUT_OF_MEMORY'});const result=await service.request('search',{text:'关键词'});assert.equal(result.total,1);assert.equal(result.rows[0].id,'5000000000000001');assert.equal(count,2);}finally{service.close();}
}));
test('excessive matched content fails with a named bound and a subsequent narrower search remains usable',()=>run(async f=>{
 const text='BUDGET_MATCH '+'x'.repeat(1100000),source=f.cache(f.dir,'sent',Array.from({length:24},(_,i)=>f.row(String(5000000000000000n+BigInt(i)),text+(i===0?' ONLY_ONE_MATCH':'')))),hash=C.hash(fs.readFileSync(source)),service=require('../desktop/local-insights').create(f.base);
 try{await assert.rejects(service.request('search',{text:'BUDGET_MATCH'}),{code:'LOCAL_SEARCH_LIMIT'});const result=await service.request('search',{text:'ONLY_ONE_MATCH'});assert.equal(result.total,1);assert.equal(result.rows[0].id,'5000000000000000');assert.equal(C.hash(fs.readFileSync(source)),hash);}finally{service.close();}
}));
test('unchanged search shards reuse validated projections and reject external index replacement',()=>run(async f=>{
 f.cache(f.dir,'sent',[f.row('90071992547409931')]);
 await query(f.base);await query(f.base);const reads=S.metrics.indexReads;
 const same=await query(f.base);assert.equal(same.total,1);assert.equal(S.metrics.indexReads,reads,'unchanged shard must not be read and hashed again');
 const owner=C.objects(f.base).objects.find(o=>o.key==='user-comments:'+uid),name=S.indexFile(f.base,owner),box=JSON.parse(fs.readFileSync(name));
 const partName=Object.values(box.files)[0].parts[0].name,partFile=path.join(path.dirname(name),'parts',C.hash(owner.key),partName),part=JSON.parse(fs.readFileSync(partFile));part.rows[0].content='伪造索引正文';const temp=partFile+'.replacement';save(temp,part);fs.renameSync(temp,partFile);
 const repaired=await query(f.base);assert.equal(repaired.total,1);assert.notEqual(repaired.rows[0].content,'伪造索引正文');assert(S.metrics.indexReads>reads);
 f.cache(f.dir,'sent',[f.row('90071992547409932')],'c1_m1');assert.equal((await query(f.base)).total,2);
}));
test('search empty is idle without opening corpus; typed exact IDs dedup across owners/directions/nested post replies and retain all origins',()=>run(async f=>{
 assert.equal((await query(f.base,'')).state,'idle');assert.equal(fs.existsSync(path.join(f.base,'data/.reader/indexes')),false);
 const r=f.row('90071992547409931');f.cache(f.dir,'sent',[r]);f.cache(f.other,'received',[r]);f.cache(f.postDir,'post-comments',[{...r,comments:[f.row('90071992547409932','关键词 楼中楼',peer)]}]);
 save(path.join(f.posts,'cache/user-posts_c100_m0.json'),{endpoint:'statuses user_timeline/other',query:{uid},response:{statuses:[f.row(r.idstr)]}});
 const x=await query(f.base);assert.equal(x.total,3);assert.equal(x.rows.filter(r=>r.id==='90071992547409931').length,2);assert.equal(x.rows.find(r=>r.type==='comment'&&r.id==='90071992547409931').allSources.length,3);assert.ok(x.rows.some(r=>r.id==='90071992547409932'));assert.equal(x.credits,0);
}));
test('body versions, quote-only hits, missing IDs/time and unsafe numeric IDs are honest and never promoted or guessed',()=>run(async f=>{
 const quoted=f.row('40','引用限定关键词',peer);f.cache(f.dir,'sent',[f.row('50','版本一关键词',uid,undefined,quoted),f.row('51','关键词 无时间',uid,'?'),{text:'关键词 无ID',created_at:'2026-10-29T00:00:00Z',user:{idstr:uid}}]);f.cache(f.dir,'sent',[f.row('50','版本二关键词')],'c1_m50');
 let x=await query(f.base,'关键词');assert.equal(x.rows.find(r=>r.id==='50').versions,2);assert.equal(x.rows.find(r=>r.id==='40').contextOnly,true);assert.equal(x.rows.find(r=>r.id==='51').ms,null);assert.equal(x.unidentified,1);assert.ok(x.rows.at(-1).ms===null);assert.equal(x.exactTotal,x.total-1);
 x=await query(f.base,'引用限定');const selected=await S.resolve(f.base,x,x.rows[0].key);assert.equal(selected.selection.recordId,'50');assert.equal(selected.selection.anchor.replyRecord.recordId,'40');
 f.cache(f.dir,'sent',[{id:90071992547409930,text:'关键词',created_at:'2026-10-29',user:{idstr:uid}}],'c1_m1');x=await query(f.base);assert.equal(x.state,'partial');assert.match(x.warnings.join(''),/精度/);
}));
test('quote projections preserve exact formal anchors when saved context and shared quotes are interleaved',()=>run(async f=>{
 const shared=f.row('90071992547409931','仅共享引用命中',peer),other=f.row('90071992547409932','仅独立引用命中',peer);
 const savedContext={...f.row('90071992547409933','已保存上下文'),isContext:true};
 const first=f.row('90071992547409934','第一条正式正文',uid,'2026-10-29T02:00:00Z',shared);
 const second=f.row('90071992547409935','第二条正式正文',uid,'2026-10-28T02:00:00Z',shared);
 const third=f.row('90071992547409936','第三条正式正文',uid,'2026-10-27T02:00:00Z',other);
 const file=f.cache(f.dir,'sent',[savedContext,first,second,third]),raw=fs.readFileSync(file);
 const owner=C.objects(f.base).objects.find(o=>o.key==='user-comments:'+uid),entry=C.manifest(owner).files.find(e=>e.file===file);
 for(const full of [false,true]){
  const projection=C.project(entry,owner,{full});
  assert.deepEqual(projection.filter(r=>!r.formal).map(r=>[r.recordId,r.anchorId]),[[savedContext.idstr,''],[shared.idstr,first.idstr],[other.idstr,third.idstr]]);
 }
 const result=await query(f.base,'仅共享引用');
 assert.equal(result.total,1);assert.equal(result.rows[0].id,shared.idstr);assert.equal(result.rows[0].contextOnly,true);
 const resolved=await S.resolve(f.base,result,result.rows[0].key);
 assert.equal(resolved.selection.recordId,first.idstr);assert.equal(resolved.selection.anchor.replyRecord.recordId,shared.idstr);
 assert.deepEqual(fs.readFileSync(file),raw);
}));
test('literal Chinese/emoji/quotes/script text, date-owner-author intersections, stable sort and full-range pagination',()=>run(async f=>{
 const text='中文🙂 "引号" <script>alert(1)</script>';f.cache(f.dir,'sent',Array.from({length:95},(_,i)=>f.row(String(1000+i),text,uid,i===0?'2025-12-31T16:00:00Z':'2026-01-02T00:00:00+08:00')));
 let x=await query(f.base,'中文🙂');assert.equal(x.total,95);assert.deepEqual(x.rows.map(r=>r.id),[...x.rows].sort((a,b)=>(b.ms-a.ms)||a.key.localeCompare(b.key)).map(r=>r.id));assert.equal((await query(f.base,'引号',{author:uid,owner:'user-comments:'+uid,from:'2026-01-01',to:'2026-01-01'})).total,1);assert.equal((await query(f.base,'alert(1)')).total,95);assert.equal((await query(f.base,'不存在')).total,0);assert.equal((await query(f.base,'中文',{author:peer})).total,0);assert.equal((await query(f.base,'中文',{owner:'posts:'+uid})).total,0);
 await assert.rejects(query(f.base,'x'.repeat(4097)),/4096/);await assert.rejects(query(f.base,'中文',{from:'2026-02-30'}),/日期/);
}));
test('persistent incremental shards survive restart; replacement/deletion/import invalidates, corrupt index rebuilds and cancellation leaves raw content intact',()=>run(async f=>{
 const file=f.cache(f.dir,'sent',[f.row('50')]);const before=fs.readFileSync(file);let x=await query(f.base);const reads=S.metrics.sourceReads;await query(f.base);assert.equal(S.metrics.sourceReads,reads);assert.ok(S.metrics.reusedSources>0);
 const owner=C.objects(f.base).objects.find(o=>o.key==='user-comments:'+uid),name=S.indexFile(f.base,owner);fs.writeFileSync(name,'broken');x=await query(f.base);assert.equal(x.total,1);assert.equal(S.metrics.sourceReads,reads,'a corrupt owner manifest may reuse independently hash-checked source parts');
 const canonical=require('../lib/core').normalize(f.row('60'),'received',uid),v={schema:1,role:'records',owner:{kind:'user',id:uid},channel:'received',savedAt:'2026-10-29T00:00:00Z',rows:[canonical]};const hash=C.hash(v);save(path.join(f.dir,'cache/exchange-v1',hash+'.json'),v);x=await query(f.base);assert.equal(x.total,2);await query(f.base);assert.equal((await query(f.base)).total,2);
 fs.unlinkSync(file);assert.equal((await query(f.base)).total,1);const controller=new AbortController();controller.abort();await assert.rejects(S.search(f.base,{text:'关键词'},{signal:controller.signal}),/abort/i);assert.equal(before.length>0,true);
}));
test('snapshot cannot export a changed source or use a different owner; valid conversation uses full context, shared retention and exact browser receipt',()=>run(async f=>{
 const quote=f.row('40','前文',peer,'2026-10-27T00:00:00Z'),a=f.row('50','定位句',uid,'2026-10-28T00:00:00Z',quote),b=f.row('60','后续回答',peer,'2026-10-29T00:00:00Z',a);f.cache(f.dir,'sent',[a]);f.cache(f.dir,'received',[b,f.row('777','同博文无关对话',peer)]);f.cache(f.other,'sent',[f.row('99','另一条',peer)]);
 const inbox=require('../lib/follow-inbox'),inboxFile=inbox.file(f.base,uid);save(inboxFile,{schema:1,uid,items:Object.fromEntries(['40','50','60','99'].map(id=>[id,{id,readAt:null}]))});const before=fs.readFileSync(inboxFile),x=await query(f.base,'定位句'),hit=x.rows.find(r=>r.id==='50');assert.deepEqual(fs.readFileSync(inboxFile),before);await assert.rejects(S.resolve(f.base,x,hit.key,'user-comments:'+peer),/未保存/);
 const spec=await S.resolve(f.base,x,hit.key,'user-comments:'+uid),view=require('../desktop/local-view').createLocalView(f.base),out=view.exportConversation(spec.input,spec.selection);assert.equal(out.summary.selected,2);const file=path.join(f.base,'output',out.files[0]),payload=require('../lib/report-records').reportPayload(fs.readFileSync(file,'utf8'),uid);assert.deepEqual(payload.rows.map(r=>r.recordId).sort(),['50','60']);assert.ok(payload.rows.some(r=>r.recordId==='50'&&r.replyRecord?.recordId==='40')||payload.context.some(r=>r.recordId==='40'));assert.match(fs.readFileSync(file,'utf8'),/前文/);assert.deepEqual(fs.readFileSync(inboxFile),before);
 const access=require('../desktop/report-access').createReportAccess(f.base);access.open(out.files[0]);assert.deepEqual(fs.readFileSync(inboxFile),before);const ticket=access.open(out.files[0]);assert.equal(access.opened(ticket.unreadTicket).changed,2);assert.deepEqual([...inbox.unreadIds(inbox.peek(f.base,uid))].sort(),['40','99']);const fresh=await query(f.base,'定位句'),again=await S.resolve(f.base,fresh,hit.key,'user-comments:'+uid);assert.equal(view.exportConversation(again.input,again.selection).files.length,1);
 f.cache(f.dir,'sent',[f.row('51')],'c1_m51');await assert.rejects(S.resolve(f.base,x,hit.key),/变化/);assert.throws(()=>view.exportConversation(spec.input,spec.selection),/变化/);
}));
test('small independent direct reference agrees with complete index across mixed saved objects',()=>run(async f=>{
 const contents=[f.row('100','ref phrase'),f.row('101','other'),f.row('102','ref phrase',uid,'2026-01-01T00:00:00Z')];const file=f.cache(f.dir,'sent',contents);f.cache(f.other,'received',[contents[0]]);f.cache(f.postDir,'post-comments',[contents[0]]);
 const direct=new Set(JSON.parse(fs.readFileSync(file)).comments.filter(r=>r.text.includes('ref phrase')).map(r=>'comment:'+r.idstr));const indexed=await query(f.base,'ref phrase');assert.deepEqual(new Set(indexed.rows.map(r=>r.key)),direct);assert.equal(indexed.rows.find(r=>r.id==='100').sources.length,3);
}));
test('worker pages all matches, detects changes, cancels and remains strictly offline',()=>run(async f=>{
 f.cache(f.dir,'sent',Array.from({length:90},(_,i)=>f.row(String(i+1000))));const worker=require('../desktop/local-insights').create(f.base);try{const a=await worker.request('search',{text:'关键词'});assert.equal(a.total,90);assert.equal(a.rows.length,40);const b=await worker.request('page',{}, {snapshot:a.snapshot,page:2});assert.equal(b.rows.length,10);assert.equal(b.rows.some(r=>a.rows.some(v=>r.key===v.key)),false);f.cache(f.dir,'sent',[f.row('2000')],'c1_m2000');await assert.rejects(worker.request('page',{}, {snapshot:a.snapshot,page:1}),/变化/);
 const pending=worker.request('search',{text:'关键词'});worker.cancel();await assert.rejects(pending,/取消/);const again=await worker.request('search',{text:'关键词'});assert.equal(again.total,91);
 }finally{worker.close();}
}));
test('quote fragments never become independent bodies, full bodies win, and owner catalog corruption is explicitly partial',()=>run(async f=>{
 f.cache(f.dir,'sent',[{...f.row('50','关键词 引用片段'),isContext:true},f.row('51','关键词 完整正文')]);f.cache(f.dir,'sent',[{...f.row('51','关键词 截断'),truncated:true}],'c1_m51');const x=await query(f.base);assert.equal(x.rows.find(r=>r.id==='50').contextOnly,true);assert.equal(x.rows.find(r=>r.id==='51').content,'关键词 完整正文');assert.equal(x.rows.find(r=>r.id==='51').versions,2);
 save(path.join(f.base,'data/user-comments/.account_names.json'),'broken');assert.equal((await query(f.base)).state,'partial');assert.match((await query(f.base)).warnings.join(''),/索引损坏/);
}));
test('failed index commit leaves source intact and can rebuild; saved shard is not a continuity or source authority',()=>run(async f=>{
 const file=f.cache(f.dir,'sent',[f.row('50')]),before=fs.readFileSync(file),P=require('../lib/update-progress'),atomic=P.atomic;P.atomic=()=>{throw Error('模拟磁盘不足');};try{const result=await query(f.base);assert.equal(result.total,1);assert.equal(result.state,'partial');assert.match(result.warnings.join(''),/磁盘不足/);}finally{P.atomic=atomic;}assert.deepEqual(fs.readFileSync(file),before);assert.equal((await query(f.base)).state,'ready');
 const x=await query(f.base);fs.mkdirSync(path.join(f.base,'data/user-comments/5555555555/cache'),{recursive:true});assert.throws(()=>S.assertSnapshot(f.base,x),/对象列表/);
}));
test('derived search/timeline files are excluded from data packages, and imported content remains locally searchable without networking',()=>run(async f=>{
 f.cache(f.dir,'sent',[f.row('50')]);save(path.join(f.base,'data/user-comments/.account_names.json'),{[uid]:{folder:uid,nickname:'甲'}});await query(f.base);await require('../lib/coverage-timeline').build(f.base,{uid});const X=require('../lib/data-exchange'),file=path.join(f.base,'exchange.wrdpack');const out=await X.exportPackage(f.base,'all',file);const actual=out.path||out.file||file,bytes=require('node:zlib').gunzipSync(fs.readFileSync(actual)),offset=X.MAGIC.length,n=bytes.readUInt32BE(offset),manifest=JSON.parse(bytes.subarray(offset+4,offset+4+n));assert.doesNotMatch(JSON.stringify(manifest),/search-v1|coverage-v1|local-inventory/);
 const other=fixture();try{const plan=await X.inspect(other.base,actual);await X.commit(other.base,plan.id);const result=await query(other.base);assert.equal(result.rows.filter(r=>r.id==='50'&&r.type==='comment').length,1);assert.equal(result.credits,0);}finally{other.close();}
}));
test('symlinked sources cannot silently escape the workspace whitelist or produce an apparently complete index',()=>run(async f=>{
 const file=f.cache(f.dir,'sent',[f.row('50')]),outside=save(path.join(f.base,'outside.json'),{comments:[f.row('60','SECRET_MARKER')]});fs.symlinkSync(outside,path.join(f.dir,'cache/sent_c1_m60.json'));await assert.rejects(query(f.base,'SECRET_MARKER'),/普通文件|符号/);assert.ok(fs.existsSync(file));assert.equal(fs.readFileSync(outside,'utf8').includes('SECRET_MARKER'),true);
}));
test('large cross-owner association output fails safely before native transport limits; owner filtering still queries all selected data',()=>run(async f=>{
 const registry={schema:1,users:{}};for(let n=0;n<150;n++){const id=String(2222000000+n),dir=path.join(f.base,'data/user-comments',id);f.cache(dir,'received',Array.from({length:40},(_,i)=>f.row(String(i+1000))));registry.users[id]={uid:id,nickname:'合成'+id,note:'关联说明'.repeat(50)};}save(path.join(f.base,'data/.reader/users.json'),registry);const worker=require('../desktop/local-insights').create(f.base);try{await assert.rejects(worker.request('search',{text:'关键词'}),/关联.*过多/);const result=await worker.request('search',{text:'关键词',owner:'user-comments:2222000000'});assert.equal(result.total,40);assert.equal(result.rows[0].sources.length,1);}finally{worker.close();}
}));

test('cancelled queries release their retained worker/result after the bounded idle period',()=>run(async f=>{
 f.cache(f.dir,'sent',[f.row('50')]);const worker=require('../desktop/local-insights').create(f.base,{idleMs:20});try{const result=await worker.request('search',{text:'关键词'});worker.cancel();await new Promise(resolve=>setTimeout(resolve,70));await assert.rejects(worker.request('page',{}, {snapshot:result.snapshot}),/失效|变化/);assert.equal((await worker.request('search',{text:'关键词'})).total,1);}finally{worker.close();}
}));

test('general keyword search excludes UIDs and generated UID names; author UID is an explicit exact filter',()=>run(async f=>{
 const author='2100964925',r=f.row('5298853008114818','她嘴巴好像小猪',author);r.user.screen_name='holoop1214';f.cache(f.dir,'received',[r]);
 assert.equal((await query(f.base,'1009')).total,0);
 assert.equal((await query(f.base,'小猪',{author})).total,1);
 assert.equal((await query(f.base,'小猪',{author:'1009'})).total,0,'partial author UID is not a nickname');
 const fallback=f.row('5298853008114819','普通正文',author);fallback.user.screen_name='用户 '+author;f.cache(f.dir,'received',[fallback],'c1_m2');
 assert.equal((await query(f.base,'1009')).total,0,'generated user placeholder is not searchable name');
 assert.equal((await query(f.base,uid.slice(1,6))).total,0,'owner fallback UID is excluded');
 const real=f.row('5298853008114820','正文确实包含1009',author);real.user.screen_name='holoop1214';f.cache(f.dir,'received',[real],'c1_m3');
 const x=await query(f.base,'1009');assert.deepEqual(x.rows.map(r=>r.id),[real.idstr]);
}));
test('global search conversation exports reuse unchanged output and share the one-report owner retention',()=>run(async f=>{
 const rows=Array.from({length:6},(_,i)=>({...f.row(String(7100+i),'保留测试 '+i),status:{idstr:String(8800000000+i),text:'原帖 '+i,user:{idstr:peer,screen_name:'作者'}}}));f.cache(f.dir,'sent',rows);
 const raw=fs.readFileSync(path.join(f.dir,'cache/sent_c200_m0.json')),events=[],bridge=require('../desktop/bridge').runBridge({workspace:f.base,send:e=>events.push(e),followService:{snapshot:()=>({entries:[]}),close(){},release(){},finish(){}},spawn:()=>{throw Error('不允许联网');}});
 try{
  await bridge.handle({action:'globalSearch',workspace:f.base,requestId:'query',query:{text:'保留测试'}});const result=events.find(e=>e.type==='globalSearch');assert.equal(result.total,6);
  let last;for(const hit of result.rows){await bridge.handle({action:'globalSearch',workspace:f.base,requestId:'query-'+hit.id,query:{text:'保留测试'}});const fresh=events.filter(e=>e.type==='globalSearch').at(-1);await bridge.handle({action:'searchOpen',workspace:f.base,requestId:'open-'+hit.id,snapshot:fresh.snapshot,key:hit.key});last=events.filter(e=>e.type==='searchOpened').at(-1);assert.equal(last?.files.length,1);assert.ok(fs.existsSync(path.join(f.base,'output',last.files[0])));assert.equal(last.warning,'');}
  // Enumerate generated HTML only, keeping data/snapshots outside retention.
  const htmls=()=>fs.readdirSync(path.dirname(path.join(f.base,'output',last.files[0]))).filter(n=>n.endsWith('.html')).sort();
  await new Promise(resolve=>setTimeout(resolve,250));assert.equal(htmls().length,6,'pending native handoffs stay protected');for(const e of events.filter(e=>e.type==='open'&&e.handoffTicket))await bridge.handle({action:'reportHandoff',workspace:f.base,token:e.handoffTicket,success:true,requestId:e.handoffTicket});await new Promise(resolve=>setTimeout(resolve,250));assert.equal(htmls().length,1);const before=htmls();const hit=result.rows.at(-1);await bridge.handle({action:'globalSearch',workspace:f.base,requestId:'re-query',query:{text:'保留测试'}});await bridge.handle({action:'searchOpen',workspace:f.base,requestId:'again',snapshot:events.filter(e=>e.type==='globalSearch').at(-1).snapshot,key:hit.key});assert.deepEqual(htmls(),before);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'cache/sent_c200_m0.json')),raw);assert.equal(events.some(e=>e.type==='insightsError'),false);
 }finally{await bridge.handle({action:'insightsCancel',workspace:f.base});bridge.stop();}
}));

test('sparse hits retain earlier nonmatching versions and origins without borrowing an equal numeric post identity',()=>run(async f=>{
 const id='90071992547409939';f.cache(f.dir,'sent',[f.row(id,'原版本没有检索词')]);f.cache(f.other,'received',[f.row(id,'稀有检索词 新版本')]);
 save(path.join(f.posts,'cache/user-posts_c1_m0.json'),{endpoint:'statuses user_timeline/other',query:{uid},response:{statuses:[f.row(id,'无匹配的微博版本')]}});
 const result=await query(f.base,'稀有检索词');assert.equal(result.total,1);const hit=result.rows[0];assert.equal(hit.type,'comment');assert.equal(hit.id,id);assert.equal(hit.versions,2);assert.equal(hit.allSources.length,2);assert.deepEqual(new Set(hit.allSources.map(s=>s.owner)),new Set(['user-comments:'+uid,'user-comments:'+peer]));assert.equal(hit.sources.length,1);assert.equal(hit.sources[0].owner,'user-comments:'+peer);assert.equal(hit.contextOnly,false);
 assert.equal((await query(f.base,'稀有检索词',{owner:'user-comments:'+uid})).total,0);
}));

test('search source parts retire only after stable complete commits; replacement/deletion keep current results and raw bytes',()=>run(async f=>{
 const source=f.cache(f.dir,'sent',[f.row('5000000000000001','关键词 version0')]),owner=C.objects(f.base).objects.find(o=>o.key==='user-comments:'+uid),name=S.indexFile(f.base,owner),parts=path.join(path.dirname(name),'parts',C.hash(owner.key));
 for(let n=0;n<3;n++){save(source,{comments:[f.row('5000000000000001','关键词 version'+n)]});assert.equal((await query(f.base)).rows[0].content,'关键词 version'+n);assert.equal(fs.readdirSync(parts).length,2,'only the current source meta/part remain');}
 const bytes=fs.readFileSync(source);await query(f.base);assert.deepEqual(fs.readFileSync(source),bytes);fs.unlinkSync(source);assert.equal((await query(f.base)).total,0);assert.deepEqual(fs.readdirSync(parts),[]);
}));
test('cancel, owner-manifest failure and another index lease preserve old parts until a later successful rebuild',()=>run(async f=>{
 const source=f.cache(f.dir,'sent',[f.row('5000000000000001','关键词 old')]);await query(f.base);const owner=C.objects(f.base).objects.find(o=>o.key==='user-comments:'+uid),name=S.indexFile(f.base,owner),parts=path.join(path.dirname(name),'parts',C.hash(owner.key)),old=fs.readdirSync(parts),indexBefore=fs.readFileSync(name),api=require('../lib/search-source-index'),metrics={sourceReads:0,indexReads:0,reusedSources:0,updatedSources:0},controller=new AbortController();save(source,{comments:[f.row('5000000000000001','关键词 new')]});
 await assert.rejects(api.scan(f.base,owner,{metrics,signal:controller.signal,onSource:()=>controller.abort()}));assert.deepEqual(fs.readFileSync(name),indexBefore);assert(old.every(n=>fs.existsSync(path.join(parts,n))));
 const P=require('../lib/update-progress'),atomic=P.atomic;P.atomic=(file,value)=>{if(file===name)throw Error('synthetic manifest write failed');return atomic(file,value);};try{const result=await query(f.base);assert.equal(result.total,1);assert.equal(result.state,'partial');assert(old.every(n=>fs.existsSync(path.join(parts,n))));}finally{P.atomic=atomic;}
 const before=fs.readdirSync(parts),lease=require('../lib/process-lease').acquire(name+'.lock');try{await assert.rejects(query(f.base),{code:'DATA_LOCK_BUSY'});assert.deepEqual(fs.readdirSync(parts),before);}finally{lease.release();}
 const result=await query(f.base);assert.equal(result.state,'ready');assert.equal(result.rows[0].content,'关键词 new');assert.equal(fs.readdirSync(parts).length,2);
}));

test('obsolete-part cleanup yields to cancellation and an invalid empty owner manifest is committed afresh',()=>run(async f=>{
 const source=f.cache(f.dir,'sent',[f.row('5000000000000001')]);await query(f.base);const owner=C.objects(f.base).objects.find(o=>o.key==='user-comments:'+uid),name=S.indexFile(f.base,owner),parts=path.join(path.dirname(name),'parts',C.hash(owner.key)),controller=new AbortController(),read=fs.readdirSync;for(let i=0;i<1500;i++)fs.writeFileSync(path.join(parts,'f'.repeat(64)+'.'+i+'.json'),'{}');let requested=false;fs.readdirSync=function(folder,...args){const out=read.call(this,folder,...args);if(folder===parts&&!requested){requested=true;setImmediate(()=>controller.abort());}return out;};try{await assert.rejects(require('../lib/search-source-index').scan(f.base,owner,{signal:controller.signal,metrics:{sourceReads:0,indexReads:0,reusedSources:0,updatedSources:0}}));}finally{fs.readdirSync=read;}assert(requested);assert(fs.readdirSync(parts).some(n=>n.startsWith('f'.repeat(64))), 'cancel leaves unprocessed obsolete parts');assert.equal((await query(f.base)).total,1);assert.equal(fs.readdirSync(parts).length,2);
 fs.unlinkSync(source);fs.writeFileSync(name,'{broken');assert.equal((await query(f.base)).total,0);const box=JSON.parse(fs.readFileSync(name));assert.equal(box.version,require('../lib/search-source-index').VERSION);assert.deepEqual(box.files,{});assert.deepEqual(fs.readdirSync(parts),[]);
}));

test('real local worker keeps timeline, search pages and exact search-open resolution scoped when requests overlap',()=>run(async f=>{
 f.cache(f.dir,'sent',Array.from({length:45},(_,i)=>f.row(String(90071992547409000n+BigInt(i)))));
 const worker=require('../desktop/local-insights').create(f.base);
 try{
  const [search,timeline]=await Promise.all([worker.request('search',{text:'关键词'}),worker.request('timeline',{uid})]);
  assert.equal(search.total,45);assert.equal(timeline.uid,uid);
  const [page,resolve]=await Promise.all([worker.request('page',{}, {snapshot:search.snapshot,page:1}),worker.request('resolve',{}, {snapshot:search.snapshot,key:search.rows[0].key,owner:'user-comments:'+uid})]);
  assert.equal(page.rows.length,5);assert.equal(resolve.selection.recordId,search.rows[0].id);
  const cancelled=worker.request('search',{text:'关键词'}),timelinePending=worker.request('timeline',{uid});worker.cancel('search');
  await assert.rejects(cancelled,{cancelled:true});assert.equal((await timelinePending).uid,uid);
  const timelineCancelled=worker.request('timeline',{uid}),again=worker.request('search',{text:'关键词'});worker.cancel('timeline');
  await assert.rejects(timelineCancelled,{cancelled:true});assert.equal((await again).total,45);
 }finally{worker.close();}
}));

test('large compressed search parts survive a restart and rebuild from original bytes on corruption', () => run(async f => {
 const rows = Array.from({length:100}, (_, i) => f.row(String(5001+i), '关键词 ' + '重复正文'.repeat(80)));
 const source = f.cache(f.dir, 'sent', rows), original = fs.readFileSync(source);
 const owner = C.objects(f.base).objects.find(o => o.key === 'user-comments:' + uid);
 const meta = S.indexFile(f.base, owner), views = require('../lib/file-view-cache');
 assert.equal((await query(f.base)).total, rows.length);
 const part = Object.values(JSON.parse(fs.readFileSync(meta)).files)[0].parts[0];
 assert.match(part.name, /\.json\.gz$/);
 const name = path.join(path.dirname(meta), 'parts', C.hash(owner.key), part.name);
 const packed = fs.readFileSync(name);
 assert(packed.length < require('node:zlib').gunzipSync(packed).length / 2);
 views.clear();
 const reads = S.metrics.sourceReads;
 assert.equal((await query(f.base)).total, rows.length);
 assert.equal(S.metrics.sourceReads, reads);
 fs.writeFileSync(name, Buffer.from('corrupt'));
 const rebuilt = await query(f.base);
 assert.equal(rebuilt.state, 'ready');
 assert.equal(rebuilt.total, rows.length);
 assert(S.metrics.sourceReads > reads);
 assert.deepEqual(fs.readFileSync(source), original);
}));

test('legacy large search parts compact from validated local index rows without rereading original responses', () => run(async f => {
 const source = f.cache(f.dir, 'sent', [f.row('70001', '关键词 ' + '长正文'.repeat(3500))]);
 const owner = C.objects(f.base).objects.find(o => o.key === 'user-comments:' + uid);
 const name = S.indexFile(f.base, owner), folder = path.join(path.dirname(name), 'parts', C.hash(owner.key));
 assert.equal((await query(f.base)).total, 1);
 const manifest = JSON.parse(fs.readFileSync(name)), [meta] = Object.values(manifest.files);
 const [part] = meta.parts, packed = path.join(folder, part.name), plain = packed.slice(0, -3);
 fs.writeFileSync(plain, require('node:zlib').gunzipSync(fs.readFileSync(packed)));
 fs.unlinkSync(packed);
 part.name = path.basename(plain);
 delete meta.compact;
 manifest.hash = C.hash(manifest.files);
 save(name, manifest);
 const fallback = path.join(folder, part.name.replace(/\.0\.json$/, '.index.json'));
 const sourceMeta = JSON.parse(fs.readFileSync(fallback));
 save(fallback, {...sourceMeta, value:meta, hash:C.hash(meta)});
 const reads = S.metrics.sourceReads, bytes = fs.readFileSync(source);
 assert.equal((await query(f.base)).total, 1);
 assert.equal(S.metrics.sourceReads, reads);
 assert(fs.existsSync(packed));
 assert(!fs.existsSync(plain));
 assert.deepEqual(fs.readFileSync(source), bytes);
 assert.equal(JSON.parse(fs.readFileSync(fallback)).value.parts[0].name, path.basename(packed));
}));
