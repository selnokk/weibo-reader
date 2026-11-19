const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createLocalView}=require('../desktop/local-view'),{jsonPayload}=require('../lib/report-records');
const uid='1234567890',peer='9876543210';
function fixture(fn){const base=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-local-view-')),dir=path.join(base,'data/user-comments/目标');fs.mkdirSync(path.join(dir,'cache'),{recursive:true});fs.writeFileSync(path.join(base,'data/.layout-v2'),'2');fs.writeFileSync(path.join(base,'data/user-comments/.account_names.json'),JSON.stringify({[uid]:{folder:'目标',nickname:'目标'}}));const row=(id,time,author=uid,reply='')=>({idstr:String(id),created_at:time,text:'独立正文 '+id,user:{idstr:author,screen_name:author===uid?'目标':'对方'},reply_comment:reply?{idstr:reply,text:'引用前文',created_at:'2026-10-27T12:00:00+08:00',user:{idstr:peer,screen_name:'对方'}}:undefined,reply_id:reply,status:{idstr:'8888888888',text:'原微博',user:{idstr:peer,screen_name:'对方'}}});
 const sent=[row(50,'2026-10-29T12:00:00+08:00',uid,'40'),row(51,'2026-10-01T12:00:00+08:00')],received=[row(60,'2026-10-29T13:00:00+08:00',peer),row(61,'2026-10-28T12:00:00+08:00',peer),row(40,'2026-10-27T12:00:00+08:00',peer)];
 for(const [kind,rows]of [['sent',sent],['received',received]])fs.writeFileSync(path.join(dir,`cache/${kind}_c100_m0.json`),JSON.stringify({comments:rows}));const inbox=path.join(dir,'cache/follow-inbox.json');fs.writeFileSync(inbox,JSON.stringify({schema:1,uid,items:{'50':{id:'50',ms:1,readAt:null},'60':{id:'60',ms:2,readAt:null},'61':{id:'61',ms:3,readAt:'2026-10-29T00:00:00Z'}}}));
 try{return fn({base,dir,inbox,row,sent,received,service:createLocalView(base),q:{target:uid,mode:'comments-both',limit:'2',markUnread:true}});}finally{fs.rmSync(base,{recursive:true,force:true});}}
const formal=html=>JSON.parse(html.match(/<script type="application\/json" id="weibo-report-records">([\s\S]*?)<\/script>/)[1]);
test('local latest-N merges directions and orders by event time, never newly saved file time',()=>fixture(({base,dir,service,q})=>{
 const old=path.join(dir,'cache/sent_c100_m0.json');fs.utimesSync(old,new Date(Date.now()+10000),new Date(Date.now()+10000));const v=service.prepare(q);assert.equal(v.summary.matched,5);assert.equal(v.summary.selected,2);assert.equal(v.summary.sent,1);assert.equal(v.summary.received,1);assert.deepEqual(v.jobs[0].rows.map(r=>r.recordId),['60','50']);assert.equal(fs.existsSync(path.join(base,'output')),false);
}));
test('local direct view and identical preview/export retain exact formal rows, parents and unread flags without read receipts',()=>fixture(({base,inbox,service,q})=>{
 const bytes=fs.readFileSync(inbox),v=service.prepare(q),html=service.render(v)[0],payload=formal(html);assert.deepEqual(payload.rows.map(r=>r.recordId),['60','50']);assert.ok(payload.rows.every(r=>r.isUnread));assert.ok(payload.context.some(r=>r.recordId==='40'&&r.isContext));assert.equal(v.summary.unread,2);assert.equal(fs.existsSync(path.join(base,'output')),false,'view and preview never require an HTML file');
 const before=service.stats(),exported=service.exportCurrent(q,v.token),file=path.join(base,'output',exported.files[0]);assert.equal(fs.readFileSync(file,'utf8'),html);assert.deepEqual(service.stats(),before);assert.deepEqual(fs.readFileSync(inbox),bytes);assert.equal(exported.summary.selected,2);
}));
test('unread toggle changes only visuals; read records and context remain and no inbox is initialized by untracked viewing',()=>fixture(({base,dir,inbox,service,q})=>{
 const before=fs.readFileSync(inbox),a=service.prepare({...q,limit:'4'}),b=service.prepare({...q,limit:'4',markUnread:false});assert.deepEqual(a.jobs[0].rows.map(r=>r.recordId),b.jobs[0].rows.map(r=>r.recordId));assert.ok(a.jobs[0].rows.some(r=>!r.isUnread));assert.equal(formal(service.render(b)[0]).rows.some(r=>r.isUnread),false);assert.deepEqual(fs.readFileSync(inbox),before);fs.unlinkSync(inbox);const fresh=createLocalView(base);fresh.render(fresh.prepare(q));assert.equal(fs.existsSync(inbox),false);
}));
test('date range latest-N and all stay within inclusive Beijing days; empty filter returns zero without paid work',()=>fixture(({base,service,q})=>{
 const a=service.prepare({...q,from:'2026-10-01',to:'2026-10-28',unlimited:true});assert.deepEqual(a.jobs[0].rows.map(r=>r.recordId),['61','40','51']);assert.equal(a.summary.matched,3);assert.equal(a.summary.selected,3);const b=service.prepare({...q,from:'2026-10-01',to:'2026-10-28'});assert.deepEqual(b.jobs[0].rows.map(r=>r.recordId),['61','40']);const c=service.prepare({...q,from:'2025-01-01',to:'2025-01-01'});assert.equal(c.summary.selected,0);assert.equal(c.summary.matched,0);assert.deepEqual(service.exportCurrent({...q,from:'2025-01-01',to:'2025-01-01'},c.token).files,[]);assert.equal(fs.existsSync(path.join(base,'output')),false);
}));
test('local data changes invalidate cached counts and previews; stale snapshot exports do not silently change selection',()=>fixture(({dir,row,service,q})=>{
 const a=service.prepare(q);service.render(a);fs.writeFileSync(path.join(dir,'cache/sent_c1_m100.json'),JSON.stringify({comments:[row(100,'2026-10-29T14:00:00+08:00')]}));const b=service.prepare(q);assert.notEqual(a.token,b.token);assert.equal(b.jobs[0].rows[0].recordId,'100');assert.throws(()=>service.exportCurrent(q,a.token),/已变化/);assert.equal(service.stats().parses,2);
}));
test('duplicate independent records count once while keeping both source directions; quote-only rows never become formal',()=>fixture(({dir,row,service,q})=>{
 const own=row(50,'2026-10-29T12:00:00+08:00',uid,'40');fs.writeFileSync(path.join(dir,'cache/received_c1_m50.json'),JSON.stringify({comments:[own]}));fs.writeFileSync(path.join(dir,'cache/sent_c1_m52.json'),JSON.stringify({comments:[{idstr:'52',created_at:'2026-10-29T12:30:00+08:00',reply_comment:row(51,'2026-10-01T12:00:00+08:00'),user:{idstr:uid}}]}));const v=service.prepare({...q,unlimited:true}),rows=v.jobs[0].rows;assert.equal(rows.filter(r=>r.recordId==='50').length,1);assert.deepEqual(rows.find(r=>r.recordId==='50').directions.sort(),['received','sent']);assert.equal(rows.some(r=>r.recordId==='52'),false);
}));

test('all unread outside the latest N survive previews and failed exports; counts distinguish selected and total unread',()=>fixture(({dir,inbox,service,q})=>{
 const box=JSON.parse(fs.readFileSync(inbox));box.items['51']={id:'51',ms:1,readAt:null};fs.writeFileSync(inbox,JSON.stringify(box));const before=fs.readFileSync(inbox),v=service.prepare(q);assert.equal(v.summary.totalUnread,3);assert.equal(v.summary.unread,2);service.render(v);const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(String(file).endsWith('.html')&&args[1]?.flag==='wx')throw Object.assign(Error('模拟导出提交失败'),{code:'EACCES'});return write.call(this,file,...args);};try{assert.throws(()=>service.exportCurrent(q,v.token),/提交失败/);}finally{fs.writeFileSync=write;}assert.deepEqual(fs.readFileSync(inbox),before);assert.equal(box.items['51'].readAt,null);const out=path.join(path.dirname(path.dirname(path.dirname(dir))),'output');if(fs.existsSync(out))for(const folder of fs.readdirSync(out))assert.ok(!folder.endsWith('.tmp'));
}));

test('unchanged report is reused after cache snapshot writes and app restart; changed rows or filters generate a new report',()=>fixture(({base,dir,inbox,row,service,q})=>{const before=fs.readFileSync(inbox),a=service.exportCurrent(q);assert.equal(a.reused,false);const original=path.join(base,'output',a.files[0]),mtime=fs.statSync(original).mtimeMs;const again=createLocalView(base),b=again.exportCurrent(q);assert.equal(b.reused,true);assert.deepEqual(b.files,a.files);assert.equal(again.stats().renders,0,'reuse must avoid rendering the report again');assert.equal(fs.statSync(original).mtimeMs,mtime);const changed=again.exportCurrent({...q,limit:'3'});assert.notDeepEqual(changed.files,a.files);fs.writeFileSync(path.join(dir,'cache/sent_c1_m100.json'),JSON.stringify({comments:[row(100,'2026-10-29T14:00:00+08:00')]}));const fresh=again.exportCurrent(q);assert.notDeepEqual(fresh.files,a.files);assert.equal(fresh.reused,false);assert.deepEqual(fs.readFileSync(inbox),before);}));
test('reuse verifies saved HTML bytes; a changed file is regenerated rather than silently reused',()=>fixture(({base,service,q})=>{const a=service.exportCurrent(q);fs.appendFileSync(path.join(base,'output',a.files[0]),'tampered');const next=createLocalView(base).exportCurrent(q);assert.equal(next.reused,false);assert.ok(!fs.readFileSync(path.join(base,'output',next.files[0]),'utf8').endsWith('tampered'));}));
test('one-report ownership retention shares quota across directions, keeps each other user independent and preserves raw data',()=>fixture(({base,dir,inbox,service,q})=>{const library=require('../desktop/library'),rawFiles=fs.readdirSync(path.join(dir,'cache')).filter(n=>n.endsWith('.json')).map(n=>[n,fs.readFileSync(path.join(dir,'cache',n))]),out=[];for(const params of [{mode:'comments-sent',limit:'1'},{mode:'comments-received',limit:'1'},{limit:'2'},{limit:'3'},{limit:'4'}]){const exported=service.exportCurrent({...q,...params});out.push(...exported.files);library.cleanupOwnerReports(base,exported.files);}const reports=library.listReports(base).filter(r=>r.uid===uid);assert.equal(reports.length,1);assert.ok(reports.every(r=>out.slice(-1).includes(r.id)));for(const [n,bytes]of rawFiles)assert.deepEqual(fs.readFileSync(path.join(dir,'cache',n)),bytes);assert.ok(fs.existsSync(inbox));assert.equal(service.prepare({...q,unlimited:true}).summary.selected,5,'clearing HTML must not clear bodies');const other=path.join(base,'output/user-comments/other');fs.mkdirSync(other,{recursive:true});for(let n=0;n<3;n++)fs.writeFileSync(path.join(other,'manual-'+n+'.html'),'unrecognized');const final=service.exportCurrent({...q,limit:'5'});library.cleanupOwnerReports(base,final.files);assert.equal(fs.readdirSync(other).length,3,'other directories are outside the focus');assert.equal(library.listReports(base).filter(r=>r.uid===uid).length,1);}));

test('exporting an older selection writes a current report instead of returning a file that retention will delete',()=>fixture(({base,service,q})=>{const outputs=[];for(const limit of ['1','2','3','4'])outputs.push(service.exportCurrent({...q,limit}).files[0]);const lib=require('../desktop/library'),protectedId=service.exportCurrent({...q,limit:'1'}).files[0];assert.notEqual(protectedId,outputs[0]);lib.cleanupOwnerReports(base,[protectedId]);const reports=lib.listReports(base).filter(r=>r.uid===uid);assert.equal(reports.length,1);assert.ok(reports.some(r=>r.id===protectedId));}));

test('saving an empty response changes cache files but not the selected report snapshot or reuse identity',()=>fixture(({dir,service,q})=>{const a=service.prepare(q);fs.writeFileSync(path.join(dir,'cache/sent_c1_m999.json'),JSON.stringify({comments:[],next_cursor:'0'}));const b=service.prepare(q);assert.notEqual(a.signature,b.signature);assert.equal(a.token,b.token);assert.doesNotThrow(()=>service.exportCurrent(q,a.token));}));

test('read-state changes refresh counts and HTML flags without reparsing the unchanged content archive',()=>fixture(({base,inbox:inboxFile,service,q})=>{
 const a=service.prepare(q);assert.equal(a.summary.unread,2);assert.equal(service.stats().parses,1);require('../lib/follow-inbox').markRead(base,uid,['60']);const b=service.prepare(q);assert.equal(b.summary.unread,1);assert.equal(b.summary.totalUnread,1);assert.notEqual(a.token,b.token);assert.equal(service.stats().parses,1);assert.equal(b.jobs[0].rows.find(r=>r.recordId==='60').isUnread,false);const off=service.prepare({...q,markUnread:false});assert.equal(off.summary.unread,1);assert.ok(off.jobs[0].rows.every(r=>!r.isUnread));assert.equal(service.stats().parses,1);
}));
test('local counts and export recover a saved response whose completion/ingest never ran, and quotes remain uncounted',()=>fixture(({base,dir,inbox:inboxFile,row,service,q})=>{
 const box=JSON.parse(fs.readFileSync(inboxFile));box.initializedAt='2026-10-28T00:00:00Z';box.items['40']={id:'40',readAt:null};fs.writeFileSync(inboxFile,JSON.stringify(box));const response={schema:1,query:{uid,kind:'received'},savedAt:'2026-10-29T06:00:00Z',firstSavedIds:['70'],response:{comments:[row(70,'2026-10-29T14:00:00+08:00',peer,'40')]}};const file=path.join(dir,'cache/request-journal','12345678-1234-1234-1234-123456789abc.response.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(response));const v=service.prepare({...q,limit:'1'});assert.equal(v.summary.unread,1);assert.equal(v.jobs[0].rows[0].recordId,'70');assert.equal(v.jobs[0].rows[0].isUnread,true);const p=formal(service.render(v)[0]);assert.equal(p.rows.length,1);assert.ok(p.context.some(r=>r.recordId==='40'));assert.ok(p.context.every(r=>!r.isUnread));const before=fs.readFileSync(inboxFile);service.exportCurrent({...q,limit:'1'},v.token);assert.deepEqual(fs.readFileSync(inboxFile),before);
}));

test('a limited report counts every row within both date boundaries and keeps exact ID order on ties', () =>
 fixture(({dir, row, service, q}) => {
  const start = '2026-11-02T00:00:00.000+08:00', end = '2026-11-02T23:59:59.999+08:00';
  const sent = [
   row('90071992547409931', start),
   row('90071992547409932', end),
   row('90071992547409935', '2026-11-01T23:59:59.999+08:00'),
  ];
  const received = [
   row('90071992547409933', end, peer),
   row('90071992547409934', '2026-11-03T00:00:00.000+08:00', peer),
  ];
  for (const [kind, comments] of [['sent', sent], ['received', received]]) {
   fs.writeFileSync(path.join(dir, 'cache', kind + '_c3_m5.json'), JSON.stringify({comments}));
  }
  const selected = service.prepare({...q, from:'2026-11-02', to:'2026-11-02', limit:'2'});
  assert.equal(selected.summary.matched, 3);
  assert.deepEqual(selected.jobs[0].rows.map(r => r.recordId), ['90071992547409933', '90071992547409932']);
 }));

test('a pending request leaves the report ready until its saved response supplies new rows', () =>
 fixture(({dir, row, service, q}) => {
  const journal = path.join(dir, 'cache/request-journal');
  fs.mkdirSync(journal, {recursive:true});
  const request = path.join(journal, '12345678-1234-1234-1234-123456789012');
  const previous = service.prepare(q);
  fs.writeFileSync(request + '.request.json', JSON.stringify({query:{uid, kind:'sent'}}));
  assert.strictEqual(service.prepare(q), previous);
  fs.writeFileSync(request + '.response.json', JSON.stringify({
   schema:1, query:{uid,kind:'sent'}, savedAt:'2026-10-31T00:00:00Z',
   response:{comments:[row('501','2026-10-30T06:00:00Z')]},
  }));
  const updated = service.prepare(q);
  assert.notEqual(updated.token, previous.token);
  assert.equal(updated.jobs[0].rows[0].recordId, '501');
 }));
