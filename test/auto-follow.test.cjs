const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const store=require(process.cwd()+'/lib/auto-follow-budget'),{createAutoFollow,validate}=require(process.cwd()+'/desktop/auto-follow');
const {uid,peer,row,save,fixture,command,round,withEngine}=require('./subscription-fixture.cjs');
test('automatic configuration is explicit, bounded, and has no default enabled users',()=>fixture(root=>{
 const launches=[],s=createAutoFollow(root,{setTimer:()=>null,launch:r=>launches.push(r)});s.tick();assert.deepEqual(s.snapshot().entries,[]);assert.equal(launches.length,0);for(const bad of [{mode:'both',roundLimit:1},{mode:'sent',roundLimit:0},{mode:'all',roundLimit:10},{mode:'sent',roundLimit:10,dailyBudget:0}])assert.throws(()=>validate({uid,mode:'sent',interval:15,roundLimit:100,dailyBudget:300,...bad}));s.close();s.release();
}));
test('no delta returns one empty probe with zero estimate and no ending balance query, HTML or batch',()=>fixture(root=>{
 const f=withEngine(root),r=round(root),p=f.run(r);assert.equal(p.status,0,p.stderr);assert.deepEqual(f.contentCalls().map(a=>[a[a.indexOf('--count')+1],a[a.indexOf('--since_id')+1]]),[['1','100']]);assert.equal(p.summary.addedRecords,0);assert.equal(p.summary.billing.estimatedCredits,0);assert.equal(p.summary.billing.initialBalance,1000);assert.equal(p.summary.billing.finalBalance,null);assert.equal(fs.readFileSync(f.calls,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(a=>a[0]==='me').length,1);assert.equal(p.summary.incomplete,false);assert.equal(p.summary.batchId,null);assert.equal(fs.existsSync(path.join(f.dir,'cache/batches')),false);assert.equal(fs.existsSync(path.join(root,'output/user-comments/目标')),false);const history=require(process.cwd()+'/lib/database-sync').history(f.dir);assert.equal(history[0].operation,'automatic');assert.equal(history[0].billing.actualCredits,null);
}));
test('each direction is checked independently even when sent has no new records; repeated checking does not duplicate records',()=>fixture(root=>{
 const f=withEngine(root,{received:[row(201,'received')]}),p=f.run(round(root,{mode:'both',kinds:['sent','received']}));assert.equal(p.status,0,p.stderr);assert.equal(p.summary.addedRecords,1);assert.equal(p.summary.billing.estimatedCredits,3);assert.deepEqual(f.contentCalls().map(a=>a[1]),['by_me/other','to_me/other']);const again=f.run(round(root,{mode:'both',kinds:['sent','received']}));assert.equal(again.summary.addedRecords,0);assert.equal(again.summary.billing.estimatedCredits,0);assert.equal(require(process.cwd()+'/lib/completeness').loadIndependentArchive(f.dir,'received',uid).records.size,3);
}));
test('daily budget clamps requests, and the next day probes above the saved latest row',()=>fixture(root=>{
 const f=withEngine(root,{sent:[105,104,103,102,101].map(x=>row(x))}),p=f.run(round(root,{dailyBudget:6}));assert.equal(p.status,0,p.stderr);assert.equal(p.summary.addedRecords,2);assert.equal(p.summary.billing.estimatedCredits,6);assert.equal(p.summary.autoStop.code,'AUTO_DAILY_BUDGET');let state=require(process.cwd()+'/lib/incremental').readState(f.dir,'sent',uid);assert.equal(state.anchor,'100');assert.equal(state.pending.cursor,'103');assert.deepEqual(f.contentCalls().map(a=>a[a.indexOf('--count')+1]),['1','1']);
 // Move simulated old reservations into the preceding day, then reuse the real pending chain.
 for(const r of store.rounds(root)){for(const q of r.requests)q.day='2000-01-01';store.atomic(store.roundFile(root,r.id),r);}
 const next=f.run(round(root,{dailyBudget:300}));assert.equal(next.status,0,next.stderr);assert.equal(next.summary.addedRecords,0);assert.equal(next.summary.billing.estimatedCredits,0);const calls=f.contentCalls();assert.equal(calls.length,3);assert.equal(calls[2][calls[2].indexOf('--count')+1],'1');assert.equal(calls[2].includes('--max_id'),false);assert.equal(calls[2][calls[2].indexOf('--since_id')+1],'105');state=require(process.cwd()+'/lib/incremental').readState(f.dir,'sent',uid);assert.equal(state.anchor,'100');assert.equal(state.pending.cursor,'103');assert.equal(require(process.cwd()+'/lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.size,4);
}));
test('a per-round cap is independent of a daily budget and preserves pending positions',()=>fixture(root=>{
 const f=withEngine(root,{sent:[105,104,103,102,101].map(x=>row(x))}),p=f.run(round(root,{roundLimit:2,dailyBudget:300}));assert.equal(p.status,0,p.stderr);assert.equal(p.summary.addedRecords,2);assert.equal(p.summary.incomplete,true);const next=f.run(round(root,{roundLimit:2,dailyBudget:300}));assert.equal(next.summary.addedRecords,0);assert.equal(next.summary.billing.estimatedCredits,0);assert.equal(require(process.cwd()+'/lib/incremental').readState(f.dir,'sent',uid).anchor,'100');
}));
test('a legacy CLI limit above 100 cannot return more than 100 combined rows',()=>fixture(root=>{
 const sent=Array.from({length:90},(_,i)=>row(190-i));
 const received=Array.from({length:90},(_,i)=>row(290-i,'received'));
 const f=withEngine(root,{sent,received}),r=round(root,{mode:'both',kinds:['sent','received'],roundLimit:250,dailyBudget:3000});
 const config=validate({uid,mode:'both',interval:15,roundLimit:r.roundLimit,dailyBudget:3000});
 assert.equal(config.roundLimit,100);
 const run=f.run(r);
 assert.equal(run.status,0,run.stderr);
 assert.equal(run.summary.billing.returnedRecords,100);
 assert.equal(run.summary.billing.estimatedCredits,300);
 assert.equal(run.summary.incomplete,true);
 assert.deepEqual(store.read(store.roundFile(root,r.id)).requests.map(q=>[q.kind,q.count]),[['sent',1],['sent',49],['received',1],['received',49]]);
 assert.equal(store.read(store.roundFile(root,r.id)).requests.reduce((n,q)=>n+q.returned,0),100);
}));
test('missing since_id metadata, missing price and missing baseline stop before a content call',()=>{
 for(const cfg of [{unsupported:true},{unknownPrice:true}])fixture(root=>{const f=withEngine(root,cfg);if(cfg.missingBaseline)fs.rmSync(path.join(f.dir,'cache'),{recursive:true});const p=f.run(round(root));assert.equal(p.status,1);assert.equal(f.contentCalls().length,0);assert.ok(p.events.some(e=>e.type==='autoSafety'));});
});
test('ignored since_id is a safety pause, not a fallback or another direction fetch',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(100)],received:[row(201,'received')],ignoreSince:true}),p=f.run(round(root,{mode:'both',kinds:['sent','received']}));assert.equal(p.status,1,p.stderr);assert.equal(p.summary.autoStop.code,'AUTO_SINCE_IGNORED');assert.equal(f.contentCalls().length,1);assert.equal(p.summary.addedRecords,0);assert.equal(require(process.cwd()+'/lib/incremental').readState(f.dir,'sent',uid).anchor,'100');
}));
test('independent directions each check once, while an unresolved original request and both fee reservations are never resent or cleared',()=>fixture(root=>{
 const f=withEngine(root,{fail:'IP_GEO_DENIED'}),r=round(root,{mode:'both',kinds:['sent','received']}),p=f.run(r);assert.equal(p.status,1);
 assert.deepEqual(f.contentCalls().map(a=>a[1]),['by_me/other','to_me/other'],'one failed direction cannot suppress the other direction\'s own check');
 const original=store.read(store.roundFile(root,r.id));assert.deepEqual(original.requests.map(q=>[q.kind,q.count,q.status,q.reservedCredits,q.actualCredits]),[['sent',1,'unknown',3,null],['received',1,'unknown',3,null]]);
 const journal=require('../lib/request-journal'),evidence=new Map([store.roundFile(root,r.id),...original.requests.flatMap(q=>journal.subscriptionRequests(f.dir,r.id,q.id))].map(file=>[file,fs.readFileSync(file)]));
 const nextRound=round(root),next=f.run(nextRound);assert.equal(next.status,1);assert.equal(f.contentCalls().length,2,'the original task has neither finished evidence nor independent recovery authority');assert.equal(store.read(store.roundFile(root,nextRound.id)).requests.length,0);assert.equal(next.summary.autoStop.code,'AUTO_OUTCOME_UNKNOWN');
 for(const[file,bytes]of evidence)assert(fs.readFileSync(file).equals(bytes),'original request and fee evidence remain byte-for-byte unchanged');assert.equal(store.usage(root,uid,original.requests[0].day).reservedCredits,6);
}));
test('atomic reservations are bounded by price and balance; cache/replay has no reservation',()=>fixture(root=>{
 let at=Date.parse('2026-10-29T12:00:00Z');const r=round(root,{dailyBudget:5}),g=store.createBudget(root,r.id,{now:()=>at});g.configure(new Map([['sent',command()]]),{initialBalance:4});assert.equal(g.maxCount('sent',20),1);const id=g.reserve('sent',1,'100','');assert.equal(store.usage(root,uid,store.localDay(at,r.timeZone)).reservedCredits,3);g.settle(id,{raw:{comments:[]},file:'cache.json',responseHash:'hash'});assert.equal(store.usage(root,uid,store.localDay(at,r.timeZone)).committed,0);assert.equal(g.maxCount('sent',20),1);at+=86400000;assert.equal(store.usage(root,uid,store.localDay(at,r.timeZone)).committed,0);
}));
test('wake preserves healthy frequency and failure backoff, checks overdue directions once, and cannot enable a user-paused target after reopen',()=>fixture(root=>{
 let at=Date.parse('2026-10-29T12:00:00Z'),busy=true;const launched=[],s=createAutoFollow(root,{now:()=>at,random:()=>0,setTimer:()=>null,isBusy:()=>busy,launch:r=>launched.push(r)});s.save({uid,mode:'both',interval:15,roundLimit:10,dailyBudget:30,enabled:true});
 at+=2000;s.tick();assert.equal(launched.length,0);busy=false;s.tick();assert.equal(launched.length,1);s.tick();assert.equal(launched.length,1);
 const healthy=kind=>({kind,failed:false,update:{caughtUp:true}});s.finish(launched[0].id,{summary:{addedRecords:0,incomplete:false,billing:{initialBalance:100,finalBalance:100},sources:['sent','received'].map(healthy)}});
 const clocks=structuredClone(s.snapshot().entries[0].directionRetry);assert.equal(Date.parse(clocks.sent.nextRetryAt),at+15*60000);assert.equal(Date.parse(clocks.received.nextRetryAt),at+15*60000);
 s.wake();at+=1000;s.tick();assert.equal(launched.length,1,'wake cannot replace a not-yet-due normal direction clock');assert.deepEqual(s.snapshot().entries[0].directionRetry,clocks);
 at+=3*3600000;s.wake();s.tick();assert.equal(launched.length,1,'an overdue wake schedules one check after its short dispatch delay');at+=1000;s.tick();assert.equal(launched.length,2);assert.deepEqual(launched[1].kinds,['sent','received']);for(let n=0;n<5;n++){s.wake();s.tick();}assert.equal(launched.length,2,'missed polling intervals never become concurrent or repeated checks');
 s.finish(launched[1].id,{code:1,summary:{addedRecords:0,incomplete:true,autoStop:{code:'AUTO_REQUEST_FAILED'},billing:{initialBalance:100,finalBalance:100},sources:[{kind:'sent',failed:true},healthy('received')]}});
 const retries=structuredClone(s.snapshot().entries[0].directionRetry);assert.equal(retries.sent.attempts,1);assert.equal(Date.parse(retries.sent.nextRetryAt),at+60000);assert.equal(retries.received.attempts,0);assert.equal(Date.parse(retries.received.nextRetryAt),at+15*60000);
 s.wake();at+=1000;s.tick();assert.equal(launched.length,2,'wake cannot shorten a failed direction\'s persisted backoff');assert.deepEqual(s.snapshot().entries[0].directionRetry,retries);
 at=Date.parse(retries.sent.nextRetryAt)+1;s.tick();assert.equal(launched.length,3);assert.deepEqual(launched[2].kinds,['sent']);assert.deepEqual(launched[2].deferredKinds,['received']);s.tick();assert.equal(launched.length,3);
 s.pause(uid);assert.ok(fs.existsSync(store.roundFile(root,launched[2].id)+'.stop'));s.finish(launched[2].id,{summary:{addedRecords:0,incomplete:true,autoStop:{code:'AUTO_YIELD'},billing:{initialBalance:100,finalBalance:100}}});s.close();s.release();
 const reopened=createAutoFollow(root,{now:()=>at,setTimer:()=>null,launch:()=>assert.fail('paused user must not launch')});at+=12*3600000;reopened.wake();reopened.tick();assert.equal(reopened.snapshot().entries[0].enabled,false);assert.equal(reopened.snapshot().entries[0].nextCheckAt,null);assert.equal(reopened.snapshot().entries[0].reason,'由用户暂停');reopened.close();reopened.release();
}));
test('daily exhaustion waits for reset; interruption can be resumed without reconciling unknown costs',()=>fixture(root=>{
 let at=Date.parse('2026-10-29T12:00:00Z'),job;const s=createAutoFollow(root,{now:()=>at,setTimer:()=>null,launch:r=>job=r});s.save({uid,mode:'sent',interval:5,roundLimit:2,dailyBudget:3,enabled:true});at+=2000;s.tick();let r=store.read(store.roundFile(root,job.id));r.requests=[{day:store.localDay(at,r.timeZone),status:'estimated',returned:1,estimatedCredits:3,reservedCredits:3}];store.atomic(store.roundFile(root,r.id),r);s.finish(r.id,{summary:{addedRecords:1,incomplete:true,billing:{initialBalance:100,finalBalance:97},autoStop:{code:'AUTO_DAILY_BUDGET'}}});assert.equal(s.snapshot().entries[0].status,'budget-paused');assert.ok(Date.parse(s.snapshot().entries[0].nextCheckAt)>at+60000);s.close();s.release();
 const pending=round(root);pending.requests=[{day:store.localDay(at,pending.timeZone),status:'reserved',reservedCredits:3}];store.atomic(store.roundFile(root,pending.id),pending);const reopened=createAutoFollow(root,{now:()=>at,setTimer:()=>null});assert.equal(reopened.snapshot().entries[0].enabled,true);assert.equal(reopened.snapshot().entries[0].status,'attention-required');assert.doesNotThrow(()=>reopened.save({uid,mode:'sent',interval:5,roundLimit:2,dailyBudget:3,enabled:true}));reopened.close();reopened.release();
}));
test('no actual-cost label is derived from a balance delta, unknown debit or price estimate',()=>fixture(root=>{
 let at=Date.now(),job;const s=createAutoFollow(root,{now:()=>at,setTimer:()=>null,launch:r=>job=r});s.save({uid,mode:'sent',interval:5,roundLimit:2,dailyBudget:30,enabled:true});at+=2000;s.tick();s.finish(job.id,{summary:{addedRecords:0,incomplete:false,billing:{initialBalance:100,finalBalance:97}}});const e=s.snapshot().entries[0];assert.equal(e.status,'waiting');assert.equal(e.enabled,true);assert.equal(e.billingNotice,true);assert.equal(e.today.actualCredits,null);assert.equal(e.lastBalanceDifference,3);s.close();s.release();
}));
test('failed and unverified attempts preserve per-direction success and last saved new comments',()=>fixture(root=>{
 let at=Date.parse('2026-11-10T12:00:00Z');const jobs=[],engine=withEngine(root),scheduler=createAutoFollow(root,{now:()=>at,random:()=>0,setTimer:()=>null,launch:r=>jobs.push(r)});
 const persisted={coreSaved:true},state=()=>scheduler.snapshot().entries[0];
 function start(){at=Math.max(at+2000,Date.parse(state().nextCheckAt)||0);scheduler.tick();return jobs.at(-1);}
 function checked(job,kind){
  const r=store.read(store.roundFile(root,job.id));
  r.requests.push({id:crypto.randomUUID(),kind,status:'estimated',returned:0,file:'cache/example.json',hash:'a'.repeat(64),estimatedCredits:0,day:store.localDay(at,r.timeZone)});
  store.atomic(store.roundFile(root,r.id),r);
  return {kind,update:{caughtUp:true}};
 }
 try{
  scheduler.save({uid,mode:'both',interval:1,roundLimit:10,dailyBudget:30,enabled:true});
  const first=start(),sent=checked(first,'sent');
  scheduler.finish(first.id,{code:1,summary:{persistence:persisted,incomplete:true,sources:[sent,{kind:'received',failed:true}]}});
  const good=state().lastCheckAt;assert.deepEqual(state().successfulChecks,{sent:good});assert.equal(state().lastNewAt,undefined);
  const failure=start();scheduler.finish(failure.id,{code:1,summary:{persistence:persisted,incomplete:true,sources:[{kind:'received',failed:true}]}});
  assert.notEqual(state().lastCheckAt,good);assert.deepEqual(state().successfulChecks,{sent:good});
  const unverified=start();scheduler.finish(unverified.id,{summary:{persistence:persisted,sources:[{kind:'received',update:{caughtUp:true}}]}});
  assert.deepEqual(state().successfulChecks,{sent:good});assert.equal(state().lastNewAt,undefined);
  let restored=start();
  if(!restored.kinds.includes('received')){scheduler.finish(restored.id,{summary:{persistence:persisted,sources:[]}});restored=start();}
  assert(restored.kinds.includes('received'));
  save(engine.conf,{balance:1000,sent:[],received:[row(201,'received')],price:3});
  const result=engine.run(restored,{at});assert.equal(result.status,0,result.stderr);assert.equal(result.summary.addedRecords,1);
  scheduler.finish(restored.id,{summary:result.summary});assert.equal(state().lastNewCount,1);assert.equal(state().lastNewAt,state().lastCheckAt);
  assert.equal(state().successfulChecks.received,state().lastCheckAt);
 }finally{scheduler.close();scheduler.release();}
}));
function client(root){const {spawn}=require('node:child_process'),{createInterface}=require('node:readline'),child=spawn(process.execPath,[path.join(root,'desktop/bridge.js'),'--workspace',root],{stdio:['pipe','pipe','pipe']}),events=[],waiters=[];let stderr='';child.stderr.on('data',d=>stderr+=d);createInterface({input:child.stdout}).on('line',line=>{const e=JSON.parse(line);events.push(e);for(const item of [...waiters])if(item.p(e)){clearTimeout(item.timer);waiters.splice(waiters.indexOf(item),1);item.resolve(e);}});return {child,events,send:m=>child.stdin.write(JSON.stringify(m)+'\n'),wait:p=>new Promise((resolve,reject)=>{const found=events.find(p);if(found)return resolve(found);const item={p,resolve,timer:setTimeout(()=>reject(Error('timeout '+stderr+' '+JSON.stringify(events.slice(-10)))),12000)};waiters.push(item);}),async close(){child.stdin.end();if(child.exitCode==null)await new Promise(resolve=>child.once('close',resolve));}};}
test('real bridge simulation gives manual work priority after saving the current request; no concurrent updates or auto HTML',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-auto-bridge-'));let c;try{const f=withEngine(root,{sent:[103,102,101].map(x=>row(x)),delay:700});save(path.join(root,'node_modules/@weibo-ai/weibo-cli/dist/index.js'),fs.readFileSync(path.join(root,'mock-cli.js'),'utf8'));c=client(root);await c.wait(e=>e.type==='library');c.send({action:'followSave',settings:{uid,mode:'sent',interval:15,roundLimit:100,dailyBudget:300,enabled:true}});await c.wait(e=>e.type==='started'&&e.automatic);const until=Date.now()+6000;while(!fs.existsSync(f.calls)||!f.contentCalls().length){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
 c.send({action:'run',query:{target:uid,mode:'comments-sent',policy:'database',limit:'2'}});await c.wait(e=>e.type==='manualQueued');const autoDone=await c.wait(e=>e.type==='finished'&&e.automatic),manualStarted=await c.wait(e=>e.type==='started'&&!e.automatic);assert.ok(c.events.indexOf(autoDone)<c.events.indexOf(manualStarted));const manualDone=await c.wait(e=>e.type==='finished'&&!e.automatic&&e.kind==='collect');assert.equal(manualDone.code,0);assert.equal(f.contentCalls().length,1);const snapshots=c.events.filter(e=>e.type==='followState'&&e.entries?.[0]?.lastCheckAt);assert.equal(snapshots.at(-1).entries[0].pending,true);assert.equal(snapshots.at(-1).entries[0].lastAdded,1);const output=path.join(root,'output/user-comments/目标');assert.equal(fs.readdirSync(output).filter(n=>n.endsWith('.html')).length,1,'only the explicit manual local report generates HTML');
 }finally{if(c)await c.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('abnormal process exit during a request preserves unknown fee evidence and reopening does not restart paid checks',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-auto-exit-'));let c;try{const f=withEngine(root,{sent:[row(101)],delay:2500});save(path.join(root,'node_modules/@weibo-ai/weibo-cli/dist/index.js'),fs.readFileSync(path.join(root,'mock-cli.js'),'utf8'));c=client(root);await c.wait(e=>e.type==='library');c.send({action:'followSave',settings:{uid,mode:'sent',interval:5,roundLimit:10,dailyBudget:300,enabled:true}});await c.wait(e=>e.type==='started'&&e.automatic);const until=Date.now()+6000;while(!fs.existsSync(f.calls)||!f.contentCalls().length){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}const automatic=c.events.find(e=>e.type==='started'&&e.automatic);process.kill(-automatic.pid,'SIGKILL');const stopped=new Promise(resolve=>c.child.once('close',resolve));c.child.kill('SIGKILL');await stopped;c=null;assert.ok(['reserved','unknown'].includes(store.rounds(root)[0].requests[0].status));const count=f.contentCalls().length;c=client(root);const state=await c.wait(e=>e.type==='followState');assert.equal(state.entries[0].enabled,true);assert.equal(state.entries[0].status,'attention-required');await new Promise(r=>setTimeout(r,1200));assert.equal(f.contentCalls().length,count);assert.ok(!c.events.some(e=>e.type==='started'));
 }finally{if(c)await c.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('uninterpretable execution billing remains unknown even with valid returned rows',()=>fixture(root=>{
 const r=round(root),g=store.createBudget(root,r.id);g.configure(new Map([['sent',command()]]),{initialBalance:100});const id=g.reserve('sent',1,'100','');assert.equal(g.settle(id,{raw:{comments:[row(101)],outcome:'billing-pending'}}).unverified,true);assert.equal(store.read(g.file).requests[0].status,'unknown');assert.equal(g.maxCount('sent',1),1);assert.equal(store.read(g.file).requests[0].returned,1);
}));
test('an ambiguous empty window never turns into a supposedly free automatic history scan',()=>fixture(root=>{
 const f=withEngine(root);let source=fs.readFileSync(path.join(root,'mock-cli.js'),'utf8');source=source.replace("next_cursor_str:cfg.placeholderZero?'0':all[n]?.idstr||'0'","next_cursor_str:undefined");save(path.join(root,'mock-cli.js'),source);const p=f.run(round(root));assert.equal(p.status,0,p.stderr);assert.equal(p.summary.autoStop.code,'AUTO_EMPTY_UNKNOWN');assert.equal(f.contentCalls().length,1);assert.equal(p.summary.incomplete,true);assert.equal(require(process.cwd()+'/lib/incremental').readState(f.dir,'sent',uid).anchor,'100');
}));
test('a second application cannot overwrite a running owner, and wake cannot resurrect a paused user',()=>fixture(root=>{
 let at=Date.now();const first=createAutoFollow(root,{now:()=>at,setTimer:()=>null});first.save({uid,mode:'sent',interval:5,roundLimit:10,dailyBudget:30,enabled:true});const second=createAutoFollow(root,{now:()=>at,setTimer:()=>null,launch:()=>assert.fail('stale enabled state must not run')});assert.throws(()=>second.pause(uid),/另一应用/);first.pause(uid);second.wake();assert.equal(store.read(path.join(store.directory(root),'settings.json')).entries[0].enabled,false);first.close();first.release();second.wake();at+=60000;second.tick();assert.equal(second.snapshot().entries[0].enabled,false);second.close();second.release();
}));

test('valid pending-billing responses save records and continue normally without a billing pause',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]});let code=fs.readFileSync(path.join(root,'mock-cli.js'),'utf8');code=code.replace('comments:items,next_cursor_str:',"comments:items,billing:{status:'pending'},next_cursor_str:");save(path.join(root,'mock-cli.js'),code);const p=f.run(round(root));assert.equal(p.status,0,p.stderr);assert.equal(p.summary.addedRecords,1);assert.ok(p.summary.billing.unknownRequests>0);assert.ok(require(process.cwd()+'/lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has('101'));assert.equal(require(process.cwd()+'/lib/incremental').readState(f.dir,'sent',uid).pending,null);
}));
test('actual service failures still pause the scheduler while historical fees do not block re-enabling',()=>fixture(root=>{
 let now=Date.now(),job;const s=createAutoFollow(root,{now:()=>now,setTimer:()=>null,launch:r=>job=r});s.save({uid,mode:'sent',interval:5,roundLimit:10,dailyBudget:300,enabled:true});now+=2000;s.tick();const value=store.read(store.roundFile(root,job.id));value.requests=[{day:store.localDay(now,value.timeZone),status:'unknown',reservedCredits:3}];store.atomic(store.roundFile(root,job.id),value);s.finish(job.id,{code:1,reason:'IP_GEO_DENIED'});assert.equal(s.snapshot().entries[0].status,'attention-required');assert.equal(s.snapshot().entries[0].enabled,true);s.save({uid,mode:'sent',interval:5,roundLimit:10,dailyBudget:300,enabled:true});assert.equal(s.snapshot().entries[0].enabled,true);s.pause(uid);s.close();s.release();
}));

test('subscription checks only the newest 100 rows and never buys the rest on later empty polls',()=>fixture(root=>{
 const f=withEngine(root,{sent:Array.from({length:150},(_,i)=>row(250-i)),placeholderZero:true});
 const I=require('../lib/incremental'),archive=()=>require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records;
 const a=f.run(round(root,{roundLimit:100,dailyBudget:1000}));
 assert.equal(a.status,0,a.stderr);assert.equal(a.summary.newRecords,100);assert.equal(a.summary.billing.estimatedCredits,300);
 const before=I.readState(f.dir,'sent',uid);assert.equal(before.anchor,'100');assert.ok(before.pending);
 assert.deepEqual(f.contentCalls().map(c=>c[c.indexOf('--count')+1]),['1','99']);
 assert.equal(f.contentCalls()[1][f.contentCalls()[1].indexOf('--max_id')+1],'249');
 const saved=JSON.parse(fs.readFileSync(f.conf));saved.sent=[row(251),...saved.sent];save(f.conf,saved);
 const next=f.run(round(root,{roundLimit:100,dailyBudget:1000}));
 assert.equal(next.status,0,next.stderr);assert.equal(next.summary.addedRecords,1);assert.equal(next.summary.billing.estimatedCredits,3);
 const quiet=f.run(round(root,{roundLimit:100,dailyBudget:1000}));
 assert.equal(quiet.summary.newRecords,0);assert.equal(quiet.summary.billing.estimatedCredits,0);
 assert.deepEqual(f.contentCalls().slice(2).map(c=>[c[c.indexOf('--since_id')+1],c.includes('--max_id')]),[['250',false],['251',false]]);
 assert.deepEqual(I.readState(f.dir,'sent',uid).pending,before.pending);
 assert.equal(archive().size,103);assert.ok(archive().has('151'));assert.ok(!archive().has('150'));
}));

test('normal application exit waits for the in-flight response, preserves its body and estimate, and starts no second request',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-auto-graceful-'));let c;
 try{
  const f=withEngine(root,{sent:[row(101)],delay:900});save(path.join(root,'node_modules/@weibo-ai/weibo-cli/dist/index.js'),fs.readFileSync(path.join(root,'mock-cli.js'),'utf8'));
  c=client(root);await c.wait(e=>e.type==='library');c.send({action:'followSave',settings:{uid,mode:'sent',interval:5,roundLimit:10,dailyBudget:300,enabled:true}});await c.wait(e=>e.type==='started'&&e.automatic);
  const until=Date.now()+6000;while(!fs.existsSync(f.calls)||!f.contentCalls().length){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10));}
  await c.close();c=null;const round=store.rounds(root)[0];assert.equal(round.requests.length,1);assert.equal(round.requests[0].status,'estimated');assert.equal(round.requests[0].returned,1);assert.equal(round.requests[0].estimatedCredits,3);
  assert.ok(require('../lib/completeness').loadIndependentArchive(f.dir,'sent',uid).records.has('101'));assert.equal(f.contentCalls().length,1);
  c=client(root);const state=await c.wait(e=>e.type==='followState');assert.equal(state.entries[0].enabled,true);assert.equal(state.entries[0].status,'waiting');await new Promise(r=>setTimeout(r,1200));assert.equal(f.contentCalls().length,1);assert.ok(!c.events.some(e=>e.type==='started'));
 }finally{if(c)await c.close();fs.rmSync(root,{recursive:true,force:true});}
});

// Legacy manual reads could cover N complete records but with older missing
// bodies leave no subscription checkpoint. Reuse their hash-bound latest proof.
function incompleteInitial(f,kind='received',edit=()=>{}){
 const I=require('../lib/incremental'),D=require('../lib/data-update'),taskId=crypto.randomUUID(),scope=crypto.randomUUID(),head=kind==='sent'?'100':'200';
 fs.rmSync(I.stateFile(f.dir,kind),{force:true});
 const envelope={schema:1,query:{uid,kind,count:3,maxId:'',sinceId:'',page:1,taskId},savedAt:'2026-10-28T00:00:00Z',response:{comments:[row(Number(head),kind),row(Number(head)-1,kind)],next_cursor_str:'0',miss_count:1,miss_ids:[String(Number(head)-2)]}};
 const file=path.join(f.dir,'cache/request-journal',crypto.randomUUID()+'.response.json');
 const journal={schema:1,id:taskId,uid,kind,checkpointToken:'absent',anchor:'',head,deltaComplete:true,phase:'body',status:'pending',scope:{from:'',to:''},ownerScopes:[scope],startedAt:'2026-10-28T00:00:00Z',selectedIds:[head,String(Number(head)-1)],gapIds:[String(Number(head)-2)],packets:[]};
 const ref={envelope:true,uid,kind,page:1,count:3,maxId:'',sinceId:'',file:path.relative(f.dir,file)};journal.packets=[ref];
 const input={journal,envelope,ref,scope,dated:false};edit(input);const bytes=Buffer.from(JSON.stringify(envelope));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);ref.hash=crypto.createHash('sha256').update(bytes).digest('hex');
 const journalFile=D.progressFile(f.dir,kind,{beforeMs:input.dated?Date.parse('2026-01-01T00:00:00Z'):null,taskScopeId:scope});save(journalFile,journal);
 return {file,journalFile,bytes:fs.readFileSync(journalFile),head};
}
test('subscription recovers a verified latest head despite older missing bodies; sent/received run independently and no-delta recheck is free',()=>fixture(root=>{
 const f=withEngine(root,{received:[row(201,'received')]}),proof=incompleteInitial(f),p=f.run(round(root,{mode:'both',kinds:['sent','received']}));
 assert.equal(p.status,0,p.stderr);assert.equal(p.summary.addedRecords,1);assert.equal(p.summary.billing.estimatedCredits,3);assert.equal(p.summary.billing.returnedRecords,1);
 const calls=f.contentCalls();assert.deepEqual(calls.map(a=>[a[1],a[a.indexOf('--count')+1],a[a.indexOf('--since_id')+1]]),[['by_me/other','1','100'],['to_me/other','1','200']]);
 const I=require('../lib/incremental'),state=I.readState(f.dir,'received',uid);assert.equal(state.anchor,'201');assert.equal(state.scope.olderHistoryComplete,false);assert.equal(state.baselineScope,'verified-latest-head');assert.deepEqual(state.baselineRecovery.missingIds,['198']);assert.deepEqual(fs.readFileSync(proof.journalFile),proof.bytes,'historical pending range remains intact');assert.ok(require('../lib/completeness').loadIndependentArchive(f.dir,'received',uid).records.has('201'));
 const again=f.run(round(root,{mode:'both',kinds:['sent','received']}));assert.equal(again.status,0,again.stderr);assert.equal(again.summary.addedRecords,0);assert.equal(again.summary.billing.estimatedCredits,0);assert.equal(f.contentCalls().length,calls.length+2);assert.ok(f.contentCalls().slice(calls.length).every(a=>a[a.indexOf('--count')+1]==='1'));
}));
test('a resumed scheduler leaves the false baseline pause after local proof recovery, without discarding history or budgets',()=>fixture(root=>{
 const f=withEngine(root),proof=incompleteInitial(f);let now=Date.parse('2026-10-29T12:00:00Z'),job;
 const s=createAutoFollow(root,{now:()=>now,setTimer:()=>null,launch:r=>job=r});try{
  s.save({uid,mode:'both',interval:15,roundLimit:10,dailyBudget:300,enabled:true});now+=2000;s.tick();const p=f.run(job);assert.equal(p.status,0,p.stderr);s.finish(job.id,{summary:p.summary,code:p.status});
  const entry=s.snapshot().entries[0];assert.equal(entry.enabled,true);assert.equal(entry.status,'waiting');assert.ok(Date.parse(entry.nextCheckAt)>now);assert.equal(entry.dailyBudget,300);assert.equal(entry.lastReturned,0);assert.deepEqual(fs.readFileSync(proof.journalFile),proof.bytes);
 }finally{s.close();s.release();}
}));
for(const [label,edit]of [
 ['date-scoped journal',v=>v.dated=true],['foreign direction',v=>v.ref.kind='sent'],['foreign request UID',v=>v.envelope.query.uid='9999999999'],['foreign task',v=>v.envelope.query.taskId=crypto.randomUUID()],['missing head body',v=>v.envelope.response.comments[0].text=''],['unexplained missing count',v=>v.envelope.response.miss_count=2],['missing at or above head',v=>v.envelope.response.miss_ids=['201']],['disconnected prior range',v=>v.journal.anchor='150'],['selected point is not response head',v=>v.journal.head='199']

])test('an untrusted old head is retained; only well-formed old evidence permits a new independent baseline: '+label,()=>fixture(root=>{
 const f=withEngine(root),proof=incompleteInitial(f,'received',edit),p=f.run(round(root,{mode:'received',kinds:['received']})),invalid=['foreign direction','foreign request UID','foreign task','disconnected prior range','selected point is not response head'].includes(label);
 assert.equal(p.status,1);assert.equal(f.contentCalls().length,invalid?0:1);if(invalid)assert.ok(p.events.some(e=>e.type==='autoSafety'&&e.code==='REQUEST_EVIDENCE_INVALID'));else assert.equal(p.summary.incomplete,true);assert.equal(fs.existsSync(require('../lib/incremental').stateFile(f.dir,'received')),false);assert.deepEqual(fs.readFileSync(proof.journalFile),proof.bytes);
 if(!invalid)assert.ok(f.contentCalls().every(a=>a[a.indexOf('--count')+1]==='1'&&!a.includes('--since_id')&&!a.includes('--max_id')));
}));
test('damaged recovery response is never used as a success head or silently refreshed online',()=>fixture(root=>{
 const f=withEngine(root),proof=incompleteInitial(f);fs.appendFileSync(proof.file,' ');const p=f.run(round(root,{mode:'received',kinds:['received']}));assert.equal(p.status,1);assert.equal(f.contentCalls().length,0);assert.equal(fs.existsSync(require('../lib/incremental').stateFile(f.dir,'received')),false);
}));
test('recovery cannot overwrite an existing newer checkpoint or its pending interval',()=>fixture(root=>{
 const f=withEngine(root);incompleteInitial(f);const I=require('../lib/incremental'),file=I.stateFile(f.dir,'received'),state={schema:1,uid,kind:'received',anchor:'250',checkedAt:'2026-10-29T00:00:00Z',origin:'data-update-v1',endPolicyVersion:2,pending:{id:'pending',cursor:'260',head:'270',page:0,packets:[],since:true}};save(file,state);const before=fs.readFileSync(file);assert.equal(I.prepareUpdateState(f.dir,'received',uid).anchor,'250');assert.deepEqual(fs.readFileSync(file),before);
}));

test('several initial fragments retain the earliest certified head rather than skipping to a later larger ID',()=>fixture(root=>{
 const f=withEngine(root),older=incompleteInitial(f);incompleteInitial(f,'received',v=>{v.journal.head='500';v.journal.selectedIds=['500','499'];v.envelope.response.comments=[row(500,'received'),row(499,'received')];v.envelope.response.miss_ids=['498'];v.envelope.savedAt='2026-10-29T00:00:00Z';});
 const state=require('../lib/incremental').prepareUpdateState(f.dir,'received',uid);assert.equal(state.anchor,'200');assert.equal(state.baselineRecovery.journalFile,path.relative(f.dir,older.journalFile));assert.deepEqual(fs.readFileSync(older.journalFile),older.bytes);
}));

// Legacy reads sometimes had local bodies but no certified head, so their very
// first latest request carried a lower bound. The bound must match and be obeyed.
test('saved initial lower-bound response establishes the earliest safe future-check head without discarding older pending data',()=>fixture(root=>{
 const f=withEngine(root),proof=incompleteInitial(f,'received',v=>{v.journal.anchor='150';v.ref.sinceId='150';v.envelope.query.sinceId='150';});
 const I=require('../lib/incremental'),state=I.prepareUpdateState(f.dir,'received',uid);assert.equal(state.anchor,'200');assert.equal(state.scope.olderHistoryComplete,false);assert.deepEqual(fs.readFileSync(proof.journalFile),proof.bytes);assert.equal(state.pending,null);
}));
for(const [label,edit]of [
 ['mismatched initial lower bound',v=>v.ref.sinceId='140'],
 ['old response crosses its lower bound',v=>v.envelope.response.comments.push(row(140,'received'))],
 ['unfinished delta is not a completed initial scope',v=>{v.journal.phase='delta';v.journal.deltaComplete=false;}]
])test('lower-bound baseline rejects '+label,()=>fixture(root=>{
 const f=withEngine(root);incompleteInitial(f,'received',v=>{v.journal.anchor='150';v.ref.sinceId='150';v.envelope.query.sinceId='150';edit(v);});assert.equal(require('../lib/incremental').prepareUpdateState(f.dir,'received',uid),null);
}));
test('startup resolves a locally verifiable prerequisite pause without enabling a subscription or resetting fees and history',()=>fixture(root=>{
 const f=withEngine(root),proof=incompleteInitial(f,'received',v=>{v.journal.anchor='150';v.ref.sinceId='150';v.envelope.query.sinceId='150';});
 const config={uid,targetKind:'user',mode:'both',interval:15,roundLimit:100,dailyBudget:1000,frequency:'adaptive',profile:'balanced',enabled:false,status:'error-paused',reason:'收到的评论缺少可靠的增量基线，请先手动更新该方向',nextCheckAt:null,lastCheckAt:'2026-10-29T10:00:00Z',pending:true};save(path.join(store.directory(root),'settings.json'),{schema:1,entries:[config]});
 const roundId=crypto.randomUUID(),receipt={schema:1,id:roundId,uid,status:'failed',requests:[],reason:config.reason};save(store.roundFile(root,roundId),receipt);const bytes=fs.readFileSync(store.roundFile(root,roundId));const service=createAutoFollow(root,{setTimer:()=>null,launch:()=>assert.fail('local repair must not launch paid tracking')});try{const entry=service.snapshot().entries[0];assert.equal(entry.status,'paused');assert.equal(entry.enabled,false);assert.equal(entry.nextCheckAt,null);assert.equal(entry.dailyBudget,1000);assert.match(entry.reason,/已从保存/);assert.deepEqual(fs.readFileSync(proof.journalFile),proof.bytes);assert.deepEqual(fs.readFileSync(store.roundFile(root,roundId)),bytes);service.tick();assert.equal(service.active,null);}finally{service.close();service.release();}
}));
test('first manual acquisition of an unsubscribed user tracks new bodies before responses and exports unread with zero additional fetches',()=>fixture(root=>{
 const f=withEngine(root,{sent:[row(101)]}),p=spawnSync(process.execPath,[path.join(root,'weibo_cli.js'),uid,'comments-sent','--sync-only','--sync-operation','regular','--limit','1'],{cwd:root,env:{...process.env,WEIBO_DESKTOP_PROJECT:root,WEIBO_DESKTOP_CLI:path.join(root,'mock-cli.js'),WEIBO_DESKTOP_EVENTS:'1'},encoding:'utf8',stdio:['ignore','pipe','pipe','pipe']});assert.equal(p.status,0,p.stderr);const summary=String(p.output[3]).split('\n').filter(Boolean).map(JSON.parse).find(e=>e.type==='summary');assert.ok(summary.batchId);
 const inbox=require('../lib/follow-inbox'),initial=inbox.peek(root,uid);assert.ok(initial.initializedAt);const calls=f.contentCalls().length,service=createAutoFollow(root,{setTimer:()=>null});try{assert.equal(service.snapshot().entries.length,0);service.observe(summary);assert.equal(inbox.summary(root,uid).unread,1);const q={target:uid,mode:'comments-sent',limit:'1',markUnread:true},view=require('../desktop/local-view').createLocalView(root),out=view.exportCurrent(q);assert.equal(out.summary.unread,1);assert.equal(view.prepare(q).jobs[0].rows[0].isUnread,true);const access=require('../desktop/report-access').createReportAccess(root),ticket=access.open(out.files[0]);assert.equal(inbox.summary(root,uid).unread,1);assert.equal(access.opened(ticket.unreadTicket).changed,1);assert.equal(inbox.summary(root,uid).unread,0);service.observe(summary);assert.equal(inbox.summary(root,uid).unread,0);assert.equal(f.contentCalls().length,calls);}finally{service.close();service.release();}
}));
