'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const B=require('../lib/auto-follow-budget'),J=require('../lib/request-journal'),I=require('../lib/incremental'),R=require('../desktop/subscription-recovery'),C=require('../lib/subscription-continuous');
const {uid,row,command,withEngine,save}=require('./subscription-fixture.cjs');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8')),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const denial=JSON.stringify({success:false,error:{code:'IP_GEO_DENIED',message:'Synthetic rejected condition'}});
function baseline(f,kind,head){const id=crypto.randomUUID(),q={uid,kind,count:1,maxId:'',sinceId:'',page:1,taskId:id},a=J.begin(f.dir,q),raw={comments:[row(Number(head),kind)],next_cursor_str:'0'};J.receive(a,JSON.stringify(raw),'');const receipt=J.save(a,raw,''),ref={...receipt,file:path.relative(f.dir,receipt.file),count:1,maxId:'',sinceId:''},proof={schema:1,id,uid,kind,upper:head,lower:'',initial:true,packets:[ref],scopes:[id]},file=path.join(f.dir,'cache/update-connections',id+'.json');save(file,proof);save(I.stateFile(f.dir,kind),{schema:1,uid,kind,anchor:head,checkedAt:new Date(f.clock-1000).toISOString(),endPolicyVersion:2,origin:'data-update-v1',pending:null,connection:{file:path.relative(path.join(f.dir,'cache'),file),hash:sha(fs.readFileSync(file))}});}
function fixture(fn){const base=fs.mkdtempSync(path.join(os.tmpdir(),'reader-continuous-')),old=global.fetch;global.fetch=()=>assert.fail('REAL_NETWORK_FORBIDDEN');try{const service=withEngine(base,{sent:[row(100001)],received:[row(200001,'received')],balance:100000}),f={base,service,dir:service.dir,clock:Date.now()+10000};baseline(f,'sent','100000');baseline(f,'received','200000');f.e={uid,targetKind:'user',source:'cli',enabled:true,mode:'both',roundLimit:10,dailyBudget:3000,timeZone:'UTC'};save(path.join(B.directory(base),'settings.json'),{schema:1,entries:[f.e]});f.personal=path.join(base,'data/.reader/reading-fixture.json');save(f.personal,{unread:['100001'],read:['90000'],note:'KEEP'});return fn(f);}finally{global.fetch=old;fs.rmSync(base,{recursive:true,force:true});}}
function configure(f,changes){const cfg=read(f.service.conf);for(const[k,v]of Object.entries(changes))if(v===undefined)delete cfg[k];else cfg[k]=v;save(f.service.conf,cfg);}
function run(f,kinds=['sent','received'],extra={}){const checked=R.inspect(f.base,f.e,f.dir),id=crypto.randomUUID(),chosen=kinds.filter(k=>!checked.blockedKinds.includes(k)),plan=R.automaticRecovery(f.base,f.e,f.dir,checked,chosen,{now:()=>f.clock}),round={schema:1,id,...f.e,kinds:chosen,startedAt:new Date(f.clock).toISOString(),status:'running',requests:[],blockedKinds:checked.blockedKinds,unresolvedRanges:checked.unresolvedRanges,...(plan?{automaticRecovery:plan}:{}),...(chosen.length===1?{deferredKinds:['sent','received'].filter(k=>!chosen.includes(k))}:{}),...extra};save(B.roundFile(f.base,id),round);const out=f.service.run(round,{at:f.clock}),saved=read(B.roundFile(f.base,id));saved.status=out.status===0?'complete':'failed';saved.finishedAt=new Date(f.clock).toISOString();saved.worker={schema:1,pid:out.pid,pgid:out.pid,birth:'isolated-finished-generation',startedAt:round.startedAt,closedAt:saved.finishedAt};save(B.roundFile(f.base,id),saved);return {...out,round:saved,checked,plan};}
const diag=out=>JSON.stringify({status:out.status,stderr:out.stderr,summary:out.summary?.sources?.map(v=>({kind:v.kind,failed:v.failed,reason:v.reason,update:v.update}))});
function unknownBytes(f){const out={};for(const file of B.ledger(f.base).pendingFiles(uid,'user','cli')){const r=read(file);for(const q of r.requests)if(q.status==='unknown'){out[r.id+':'+q.id]={q:JSON.stringify(q),requests:J.subscriptionRequests(f.dir,r.id,q.id).map(file=>({file,bytes:fs.readFileSync(file).toString('base64'),rejection:read(file).rejection})).map(v=>({...v,...(v.rejection?{receipt:fs.readFileSync(path.join(J.folder(f.dir),v.rejection.file)).toString('base64')}: {})}))};}}return out;}
function assertOld(f,old){const now=unknownBytes(f);for(const[k,v]of Object.entries(old))assert.deepEqual(now[k],v,'old unknown evidence remains byte-for-byte unchanged');}

test('twenty complete service refusals use independent one-row windows across process restarts and a later normal response restores continuing reads',()=>fixture(f=>{configure(f,{fail:denial,failKind:'sent'});const personal=fs.readFileSync(f.personal),all=new Set();let first;
 for(let i=0;i<20;i++){const out=run(f,['sent']);assert.equal(out.round.requests.length,1,diag(out));assert.equal(out.round.requests[0].count,1);assert.equal(out.round.requests[0].status,'unknown');if(i){assert(out.plan);assert(out.round.requests[0].automaticRecovery);}const request=read(J.subscriptionRequests(f.dir,out.round.id,out.round.requests[0].id)[0]);assert(request.rejection);assert(!all.has(request.query.taskId),'each retry has its own real collector task');all.add(request.query.taskId);first??=unknownBytes(f);assertOld(f,first);f.clock+=900001;}
 // Five simulated hours can cross UTC midnight. Every old maximum remains
 // reserved, while only the current day's share occupies that day's budget.
 const old=unknownBytes(f),usage=B.usage(f.base,uid,B.localDay(f.clock,'UTC'));assert.equal(f.service.contentCalls().length,20);assert.equal(all.size,20);assert.equal(usage.reservedCredits+usage.historicalUnverifiedCredits,60);assert.equal(usage.unknownRequests,20);configure(f,{fail:undefined,sent:[row(100003),row(100002),row(100001)]});const success=run(f,['sent']);assert(success.summary.sources[0].update.protection.latestSucceeded,diag(success));assert.equal(I.readState(f.dir,'sent',uid).anchor,'100003');assert(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has('100002'));assertOld(f,old);const restored=B.usage(f.base,uid,B.localDay(f.clock,'UTC'));assert.equal(restored.reservedCredits+restored.historicalUnverifiedCredits,60);assert.equal(restored.unknownRequests,20);
 f.clock+=900001;configure(f,{sent:[row(100004),row(100003)]});const again=run(f,['sent']);assert.equal(again.status,0,diag(again));assert.equal(I.readState(f.dir,'sent',uid).anchor,'100004');assertOld(f,old);const retained=B.usage(f.base,uid,B.localDay(f.clock,'UTC'));assert.equal(retained.reservedCredits+retained.historicalUnverifiedCredits,60);assert.equal(retained.unknownRequests,20);assert(fs.readFileSync(f.personal).equals(personal));
}));

test('transport-unknown retries preserve every old reservation while an independent received direction keeps saving new records',()=>fixture(f=>{configure(f,{fail:'truncated {',failKind:'sent'});const personal=fs.readFileSync(f.personal);let old;
 for(let i=0;i<5;i++){configure(f,{received:[row(200001+i,'received')]});const out=run(f);assert(out.round.requests.some(q=>q.kind==='sent'&&q.status==='unknown'),diag(out));assert(out.round.requests.some(q=>q.kind==='received'&&q.returned===1),diag(out));assert.equal(I.readState(f.dir,'received',uid).anchor,String(200001+i));old??=unknownBytes(f);assertOld(f,old);f.clock+=900001;}
 const before=unknownBytes(f);configure(f,{fail:undefined,sent:[row(100002),row(100001)],received:[row(200006,'received')]});const out=run(f);assert(out.summary.sources.find(s=>s.kind==='sent').update.protection.latestSucceeded,diag(out));assert.equal(I.readState(f.dir,'sent',uid).anchor,'100002');assert.equal(I.readState(f.dir,'received',uid).anchor,'200006');assertOld(f,before);assert(fs.readFileSync(f.personal).equals(personal));
}));

test('a complete current response with unknown billing permits the actual next page without removing its maximum fee reservation',()=>fixture(f=>{configure(f,{fail:'unknown wire'});run(f,['sent']);const old=unknownBytes(f);configure(f,{fail:undefined,billing:{status:'unverified'},sent:[100005,100004,100003,100002,100001].map(id=>row(id))});f.clock+=900001;const before=f.service.contentCalls().length,out=run(f,['sent']);assert(f.service.contentCalls().length-before>=2,diag(out));assert(out.round.requests.length>=2,diag(out));assert(out.round.requests.every(q=>q.status==='unknown'&&Number.isSafeInteger(q.returned)&&q.hash&&q.automaticRecovery),diag(out));assert.equal(out.round.requests.reduce((n,q)=>n+q.returned,0),5);assert.equal(I.readState(f.dir,'sent',uid).anchor,'100005',diag(out));const usage=B.usage(f.base,uid,B.localDay(f.clock,'UTC'));assert.equal(usage.reservedCredits+usage.historicalUnverifiedCredits,out.round.requests.reduce((n,q)=>n+q.reservedCredits,3));assertOld(f,old);
}));

function oldMissingRequest(f){
 configure(f,{fail:'unknown wire'});
 const failed=run(f,['sent']).round,prior=failed.requests[0];
 // Reproduce an old ended reservation whose request file never reached disk.
 fs.unlinkSync(J.subscriptionRequests(f.dir,failed.id,prior.id)[0]);
 assert.equal(C.fact(f.base,f.dir,failed,prior)?.missingRequest?.lower,'100000');
 return unknownBytes(f);
}
test('a saved leading record does not invalidate its own continuation after a missing old request',()=>fixture(f=>{
 const old=oldMissingRequest(f);
 f.clock+=900001;
 configure(f,{fail:undefined,sent:[100003,100002,100001].map(id=>row(id))});
 const before=f.service.contentCalls().length,out=run(f,['sent']);
 assert.equal(out.status,0,diag(out));
 assert.equal(f.service.contentCalls().length-before,2);
 assert.deepEqual(out.round.requests.map(q=>[q.sinceId,q.maxId,q.returned,q.estimatedCredits]),[
  ['100000','',1,3],['100000','100002',2,6],
 ]);
 const archive=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records;
 for(const id of ['100001','100002','100003'])assert.equal(archive.get(id).row.content,'独立评论 '+id);
 assert.equal(I.readState(f.dir,'sent',uid).anchor,'100003');
 f.clock+=900001;
 const quiet=run(f,['sent']);
 assert.equal(quiet.status,0,diag(quiet));
 assert.deepEqual(quiet.round.requests.map(q=>[q.sinceId,q.maxId,q.count,q.returned,q.estimatedCredits]),[['100003','',1,0,0]]);
 assertOld(f,old);
}));

for(const status of ['estimated','unknown'])test('an authorless empty sent row with '+status+' fees permits its bounded next page without certifying a head',()=>fixture(f=>{
 const old=oldMissingRequest(f),placeholder={idstr:'100003'};
 configure(f,{fail:undefined,billing:status==='unknown'?{status:'unverified'}:undefined,sent:[placeholder,row(100002),row(100001)]});
 f.clock+=900001;
 const before=f.service.contentCalls().length,out=run(f,['sent']);
 const requests=out.round.requests;
 assert.deepEqual(requests.map(q=>[q.sinceId,q.maxId,q.returned]),[['100000','',1],['100000','100002',2]],diag(out));
 assert.equal(f.service.contentCalls().length-before,2);
 assert(requests.every(q=>q.status===status&&q.automaticRecovery&&R.complete(q)));
 assert.equal(I.readState(f.dir,'sent',uid).anchor,'100000');
 const archive=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records;
 assert(!archive.has(placeholder.idstr));
 assert(archive.has('100002')&&archive.has('100001'));
 const usage=B.usage(f.base,uid,B.localDay(f.clock,'UTC'));
 assert.equal(usage.reservedCredits+usage.historicalUnverifiedCredits,status==='unknown'?requests.reduce((n,q)=>n+q.reservedCredits,3):3);
 assert.equal(requests.reduce((n,q)=>n+q.estimatedCredits,0),9);
 assertOld(f,old);
 assert.throws(()=>R.verifyComplete(f.base,f.dir,out.round,requests[0]),/原响应身份/);
 const ledgerFile=B.roundFile(f.base,out.round.id),ledgerBytes=fs.readFileSync(ledgerFile);
 if(status==='unknown'){
  const inspect=()=>R.inspect(f.base,f.e,f.dir).blockedKinds;
  assert(!inspect().includes('sent'));
  const altered=read(ledgerFile);
  altered.requests[0].automaticRecovery.taskId=crypto.randomUUID();
  save(ledgerFile,altered);
  try{assert(inspect().includes('sent'));}finally{fs.writeFileSync(ledgerFile,ledgerBytes);}
  const windowFile=I.stateFile(f.dir,'sent',out.round.id),windowBytes=fs.readFileSync(windowFile),window=read(windowFile);
  for(const chain of [window.pending,window.unverifiedObservation])if(chain)chain.packets=chain.packets.map(p=>({...p,hash:'0'.repeat(64)}));
  save(windowFile,window);
  try{assert(inspect().includes('sent'));}finally{fs.writeFileSync(windowFile,windowBytes);}
 }
 f.clock+=900001;
 configure(f,{billing:undefined,sent:[row(100004)]});
 const nextStart=f.service.contentCalls().length,next=run(f,['sent']);
 assert.equal(next.status,0,diag(next));
 assert.deepEqual(next.round.requests.map(q=>[q.count,q.maxId,q.returned,q.estimatedCredits]),[[1,'',1,3],[1,'100003',0,0]]);
 assert.equal(f.service.contentCalls().length-nextStart,2);
 assert.equal(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.get('100004').row.content,'独立评论 100004');
 assert.deepEqual(fs.readFileSync(ledgerFile),ledgerBytes);
 const remaining=B.usage(f.base,uid,B.localDay(f.clock,'UTC'));
 assert.equal(remaining.reservedCredits+remaining.historicalUnverifiedCredits,usage.reservedCredits+usage.historicalUnverifiedCredits);
}));

test('a current sent receipt cannot accept an unidentified author for a body, media, or conflicting IDs',()=>fixture(f=>{
 const roundId=crypto.randomUUID(),round={id:roundId,uid,status:'running'};
 const query={uid,kind:'sent',page:1,count:1,maxId:'100003',sinceId:'100000'};
 function verify(item,overrides={}){
  const id=crypto.randomUUID(),raw={comments:[item]},attempt=J.begin(f.dir,{...query,taskId:crypto.randomUUID()},{id,roundId});
  const received=J.receive(attempt,JSON.stringify(raw),'');
  J.save(attempt,raw,'');
  const request={...query,id,status:'unknown',returned:1,file:received.file,hash:received.hash};
  return R.verifyComplete(f.base,f.dir,round,request,{currentRoundId:roundId,...overrides});
 }
 const blank={idstr:'100003'};
 assert.equal(verify(blank),true);
 for(const item of [
  {...blank,text:'独立正文'},
  {...blank,pics:[{url:'https://wx1.sinaimg.cn/large/image.jpg'}]},
  {...blank,user:{idstr:'1234567891'}},
  {...blank,user:{idstr:uid,id:'1234567891'}},
  {idstr:'100000'},{idstr:'100004'},
 ])assert.throws(()=>verify(item),/原响应身份或返回范围/);
 assert.throws(()=>verify(blank,{currentRoundId:crypto.randomUUID()}),/原响应身份或返回范围/);
}));

test('the same automatic plan cannot pass a changed pending set, a live worker, cancelled intent or an early retry clock',()=>fixture(f=>{configure(f,{fail:'unknown'});const old=run(f,['sent']);configure(f,{fail:undefined});f.clock+=900001;const checked=R.inspect(f.base,f.e,f.dir),plan=R.automaticRecovery(f.base,f.e,f.dir,checked,['sent'],{now:()=>f.clock});assert(plan);const id=crypto.randomUUID(),r={schema:1,id,...f.e,kinds:['sent'],automaticRecovery:plan,startedAt:new Date(f.clock).toISOString(),status:'running',requests:[]};save(B.roundFile(f.base,id),r);
 assert(C.validatePlan(f.base,f.dir,r,'sent',{now:()=>f.clock}));const prior=read(B.roundFile(f.base,old.round.id)),bytes=fs.readFileSync(B.roundFile(f.base,old.round.id));prior.worker={schema:1,pid:process.pid,pgid:process.pid,birth:require('../lib/process-lease').processBirth(process.pid),startedAt:prior.startedAt};save(B.roundFile(f.base,prior.id),prior);assert.throws(()=>C.validatePlan(f.base,f.dir,r,'sent',{now:()=>f.clock}));fs.writeFileSync(B.roundFile(f.base,prior.id),bytes);const settings=path.join(B.directory(f.base),'settings.json');save(settings,{schema:1,entries:[{...f.e,enabled:false}]});assert.throws(()=>C.validatePlan(f.base,f.dir,r,'sent',{now:()=>f.clock}));save(settings,{schema:1,entries:[f.e]});assert.throws(()=>C.validatePlan(f.base,f.dir,r,'sent',{now:()=>Date.parse(plan.notBefore.sent)-1}));assert.equal(read(B.roundFile(f.base,id)).requests.length,0);
}));

test('current-day unknown maximum reservations enforce the original cap and the next day can make a new bounded request',()=>fixture(f=>{f.e.dailyBudget=3;save(path.join(B.directory(f.base),'settings.json'),{schema:1,entries:[f.e]});configure(f,{fail:'unknown'});const first=run(f,['sent']),old=unknownBytes(f);assert.equal(first.round.requests[0].reservedCredits,3);f.clock+=30000;const calls=f.service.contentCalls().length,blocked=run(f,['sent']);assert.equal(blocked.round.requests.length,0);assert.equal(f.service.contentCalls().length,calls);f.clock+=86400000;configure(f,{fail:undefined,sent:[row(100001)]});const next=run(f,['sent']);assert.equal(next.round.requests[0].count,1,diag(next));assert.equal(next.round.requests[0].returned,1,diag(next));assertOld(f,old);assert.equal(B.usage(f.base,uid,B.localDay(f.clock,'UTC')).committed,3);
}));


test('unknown current pricing and a changed source block a recovery round before any content GET',()=>{for(const mode of ['price','source'])fixture(f=>{configure(f,{fail:'transport unknown'});run(f,['sent']);f.clock+=900001;const old=unknownBytes(f),before=f.service.contentCalls().length;configure(f,{fail:undefined,unknownPrice:mode==='price'});if(mode==='source')save(path.join(B.directory(f.base),'settings.json'),{schema:1,entries:[{...f.e,source:'unsupported'}]});const checked=R.inspect(f.base,f.e,f.dir);if(mode==='source'){assert.deepEqual(checked.blockedKinds,['sent']);assert.equal(R.automaticRecovery(f.base,f.e,f.dir,checked,['sent'],{now:()=>f.clock}),null);}else{const out=run(f,['sent']);assert.equal(out.round.requests.length,0,diag(out));}assert.equal(f.service.contentCalls().length,before);assertOld(f,old);});});

test('a direction without a head restarts initialization under new authority and traverses its real pages with unknown billing',()=>fixture(f=>{fs.unlinkSync(I.stateFile(f.dir,'sent'));configure(f,{fail:'initial transport unknown'});const first=run(f,['sent']);assert.equal(first.round.requests.length,1,diag(first));assert.equal(I.readState(f.dir,'sent',uid),null);const old=unknownBytes(f);f.clock+=900001;configure(f,{fail:undefined,billing:{status:'unverified'},sent:[100005,100004,100003,100002,100001].map(id=>row(id))});const before=f.service.contentCalls().length,out=run(f,['sent']);assert(out.plan);assert(f.service.contentCalls().length-before>=2,diag(out));assert(out.round.requests.every(q=>q.status==='unknown'&&q.hash&&q.automaticRecovery?.initial),diag(out));assert(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has('100001'));assertOld(f,old);
}));
