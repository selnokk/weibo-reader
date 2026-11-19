'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const B=require('../lib/auto-follow-budget'),I=require('../lib/incremental'),J=require('../lib/request-journal'),R=require('../desktop/subscription-recovery'),{createAutoFollow}=require('../desktop/auto-follow');
const {uid,row,save,fixture,command,round,withEngine}=require('./subscription-fixture.cjs');
const settings={uid,mode:'sent',frequency:'fixed',interval:1,roundLimit:50,dailyBudget:3000,enabled:true};
function scheduler(root,f,{failStart=0,config=settings,initialTime=Date.now()}={}){
 let at=initialTime,service,attempts=0;const jobs=[],runs=[];
 const launch=r=>{jobs.push(r);attempts++;if(attempts<=failStart)throw Object.assign(Error('模拟启动失败'),{code:'EAGAIN'});const result=f.run(r,{at});runs.push(result);service.finish(r.id,{code:result.status,summary:result.summary,reason:result.stderr});};
 service=createAutoFollow(root,{now:()=>at,random:()=>0,setTimer:()=>null,launch});
 return {get s(){return service;},get at(){return at;},jobs,runs,next(){const count=jobs.length;for(let n=0;n<5;n++){const e=service.snapshot().entries[0];at=Math.max(at+1,Date.parse(e.nextCheckAt)||at+60000);service.tick();if(jobs.length>count||service.snapshot().entries[0]?.status==='budget-paused'||!service.snapshot().entries[0]?.enabled)break;}},start(){service.save(config,'enable');at+=2000;service.tick();},close(){service.close();service.release();},reopen(){service.close();service.release();service=createAutoFollow(root,{now:()=>at,random:()=>0,setTimer:()=>null,launch});}};
}
test('a transient pre-reservation launch failure persists enable intent and automatically executes and saves after restart without another enable',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]}),h=scheduler(root,f,{failStart:1});try{h.start();assert.equal(h.jobs.length,1);assert.equal(h.s.snapshot().entries[0].enabled,true);assert.equal(h.s.snapshot().entries[0].status,'retry-wait');assert.deepEqual(B.rounds(root)[0].requests,[]);h.reopen();h.next();assert.equal(h.jobs.length,2);assert.equal(h.runs[0].status,0,h.runs[0].stderr);assert(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has('101'));assert.equal(h.s.snapshot().entries[0].enabled,true);assert.equal(h.s.snapshot().entries[0].dailyBudget,3000);}finally{h.close();}
}));
test('repeated transient failures never delete enable intent; pause while waiting survives timers, wake and restart',()=>fixture(root=>{
 const f=withEngine(root),h=scheduler(root,f,{failStart:30});try{h.start();for(let i=0;i<12;i++)h.next();assert.equal(h.jobs.length,13);assert(h.s.snapshot().entries[0].enabled);const e=h.s.snapshot().entries[0];assert.equal(Date.parse(e.nextCheckAt)-h.at,30*60000);h.s.pause(uid);const count=h.jobs.length;h.reopen();h.s.wake();for(let i=0;i<4;i++)h.next();assert.equal(h.jobs.length,count);assert.equal(h.s.snapshot().entries[0].enabled,false);}finally{h.close();}
}));
test('a repaired price prerequisite automatically proceeds to an actual request under the original budget',()=>fixture(root=>{
 const f=withEngine(root,{unknownPrice:true,sent:[row(101)]}),h=scheduler(root,f);try{h.start();assert.equal(f.contentCalls().length,0);assert(h.s.snapshot().entries[0].enabled);const value=JSON.parse(fs.readFileSync(f.conf));value.unknownPrice=false;save(f.conf,value);h.next();assert.equal(f.contentCalls().length,1);assert.equal(h.runs.at(-1).summary.addedRecords,1);assert.equal(h.s.snapshot().entries[0].dailyBudget,3000);}finally{h.close();}
}));
test('an old incomplete interval cannot hide forty visible new comments within a fifty-return budget; deletion later cannot erase their bodies or promote the old head',()=>fixture(root=>{
 const f=withEngine(root,{sent:Array.from({length:15},(_,i)=>row(115-i))});const first=f.run(round(root,{roundLimit:2}));assert.equal(first.status,0,first.stderr);let state=I.readState(f.dir,'sent',uid);assert.equal(state.anchor,'100');assert(state.pending);const oldPending=structuredClone(state.pending);
 // A deleted/unavailable old body keeps the original connection unfinished.
 const bad={...row(113),text:''},fresh=Array.from({length:40},(_,i)=>row(200-i)),cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[...fresh,row(115),row(114),bad,...Array.from({length:12},(_,i)=>row(112-i))];save(f.conf,cfg);
 const next=f.run(round(root,{roundLimit:50,dailyBudget:3000}));assert(next.summary, next.stderr);const archive=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid);for(const raw of fresh)assert.equal(archive.records.get(raw.idstr)?.row.content,raw.text);
 assert(next.summary.newRecords<=50);assert.equal(next.summary.addedRecords,40);assert.equal(next.summary.sources[0].update.protection.latestSucceeded,true);state=I.readState(f.dir,'sent',uid);assert.equal(state.anchor,'100');assert.equal(state.pending.id,oldPending.id);assert.equal(state.pending.cursor,oldPending.cursor);assert(state.pending.packets.length>=oldPending.packets.length);
 cfg.sent=[row(115),row(114),bad];save(f.conf,cfg);f.run(round(root,{roundLimit:50,dailyBudget:3000}));const after=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid);for(const raw of fresh)assert.equal(after.records.get(raw.idstr)?.row.content,raw.text);assert.equal(I.readState(f.dir,'sent',uid).anchor,'100');
}));
test('a completed received response is replayed under its original reservation before automatic progress; no duplicate paid request and unread survives',()=>fixture(root=>{
 const f=withEngine(root,{sent:[]}),old=round(root),guard=B.createBudget(root,old.id);guard.configure(new Map([['sent',command()]]),{initialBalance:1000});const requestId=guard.reserve('sent',1,'100',''),taskId=crypto.randomUUID(),query={uid,kind:'sent',count:1,maxId:'',sinceId:'100',page:1,taskId},attempt=J.begin(f.dir,query,{roundId:old.id,id:requestId});
 require('../lib/follow-inbox').initialize(root,uid);J.receive(attempt,JSON.stringify({comments:[row(101)],next_cursor_str:'0'}),require('../lib/storage').cacheFile(f.dir,'sent',1,'','100'));
 const state=I.readState(f.dir,'sent',uid);state.pending={id:taskId,head:'100',cursor:'',page:0,packets:[],since:true,startedAt:new Date().toISOString()};save(I.stateFile(f.dir,'sent'),state);
 const h=scheduler(root,f);try{h.start();assert.equal(f.contentCalls().length,0);const q=B.read(B.roundFile(root,old.id)).requests[0];assert.equal(q.id,requestId);assert.equal(q.status,'estimated');assert.equal(q.estimatedCredits,3);assert.equal(q.unitPrice,3);assert.equal(I.readState(f.dir,'sent',uid).anchor,'101');assert.equal(require('../lib/follow-inbox').summary(root,uid).unread,1);assert(h.s.snapshot().entries[0].enabled);}finally{h.close();}
}));
test('restoring an unavailable original received capture resumes local replay and two later checks save new unread bodies',()=>fixture(root=>{
 const f=withEngine(root,{sent:[]}),old=round(root),guard=B.createBudget(root,old.id);guard.configure(new Map([['sent',command()]]),{initialBalance:1000});const requestId=guard.reserve('sent',1,'100',''),taskId=crypto.randomUUID(),query={uid,kind:'sent',count:1,maxId:'',sinceId:'100',page:1,taskId},attempt=J.begin(f.dir,query,{roundId:old.id,id:requestId});
 const inbox=require('../lib/follow-inbox'),unread=()=>inbox.unreadIds(inbox.view(root,uid)),stateFile=I.stateFile(f.dir,'sent'),body=id=>require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.get(id)?.row.content;
 inbox.initialize(root,uid);J.receive(attempt,JSON.stringify({comments:[row(101)],next_cursor_str:'0'}),require('../lib/storage').cacheFile(f.dir,'sent',1,'','100'));
 const capture=attempt.received.file,original=fs.readFileSync(capture),unavailable=path.join(root,'held-original-response');fs.renameSync(capture,unavailable);
 const state=I.readState(f.dir,'sent',uid);state.pending={id:taskId,head:'100',cursor:'',page:0,packets:[],since:true,startedAt:new Date().toISOString()};save(I.stateFile(f.dir,'sent'),state);
 const checkpoint=fs.readFileSync(stateFile),roundFile=B.roundFile(root,old.id),h=scheduler(root,f);
 try{
  h.start();h.next();h.reopen();h.next();assert.equal(f.contentCalls().length,0);assert.equal(h.jobs.length,0);assert.equal(h.s.snapshot().entries[0].enabled,true);
  assert.deepEqual(fs.readFileSync(stateFile),checkpoint);assert.equal(body('101'),undefined);assert.equal(unread().size,0);
  const prior=B.read(roundFile).requests[0];assert.equal(prior.id,requestId);assert.equal(prior.reservedCredits,3);assert(['reserved','unknown'].includes(prior.status));
  fs.renameSync(unavailable,capture);assert.deepEqual(fs.readFileSync(capture),original);h.next();
  assert.equal(h.jobs.length,1);assert.equal(f.contentCalls().length,0);assert.equal(I.readState(f.dir,'sent',uid).anchor,'101');assert.equal(body('101'),'独立评论 101');assert(unread().has('101'));
  const settled=B.read(roundFile).requests[0];assert.equal(settled.id,requestId);assert.equal(settled.status,'estimated');assert.equal(settled.estimatedCredits,3);assert.equal(settled.hash,attempt.received.hash);assert.deepEqual(fs.readFileSync(capture),original);
  const settledBytes=fs.readFileSync(roundFile);assert.equal(inbox.markRead(root,uid,['101']).changed,1);
  for(const id of [102,103]){
   const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(id)];save(f.conf,cfg);
   const before=f.contentCalls().length;h.next();assert.equal(f.contentCalls().length,before+1);assert.equal(h.runs.at(-1).status,0,h.runs.at(-1).stderr);
   assert.equal(I.readState(f.dir,'sent',uid).anchor,String(id));assert.equal(body(String(id)),'独立评论 '+id);assert(unread().has(String(id)));
  }
  assert(!unread().has('101'));assert.deepEqual(fs.readFileSync(roundFile),settledBytes);assert.deepEqual(fs.readFileSync(capture),original);assert.equal(h.s.snapshot().entries[0].enabled,true);
 }finally{h.close();}
}));
for(const [upper,allowed]of [['200',true],['400',false],['',false]])test('historical unknown upper '+(upper||'unbounded')+' allows only provably disjoint new requests',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(300)]});assert.equal(f.run(round(root)).status,0);
 const old=round(root),guard=B.createBudget(root,old.id);guard.configure(new Map([['sent',command()]]),{initialBalance:1000});const requestId=guard.reserve('sent',1,'100',upper),q={uid,kind:'sent',count:1,sinceId:'100',maxId:upper,page:1,taskId:crypto.randomUUID()};J.begin(f.dir,q,{roundId:old.id,id:requestId});
 const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(301),row(300)];save(f.conf,cfg);const before=f.contentCalls().length,h=scheduler(root,f);
 try{h.start();assert.equal(f.contentCalls().length-before,allowed?1:0);assert.equal(I.readState(f.dir,'sent',uid).anchor,allowed?'301':'300');const prior=B.read(B.roundFile(root,old.id)).requests[0];assert(['unknown','reserved'].includes(prior.status));assert.equal(prior.reservedCredits,3);assert(h.s.snapshot().entries[0].enabled);
  if(allowed){const active=round(root,{unresolvedRanges:[{roundId:old.id,requestId,kind:'sent',sinceId:'100',maxId:upper}]}),g=B.createBudget(root,active.id);g.configure(new Map([['sent',command()]]),{initialBalance:1000});assert.throws(()=>g.reserve('sent',1,'150',''),/重叠/);assert.equal(B.read(g.file).requests.length,0);}
 }finally{h.close();}
}));
for(const label of ['foreign-owner','foreign-bounds','missing-reservation'])test('matching bytes cannot authorize recovery with '+label,()=>fixture(root=>{
 const f=withEngine(root),r=round(root),g=B.createBudget(root,r.id);g.configure(new Map([['sent',command()]]),{initialBalance:1000});const requestId=g.reserve('sent',1,'100',''),query={uid,kind:'sent',count:1,maxId:'',sinceId:'100',page:1,taskId:crypto.randomUUID()},a=J.begin(f.dir,query,{roundId:r.id,id:requestId});J.receive(a,JSON.stringify({comments:[row(101)],next_cursor_str:'0'}),require('../lib/storage').cacheFile(f.dir,'sent',1,'','100'));
 let file=a.received.file;if(label==='foreign-owner'){const other=path.join(root,'data/user-comments/other/cache/received.json');fs.mkdirSync(path.dirname(other),{recursive:true});fs.copyFileSync(file,other);file=other;}else{const box=JSON.parse(fs.readFileSync(file));if(label==='foreign-bounds')box.query.maxId='900';else delete box.billingReservation;save(file,box);}
 const value=B.read(g.file),raw=fs.readFileSync(file);Object.assign(value.requests[0],{status:'unknown',returned:1,file,hash:crypto.createHash('sha256').update(raw).digest('hex')});B.atomic(g.file,value);const before=fs.readFileSync(g.file);assert.deepEqual(R.inspect(root,{uid,targetKind:'user'},f.dir).blockedKinds,['sent']);assert.deepEqual(fs.readFileSync(g.file),before);assert.equal(f.contentCalls().length,0);
}));
test('warm recovery locates a few pending records without rereading settled historical rounds or unrelated journal bodies',()=>fixture(root=>{
 const f=withEngine(root);for(let i=0;i<300;i++)round(root,{status:'complete',requests:[]});const r=round(root),g=B.createBudget(root,r.id);g.configure(new Map([['sent',command()]]),{initialBalance:1000});const requestId=g.reserve('sent',1,'100','');J.begin(f.dir,{uid,kind:'sent',count:1,maxId:'',sinceId:'100',page:1,taskId:crypto.randomUUID()},{roundId:r.id,id:requestId});R.inspect(root,{uid,targetKind:'user'},f.dir);
 const original=fs.readFileSync;let historicalReads=0;fs.readFileSync=function(file,...rest){if(String(file).includes('/auto-follow/rounds/')&&!String(file).includes(r.id))historicalReads++;return original.call(this,file,...rest);};try{for(let i=0;i<4;i++)assert.deepEqual(R.inspect(root,{uid,targetKind:'user'},f.dir).blockedKinds,['sent']);assert.equal(historicalReads,0);}finally{fs.readFileSync=original;}
}));
test('a newer checkpoint written during observation verification wins the CAS and remains intact',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(300)]});f.run(round(root));const originalState=I.readState(f.dir,'sent',uid),proof=JSON.parse(fs.readFileSync(path.join(f.dir,'cache',originalState.connection.file))),id=crypto.randomUUID(),window={...originalState,anchor:'300',connectedProof:proof,observationOnly:true};save(I.stateFile(f.dir,'sent',id),window);
 const lower={...originalState,anchor:'100',pending:null};save(I.stateFile(f.dir,'sent'),lower);const original=I.readState;let interleaved=false;
 I.readState=function(dir,kind,id,options){const snapshot=original(dir,kind,id,options);if(dir===f.dir&&kind==='sent'&&!options?.windowId&&!interleaved){interleaved=true;save(I.stateFile(dir,kind),{...originalState,anchor:'200',newerWitness:'preserve-newer-operation',lastAttempt:{connected:true,reason:'newer verified local operation'}});}return snapshot;};
 try{assert.throws(()=>require('../lib/subscription-latest').reconcile(f.dir,'sent',uid,{windows:[id]}),/变化|改变|冲突|另一轮/);assert.equal(I.readState(f.dir,'sent',uid).anchor,'200');assert.equal(I.readState(f.dir,'sent',uid).newerWitness,'preserve-newer-operation');}finally{I.readState=original;}
}));
for(const mode of ['automatic-error','manual-pause','user-stop','wrong-round','foreign-type','unknown-intent'])test('legacy 2.0 settings migrate only proven automatic disable: '+mode,()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]}),finishedAt=new Date().toISOString(),r=round(root,{status:'failed',finishedAt,reason:'旧版单轮启动失败'}),entry={...settings,intentVersion:undefined,enabled:false,status:mode==='manual-pause'?'paused':'error-paused',lastRoundId:r.id,lastCheckAt:finishedAt,reason:r.reason,nextCheckAt:null};
 if(mode==='user-stop')save(B.roundFile(root,r.id)+'.stop',{schema:1,roundId:r.id,uid,code:'USER_CANCELLED'});
 if(mode==='wrong-round')entry.lastRoundId=crypto.randomUUID();
 if(mode==='foreign-type'){r.targetKind='post';B.atomic(B.roundFile(root,r.id),r);}
 if(mode==='unknown-intent')delete entry.lastRoundId;
 save(path.join(B.directory(root),'settings.json'),{schema:1,entries:[entry]});let at=Date.now(),s,jobs=0;s=createAutoFollow(root,{now:()=>at,random:()=>0,setTimer:()=>null,launch:job=>{jobs++;const result=f.run(job,{at});s.finish(job.id,{code:result.status,summary:result.summary});}});
 try{const e=s.snapshot().entries[0];assert.equal(e.enabled,mode==='automatic-error');at+=3600000;s.tick();assert.equal(jobs,mode==='automatic-error'?1:0);assert.equal(f.contentCalls().length,mode==='automatic-error'?1:0);if(mode==='automatic-error'){assert.equal(I.readState(f.dir,'sent',uid).anchor,'101');assert.equal(s.snapshot().entries[0].dailyBudget,3000);}assert.equal(B.read(B.roundFile(root,r.id)).reason,r.reason);}finally{s.close();s.release();}
}));
for(const blockedKind of ['sent','received'])test('both-mode keeps the healthy '+(blockedKind==='sent'?'received':'sent')+' direction on its one-minute clock while another result stays unknown',()=>fixture(root=>{
 const healthy=blockedKind==='sent'?'received':'sent',base=healthy==='sent'?100:200,f=withEngine(root,{[healthy]:[row(base+1,healthy)]}),old=round(root,{mode:'both',kinds:['sent','received']}),guard=B.createBudget(root,old.id);guard.configure(new Map([['sent',command('sent')],['received',command('received')]]),{initialBalance:1000});const lower=blockedKind==='sent'?'100':'200',requestId=guard.reserve(blockedKind,1,lower,'');J.begin(f.dir,{uid,kind:blockedKind,count:1,sinceId:lower,maxId:'',page:1,taskId:crypto.randomUUID()},{roundId:old.id,id:requestId});
 const h=scheduler(root,f,{config:{...settings,mode:'both'}});try{h.start();const pending=structuredClone(B.read(B.roundFile(root,old.id)).requests[0]);for(let n=2;n<=8;n++){const e=h.s.snapshot().entries[0];assert.equal(Date.parse(e.directionRetry[healthy].nextRetryAt)-h.at,60000);const cfg=JSON.parse(fs.readFileSync(f.conf));cfg[healthy]=[row(base+n,healthy)];save(f.conf,cfg);h.next();assert.equal(I.readState(f.dir,healthy,uid).anchor,String(base+n));assert.deepEqual(B.read(B.roundFile(root,old.id)).requests[0],pending);}const calls=f.contentCalls();assert(calls.every(a=>a[1]===(healthy==='sent'?'by_me/other':'to_me/other')));for(let n=1;n<=8;n++)assert(require('../lib/completeness').loadIndependentArchive(f.dir,healthy,uid).records.has(String(base+n)));const before=calls.length;h.s.pause(uid);h.reopen();h.s.wake();h.next();assert.equal(f.contentCalls().length,before);}finally{h.close();}
}));
test('successful latest-window protection keeps its poll clock and never revisits old bodies',()=>fixture(root=>{
 const f=withEngine(root,{sent:Array.from({length:15},(_,i)=>row(115-i))});f.run(round(root,{roundLimit:2}));const h=scheduler(root,f);try{for(let cycle=0;cycle<8;cycle++){const cfg=JSON.parse(fs.readFileSync(f.conf)),fresh=Array.from({length:4},(_,i)=>row(200+cycle*4-i));cfg.sent=[...fresh,row(115),row(114),{...row(113),text:''}];save(f.conf,cfg);if(!cycle)h.start();else h.next();const e=h.s.snapshot().entries[0];assert.equal(Date.parse(e.nextCheckAt)-h.at,60000);assert(e.enabled);assert.equal(I.readState(f.dir,'sent',uid).anchor,'100');for(const r of fresh)assert(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has(r.idstr));}assert(h.runs.every(r=>r.summary.billing.returnedRecords===4));}finally{h.close();}
}));
test('temporary settings-save failure actually recovers to a new request and save with no second enable',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]}),original=B.atomic;let at=Date.now(),s,fail=true,jobs=0;s=createAutoFollow(root,{now:()=>at,setTimer:()=>null,random:()=>0,launch:r=>{jobs++;const result=f.run(r,{at});s.finish(r.id,{code:result.status,summary:result.summary});}});try{s.save(settings,'enable');B.atomic=(file,value)=>{if(fail&&file===path.join(B.directory(root),'settings.json')){fail=false;throw Object.assign(Error('模拟磁盘暂时不可写'),{code:'EIO'});}return original(file,value);};at+=2000;s.tick();assert.equal(jobs,0);assert(s.snapshot().entries[0].enabled);B.atomic=original;at=Date.parse(s.snapshot().entries[0].nextCheckAt)+1;s.tick();assert.equal(jobs,1);assert.equal(I.readState(f.dir,'sent',uid).anchor,'101');}finally{B.atomic=original;s.close();s.release();}
}));
test('after a scoped gap repair, the next round joins a saved protection chain offline before its first paid request',()=>fixture(root=>{
 const f=withEngine(root,{sent:Array.from({length:15},(_,i)=>row(115-i))});f.run(round(root,{roundLimit:2}));const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[120,119,118,117,116,...Array.from({length:15},(_,i)=>115-i)].map(id=>row(id));save(f.conf,cfg);const protectedRun=f.run(round(root,{roundLimit:6,dailyBudget:3000}));assert(protectedRun.summary,protectedRun.stderr);assert.equal(I.readState(f.dir,'sent',uid).anchor,'100');
 const manual=round(root,{roundLimit:50,dailyBudget:3000}),script=`const fs=require('fs'),B=require('./lib/auto-follow-budget'),I=require('./lib/incremental'),r=B.read(B.roundFile(process.cwd(),${JSON.stringify(manual.id)})),g=B.createBudget(process.cwd(),r.id);g.configure(new Map([['sent',${JSON.stringify(command())}]]),{initialBalance:JSON.parse(fs.readFileSync('mock.json')).balance});const dir=${JSON.stringify(f.dir)};I.harvestUpdates({uid:${JSON.stringify(uid)},mode:'sent',pageSize:200,pages:Infinity,quickOnly:true},dir,'sent',50,{updateSince:{sent:true}},require('./lib/storage').getOne,()=>{throw Error('unexpected initialization')});`;
 const result=require('node:child_process').spawnSync(process.execPath,['-e',script],{cwd:root,env:{...process.env,WEIBO_DESKTOP_PROJECT:root,WEIBO_DESKTOP_CLI:path.join(root,'mock-cli.js')},encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(I.readState(f.dir,'sent',uid).anchor,'115');
 const before=f.contentCalls().length,estimate=B.usage(root,uid,B.localDay()).estimatedCredits,current=JSON.parse(fs.readFileSync(f.conf));current.sent=[row(121)];save(f.conf,current);const next=f.run(round(root,{roundLimit:50,dailyBudget:3000}));assert.equal(next.status,0,next.stderr);const calls=f.contentCalls().slice(before);assert.equal(calls.length,1);assert.equal(calls[0][calls[0].indexOf('--since_id')+1],'120');assert.equal(B.usage(root,uid,B.localDay()).estimatedCredits-estimate,3);assert.equal(I.readState(f.dir,'sent',uid).anchor,'121');
}));

test('a known since violation is rechecked once with the original reliable boundary; service repair actually resumes without enabling or dropping the old interval',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]});assert.equal(f.run(round(root)).status,0);const before=I.readState(f.dir,'sent',uid);assert(require('../lib/subscription-boundary').trustedHead(f.dir,'sent',uid,before));
 const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.ignoreSince=true;save(f.conf,cfg);const h=scheduler(root,f);try{h.start();assert(I.readState(f.dir,'sent',uid).sinceDisabled);assert(h.s.snapshot().entries[0].enabled);const prior=I.readState(f.dir,'sent',uid),oldCount=f.contentCalls().length;h.next();assert.equal(f.contentCalls().length-oldCount,1);assert(I.readState(f.dir,'sent',uid).sinceDisabled);assert.equal(I.readState(f.dir,'sent',uid).anchor,'101');
  cfg.ignoreSince=false;cfg.sent=[row(102),row(101)];save(f.conf,cfg);const count=f.contentCalls().length;h.next();const after=I.readState(f.dir,'sent',uid);assert.equal(after.anchor,'102');assert.equal(after.sinceDisabled,false);assert.equal(after.boundaryRecovery.accepted,true);assert.equal(f.contentCalls().length-count,1,'the valid one-row proof is reused, not paid for twice');assert.equal(h.s.snapshot().entries[0].dailyBudget,3000);assert(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has('102'));
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,after.boundaryRecovery.previousState.file)));assert.equal(saved.originalState.anchor,'101');assert(saved.originalState.sinceDisabled);assert.equal(saved.originalState.pending.id,prior.pending.id);assert(f.contentCalls().slice(oldCount).every(a=>a[a.indexOf('--since_id')+1]==='101'&&a[a.indexOf('--count')+1]==='1'));
 }finally{h.close();}
}));
test('a boundary refusal without hash-bound old head never invents a baseline or sends a new request',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]}),s=I.readState(f.dir,'sent',uid);s.sinceDisabled=true;save(I.stateFile(f.dir,'sent'),s);const h=scheduler(root,f);try{h.start();h.next();assert.equal(f.contentCalls().length,0);assert.equal(I.readState(f.dir,'sent',uid).anchor,'100');assert(I.readState(f.dir,'sent',uid).sinceDisabled);assert(h.s.snapshot().entries[0].enabled);}finally{h.close();}
}));
test('an ended service refusal during a disabled-boundary trial recovers via a fresh scoped request',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(100001)]}),kind='sent',file=I.stateFile(f.dir,kind),state=()=>I.readState(f.dir,kind,uid);
 assert.equal(f.run(round(root)).status,0);assert.equal(state().anchor,'100001');
 const cfg=JSON.parse(fs.readFileSync(f.conf)),update=value=>{Object.assign(cfg,value);save(f.conf,cfg);},h=scheduler(root,f);
 const previous=()=>B.read(B.roundFile(root,h.jobs.at(-1).id));
 try{
  update({ignoreSince:true});h.start();assert.equal(state().sinceDisabled,true);
  update({fail:JSON.stringify({success:false,error:{code:'IP_GEO_DENIED',message:'Synthetic region'}})});h.next();
  const denied=previous();assert.equal(denied.requests.length,1);assert.equal(denied.requests[0].status,'unknown');
  const deniedFile=B.roundFile(root,denied.id),request=J.subscriptionRequests(f.dir,denied.id,denied.requests[0].id)[0],rejection=request.replace(/\.request\.json$/,'.rejection.json'),original=new Map([deniedFile,request,rejection].map(name=>[name,fs.readFileSync(name)]));
  const disabled=state(),disabledBytes=fs.readFileSync(file);h.reopen();
  update({fail:null});const badBefore=f.contentCalls().length;h.next();const rejected=previous();
  assert.equal(f.contentCalls().length-badBefore,1);assert.equal(rejected.requests[0].automaticRecovery.windowId,rejected.id);assert.deepEqual(fs.readFileSync(file),disabledBytes);
  update({ignoreSince:false,sent:[row(100002),row(100001)]});const goodBefore=f.contentCalls().length;h.next();
  const recovered=previous(),after=state(),result=h.runs.at(-1);
  assert.equal(result.status,0,JSON.stringify({stderr:result.stderr,signal:result.signal,error:result.error?.message,summary:result.summary,safety:result.events.filter(e=>e.type==='autoSafety'),round:{status:recovered.status,safetyCode:recovered.safetyCode,reason:recovered.reason,requests:recovered.requests.length}}));assert.equal(f.contentCalls().length-goodBefore,1);assert.equal(recovered.requests[0].returned,1);assert.equal(recovered.requests[0].sinceId,'100001');assert.equal(recovered.requests[0].automaticRecovery.windowId,recovered.id);
  assert.equal(after.anchor,'100002');assert.equal(after.sinceDisabled,false);assert.equal(after.boundaryRecovery.accepted,true);
  const archive=JSON.parse(fs.readFileSync(path.resolve(f.dir,after.boundaryRecovery.previousState.file)));assert.deepEqual(archive.originalState,disabled);
  for(const [name,bytes] of original)assert.deepEqual(fs.readFileSync(name),bytes);
  update({sent:[row(100003),row(100002)]});const laterBefore=f.contentCalls().length;h.next();assert.equal(f.contentCalls().length-laterBefore,1);assert.equal(state().anchor,'100003');
  const inbox=require('../lib/follow-inbox'),ids=inbox.unreadIds(inbox.view(root,uid));assert(ids.has('100002'));assert(ids.has('100003'));assert.equal(h.s.snapshot().entries[0].enabled,true);
 }finally{h.close();}
}));
test('an exhausted daily budget resumes on the next day and two normal rounds save distinct unread bodies',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]}),timeZone='UTC',dailyBudget=6,initialTime=Date.UTC(2026,10,11,12);
 const h=scheduler(root,f,{initialTime,config:{...settings,timeZone,dailyBudget}}),entry=()=>h.s.snapshot().entries[0];
 const inbox=require('../lib/follow-inbox'),unread=()=>inbox.unreadIds(inbox.view(root,uid)),head=()=>I.readState(f.dir,'sent',uid).anchor;
 const firstDay=B.localDay(initialTime,timeZone),usage=day=>B.usage(root,uid,day);
 const setBody=id=>{const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(id)];save(f.conf,cfg);};
 const assertNew=id=>{
  assert.equal(head(),String(id));assert(unread().has(String(id)));
  const body=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.get(String(id))?.row.content;
  assert.equal(body,'独立评论 '+id);
 };
 try{
  h.start();assertNew(101);setBody(102);h.next();assertNew(102);
  assert.equal(f.contentCalls().length,2);assert.equal(usage(firstDay).estimatedCredits,6);assert.equal(usage(firstDay).committed,6);
  const sourceFiles=B.rounds(root).filter(r=>r.requests.length).flatMap(r=>[B.roundFile(root,r.id),...r.requests.flatMap(q=>{
   const [file]=J.subscriptionRequests(f.dir,r.id,q.id);
   return [file,file.replace(/\.request\.json$/,'.received.json'),file.replace(/\.request\.json$/,'.response.json')];
  })]);
  const original=new Map(sourceFiles.map(file=>[file,fs.readFileSync(file)]));
  assert.equal(inbox.markRead(root,uid,['101','102']).changed,2);setBody(103);h.next();
  assert.equal(entry().status,'budget-paused');assert.equal(entry().enabled,true);assert.equal(B.localDay(h.at,timeZone),firstDay);
  assert.equal(f.contentCalls().length,2);assert.equal(head(),'102');assert.equal(unread().size,0);
  h.reopen();h.s.wake();h.s.tick();assert.equal(f.contentCalls().length,2);
  h.next();assert.equal(f.contentCalls().length,3);assert.equal(h.runs.at(-1).status,0,h.runs.at(-1).stderr);assertNew(103);
  const secondDay=B.localDay(h.at,timeZone);assert.notEqual(secondDay,firstDay);assert.equal(usage(secondDay).committed,3);
  setBody(104);h.next();assert.equal(f.contentCalls().length,4);assert.equal(h.runs.at(-1).status,0,h.runs.at(-1).stderr);assertNew(104);
  assert.equal(B.localDay(h.at,timeZone),secondDay);assert.equal(usage(secondDay).committed,6);assert.equal(usage(firstDay).committed,6);
  assert.deepEqual([...unread()].sort(),['103','104']);assert.equal(entry().dailyBudget,dailyBudget);assert.equal(entry().enabled,true);
  for(const [file,bytes] of original)assert.deepEqual(fs.readFileSync(file),bytes);
 }finally{h.close();}
}));
test('paused intent and a newer source configuration survive a late callback, wake and restart',()=>fixture(root=>{
 const f=withEngine(root);let at=Date.now(),job,s=createAutoFollow(root,{now:()=>at,setTimer:()=>null,launch:r=>job=r});try{s.save(settings,'enable');at+=2000;s.tick();assert(job);s.pause(uid);s.finish(job.id,{code:1,failureCode:'AUTO_START_FAILED'});s.wake();s.close();s.release();s=createAutoFollow(root,{now:()=>at,setTimer:()=>null,launch:()=>assert.fail('paused subscription must not restart')});at+=3600000;s.tick();assert.equal(s.snapshot().entries[0].enabled,false);assert.equal(s.snapshot().entries[0].nextCheckAt,null);}finally{s.close();s.release();}
}));

test('an independently restored body remains available without purchasing the stalled interval again or proving continuity',()=>fixture(root=>{
 const f=withEngine(root,{sent:Array.from({length:15},(_,i)=>row(115-i))});f.run(round(root,{roundLimit:2}));let cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(115),row(114),{...row(113),text:''},...Array.from({length:12},(_,i)=>row(112-i))];save(f.conf,cfg);f.run(round(root,{roundLimit:50,dailyBudget:3000}));assert.equal(I.readState(f.dir,'sent',uid).anchor,'100');
 cfg.sent=[row(113)];save(f.conf,cfg);const script=`require('./lib/storage').getOne({uid:${JSON.stringify(uid)},refresh:true,dataTaskId:require('crypto').randomUUID()},${JSON.stringify(f.dir)},'sent',1,'113','100');`,p=require('node:child_process').spawnSync(process.execPath,['-e',script],{cwd:root,env:{...process.env,WEIBO_DESKTOP_PROJECT:root,WEIBO_DESKTOP_CLI:path.join(root,'mock-cli.js')},encoding:'utf8'});assert.equal(p.status,0,p.stderr);
 cfg.sent=Array.from({length:15},(_,i)=>row(115-i));save(f.conf,cfg);
 const pending=I.readState(f.dir,'sent',uid).pending,calls=f.contentCalls().length,h=scheduler(root,f);
 try{h.start();h.next();h.next();
 assert.deepEqual(I.readState(f.dir,'sent',uid).pending,pending);
 assert.equal(I.readState(f.dir,'sent',uid).anchor,'100');
 assert(h.runs.every(r=>r.summary.billing.estimatedCredits===0));
 assert.deepEqual(f.contentCalls().slice(calls).map(args=>[args[args.indexOf('--since_id')+1],args.includes('--max_id')]),[['115',false],['115',false],['115',false]]);
 assert.equal(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.get('113').row.content,'独立评论 113');
 assert(h.s.snapshot().entries[0].enabled);const boxes=fs.readdirSync(J.folder(f.dir)).filter(n=>n.endsWith('.response.json')).map(n=>JSON.parse(fs.readFileSync(path.join(J.folder(f.dir),n))));assert(!boxes.some(b=>b.response.comments.some(r=>r.idstr==='113'&&r.text==='')));assert(boxes.some(b=>b.response.comments.some(r=>r.idstr==='113'&&r.text==='独立评论 113')));}finally{h.close();}
}));

test('a repaired finalization blocker is retried locally and then actually executes the next request without another enable',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]}),{createFinalizer}=require('../desktop/task-finalizer');let at=Date.now(),failed=true,service,finalizer,launches=0;
 service=createAutoFollow(root,{now:()=>at,random:()=>0,setTimer:()=>null,recoverLocal:()=>finalizer.recover(),canDispatch:e=>!finalizer.blockedFor({mode:'comments-sent',target:e.uid}).length,launch:r=>{launches++;const result=f.run(r,{at});finalizer.finalize({id:r.id,kind:'collect',automatic:true,query:{target:uid,mode:'comments-sent',syncOnly:true},startedAt:r.startedAt,result:result.summary,timers:[],reports:[]},{code:result.status});}});
 finalizer=createFinalizer(root,{billingHistory(){if(failed)throw Error('模拟费用历史暂时不可写');},settle:(j,c,{recovery})=>(recovery?service.recoverSettlement:service.finish)(j.id,{summary:j.result,code:c}),criticalFailure:(j,errors)=>service.holdFinalization(j.id,errors.map(e=>e.message).join('；'),{uid,targetKind:'user'}),release(){}});
 try{service.save(settings,'enable');at+=2000;service.tick();assert.equal(launches,1);assert(service.snapshot().entries[0].enabled);assert(finalizer.recoveryBlocked());at+=60000;service.tick();assert.equal(launches,1);failed=false;const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(102)];save(f.conf,cfg);at+=3600000;service.tick();assert.equal(launches,2);assert.equal(I.readState(f.dir,'sent',uid).anchor,'102');assert(!finalizer.recoveryBlocked());assert(service.snapshot().entries[0].enabled);}finally{service.close();service.release();}
}));

test('an external same-owner writer blocks local replay, while the next independent target can still dispatch',()=>fixture(root=>{
 withEngine(root);const other='9876543210',at=Date.now(),a={...settings,nextCheckAt:new Date(at).toISOString(),status:'waiting'},b={...settings,uid:other,nextCheckAt:new Date(at+1).toISOString(),status:'waiting'};save(path.join(B.directory(root),'settings.json'),{schema:1,entries:[a,b]});let clock=at;const jobs=[],access=require('../lib/workspace-access'),unlock=access.enterObject(root,'user',uid),s=createAutoFollow(root,{now:()=>clock,setTimer:()=>null,launch:r=>jobs.push(r)});try{s.tick();assert.equal(jobs.length,0);assert(s.snapshot().entries.find(e=>e.uid===uid).enabled);clock++;s.tick();assert.equal(jobs.length,1);assert.equal(jobs[0].uid,other);}finally{unlock();s.close();s.release();}
}));

test('an incomplete first delta body cannot pin latest polling to its old cached response; all forty later visible bodies are saved',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]});assert.equal(f.run(round(root)).status,0);let cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[{...row(102),text:''}];save(f.conf,cfg);f.run(round(root));const before=I.readState(f.dir,'sent',uid);assert.equal(before.pending.head,'101');assert.equal(before.pending.packets.length,0);cfg.sent=[...Array.from({length:40},(_,n)=>row(142-n)),{...row(102),text:''}];save(f.conf,cfg);const h=scheduler(root,f);try{h.start();const saved=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid);for(let id=103;id<=142;id++)assert(saved.records.has(String(id)));assert.equal(I.readState(f.dir,'sent',uid).anchor,'142');assert(I.readState(f.dir,'sent',uid).gaps.unresolvedIds.includes('102'));assert(h.s.snapshot().entries[0].enabled);}finally{h.close();}
}));
test('a new full chain from the same reliable lower bound can replace a zero-prefix failed attempt only after preserving it durably',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]});f.run(round(root));let cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[{...row(102),text:''}];save(f.conf,cfg);f.run(round(root));const prior=I.readState(f.dir,'sent',uid);cfg.sent=[row(103),row(102)];save(f.conf,cfg);const h=scheduler(root,f);try{h.start();const state=I.readState(f.dir,'sent',uid);assert.equal(state.anchor,'103');assert.equal(state.pending,null);const ref=state.supersededSubscriptionIntervals.at(-1),bytes=fs.readFileSync(path.join(f.dir,ref.file));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),ref.hash);assert.equal(JSON.parse(bytes).originalState.pending.id,prior.pending.id);assert.equal(JSON.parse(bytes).replacementProof.lower,'101');}finally{h.close();}
}));

test('fifty local bodies and six known missing IDs with no reliable head bootstrap one exact fresh response, then actually follow new comments',()=>fixture(root=>{
 const f=withEngine(root),old=path.join(f.dir,'cache/sent_c100_m0.json'),oldRaw={comments:Array.from({length:50},(_,n)=>row(1000-n*2)),next_cursor_str:'901',miss_ids:['999','997','995','993','991','989'],miss_count:6};save(old,oldRaw);fs.unlinkSync(I.stateFile(f.dir,'sent'));let cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=oldRaw.comments;save(f.conf,cfg);
 const script=`const r=require('./lib/data-update').harvestData({uid:${JSON.stringify(uid)},syncOnly:true,syncOperation:'regular',pageSize:200,pages:Infinity,count:50,taskScopeId:require('crypto').randomUUID()},${JSON.stringify(f.dir)},'sent',50,{updateSince:{sent:true}},require('./lib/storage').getOne);console.log(JSON.stringify({covered:r.fetched,returned:r.newFetched}));`,p=require('node:child_process').spawnSync(process.execPath,['-e',script],{cwd:root,env:{...process.env,WEIBO_DESKTOP_PROJECT:root,WEIBO_DESKTOP_CLI:path.join(root,'mock-cli.js')},encoding:'utf8'});assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/"covered":50,"returned":0/);assert(!fs.existsSync(I.stateFile(f.dir,'sent')));const original=fs.readFileSync(old);cfg.sent=[row(1100),...oldRaw.comments];save(f.conf,cfg);const before=f.contentCalls().length,h=scheduler(root,f);try{h.start();assert.equal(I.readState(f.dir,'sent',uid).anchor,'1100');assert.equal(f.contentCalls().length-before,1);assert(!f.contentCalls().at(-1).includes('--since_id'));assert.equal(f.contentCalls().at(-1)[f.contentCalls().at(-1).indexOf('--count')+1],'1');cfg.sent=[row(1101),row(1100)];save(f.conf,cfg);h.next();assert.equal(I.readState(f.dir,'sent',uid).anchor,'1101');assert.equal(h.s.snapshot().entries[0].dailyBudget,3000);assert(h.s.snapshot().entries[0].enabled);assert.deepEqual(fs.readFileSync(old),original);const archive=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid);for(const r of oldRaw.comments)assert(archive.records.has(r.idstr));assert(archive.records.has('1100'));assert(archive.records.has('1101'));}finally{h.close();}
}));
test('a received direction unable to establish a complete first head cannot stop an independently healthy sent direction',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)],received:[{...row(201,'received'),text:''}]});fs.unlinkSync(I.stateFile(f.dir,'received'));const h=scheduler(root,f,{config:{...settings,mode:'both'}});try{h.start();assert.equal(I.readState(f.dir,'sent',uid).anchor,'101');assert(!fs.existsSync(I.stateFile(f.dir,'received')));assert(h.s.snapshot().entries[0].enabled);assert.equal(Date.parse(h.s.snapshot().entries[0].directionRetry.sent.nextRetryAt)-h.at,60000);const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(102)];cfg.received=[row(202,'received')];save(f.conf,cfg);h.next();if(I.readState(f.dir,'sent',uid).anchor!=='102')h.next();assert.equal(I.readState(f.dir,'sent',uid).anchor,'102');assert.equal(I.readState(f.dir,'received',uid).anchor,'202');}finally{h.close();}
}));
test('a first subscription with no reliable head saves all forty currently visible new bodies within its fifty-return allowance before they disappear',()=>fixture(root=>{
 const fresh=Array.from({length:40},(_,i)=>row(1100-i)),f=withEngine(root,{sent:fresh});fs.unlinkSync(I.stateFile(f.dir,'sent'));const prior=fs.readFileSync(path.join(f.dir,'cache/sent_c2_m0.json')),job=round(root,{roundLimit:50,dailyBudget:3000}),r=f.run(job);assert.equal(r.status,0,r.stderr);assert.equal(r.summary.addedRecords,40);assert.equal(r.summary.billing.returnedRecords,40);assert(r.summary.billing.returnedRecords<=50);assert.equal(f.contentCalls()[0][f.contentCalls()[0].indexOf('--count')+1],'1');const state=I.readState(f.dir,'sent',uid);assert.equal(state.anchor,'1100');assert.equal(state.scope.olderHistoryComplete,false);const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(1101)];save(f.conf,cfg);const again=f.run(round(root,{roundLimit:50,dailyBudget:3000}));assert.equal(again.status,0,again.stderr);const archive=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid);for(const raw of fresh)assert.equal(archive.records.get(raw.idstr)?.row.content,raw.text);assert(archive.records.has('1101'));assert.equal(I.readState(f.dir,'sent',uid).anchor,'1101');assert.deepEqual(fs.readFileSync(path.join(f.dir,'cache/sent_c2_m0.json')),prior);
}));
test('first subscription purchases only the newest 100 rows even when a nonempty response reports zero cursor',()=>fixture(root=>{
 const sent=Array.from({length:150},(_,i)=>row(1250-i));
 const f=withEngine(root,{sent,placeholderZero:true});
 fs.unlinkSync(I.stateFile(f.dir,'sent'));
 const first=f.run(round(root,{roundLimit:100,dailyBudget:3000}));
 assert.equal(first.status,0,first.stderr);
 assert.equal(first.summary.addedRecords,100);
 assert.equal(first.summary.billing.estimatedCredits,300);
 assert.equal(I.readState(f.dir,'sent',uid).anchor,'1250');
 assert.deepEqual(f.contentCalls().map(call=>call[call.indexOf('--count')+1]),['1','99']);
 const next=f.run(round(root,{roundLimit:100,dailyBudget:3000}));
 assert.equal(next.status,0,next.stderr);
 assert.equal(next.summary.billing.estimatedCredits,0);
 assert.equal(f.contentCalls().length,3);
 assert.equal(f.contentCalls().at(-1)[f.contentCalls().at(-1).indexOf('--since_id')+1],'1250');
 const saved=require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records;
 assert(saved.has('1151'));assert(!saved.has('1150'));
}));
test('an unknown first-window continuation does not become a global head or get resent, while a disjoint new observation is saved automatically',()=>fixture(root=>{
 const f=withEngine(root,{sent:Array.from({length:40},(_,i)=>row(1100-i))});fs.unlinkSync(I.stateFile(f.dir,'sent'));const shim=path.join(root,'mock-cli.js');fs.writeFileSync(shim,fs.readFileSync(shim,'utf8').replace("if(cfg.fail){", "if(cfg.failMax&&a.includes('--max_id')){console.error('unknown continuation');process.exit(1);}if(cfg.fail){"));let cfg=JSON.parse(fs.readFileSync(f.conf));cfg.failMax=true;save(f.conf,cfg);const original=round(root,{roundLimit:50,dailyBudget:3000}),first=f.run(original);assert.equal(first.status,1);assert.equal(I.readState(f.dir,'sent',uid),null);const old=B.read(B.roundFile(root,original.id)),unknown=old.requests.find(q=>q.status==='unknown');assert.equal(unknown.maxId,'1099');const rawBytes=fs.readFileSync(B.roundFile(root,original.id)),count=f.contentCalls().length;cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[row(1101)];save(f.conf,cfg);const h=scheduler(root,f);try{h.start();assert.equal(f.contentCalls().length,count+1);const last=f.contentCalls().at(-1);assert.equal(last[last.indexOf('--since_id')+1],'1100');assert(!last.includes('--max_id'));assert.equal(I.readState(f.dir,'sent',uid),null,'a point observation never certifies the unknown initial interval');assert(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has('1101'));assert.deepEqual(B.read(B.roundFile(root,original.id)).requests.find(q=>q.id===unknown.id),unknown);h.s.pause(uid);h.next();assert.equal(f.contentCalls().length,count+1);}finally{h.close();}
}));
