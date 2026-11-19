'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,withEngine,uid,row,save,round}=require('./subscription-fixture.cjs');
const B=require('../lib/auto-follow-budget'),C=require('../lib/completeness');
const flag=(call,key)=>call.includes(key)?call[call.indexOf(key)+1]:'';
test('switching from a targeted archive to its full-loader fallback cannot announce old history as new unread',()=>fixture(base=>{
 const f=withEngine(base,{sent:[105,104,103,102,101].map(id=>row(id))});
 const first=f.run(round(base,{roundLimit:2}));assert.equal(first.status,0,first.stderr);assert.equal(first.summary.addedRecords,2);
 require('../lib/follow-inbox').ingest(base,uid,first.summary.batchId);require('../lib/follow-inbox').markRead(base,uid,['105','104']);
 const cfg=JSON.parse(fs.readFileSync(f.conf));cfg.sent=[107,106,105,104,103,102,101].map(id=>row(id));save(f.conf,cfg);
 const file=path.join(base,'lib/inventory-index.js');save(file,fs.readFileSync(file,'utf8').replace('function bodySourceCandidates(dir,owner,kind,lower){','let fixtureLocates=0;function bodySourceCandidates(dir,owner,kind,lower){if(++fixtureLocates>1)return null;'));
 const next=f.run(round(base));assert.equal(next.status,0,next.stderr);assert.equal(next.summary.billing.returnedRecords,2);assert.equal(next.summary.billing.estimatedCredits,6);assert.equal(next.summary.addedRecords,2);assert.equal(next.summary.records,2);
 const batch=require('../lib/database-sync').readBatch(f.dir,next.summary.batchId);assert.deepEqual(batch.newKeys.sort(),['comment:106','comment:107']);
 require('../lib/follow-inbox').ingest(base,uid,next.summary.batchId);assert.deepEqual([...require('../lib/follow-inbox').unreadIds(require('../lib/follow-inbox').load(base,uid))].sort(),['106','107']);
 const archive=C.loadIndependentArchive(f.dir,'sent',uid).records;for(const id of ['99','100','104','105','106','107'])assert(archive.has(id));
}));
for(const missing of [false,true])test('sparse latest pages continue within the same cap, including an empty body: '+missing,()=>fixture(base=>{
 const f=withEngine(base,{sent:Array.from({length:10},(_,i)=>({...row(110-i),...(missing&&i===2?{text:''}:{})}))});
 const shim=path.join(base,'mock-cli.js');save(shim,fs.readFileSync(shim,'utf8').replace('all.slice(0,n)','all.slice(0,Math.min(n,2))').replace("all[n]?.idstr","all[items.length]?.idstr"));
 const job=round(base),r=f.run(job);assert.equal(r.status,0,r.stderr);
 const calls=f.contentCalls();assert.equal(calls.length,6);assert.deepEqual(calls.map(a=>flag(a,'--max_id')),['','109','107','105','103','101']);assert(calls.every(a=>flag(a,'--since_id')==='100'));
 const archive=C.loadIndependentArchive(f.dir,'sent',uid).records;for(let id=101;id<=110;id++)assert.equal(archive.has(String(id)),!missing||id!==108);
 const source=r.summary.sources[0];assert.equal(source.failed,false);assert.equal(source.update.newCount,missing?9:10);assert.equal(source.update.caughtUp,true);
 assert.equal(B.read(B.roundFile(base,job.id)).requests.reduce((n,q)=>n+q.estimatedCredits,0),30);assert.equal(r.summary.addedRecords,missing?9:10);
 assert.equal(source.update.gap.unresolvedIds.includes('108'),missing);
}));

test('an empty page with a valid advancing cursor cannot conceal following complete comments',()=>fixture(base=>{
 const f=withEngine(base,{sent:[109,108,107].map(id=>row(id))}),shim=path.join(base,'mock-cli.js'),original=fs.readFileSync(shim,'utf8');
 save(shim,original.replace("const since=flag('--since_id')",`if(kind==='sent'&&!flag('--max_id')){console.log(JSON.stringify({comments:[],next_cursor_str:'109',miss_ids_str:['110'],miss_count:1}));process.exit();}const since=flag('--since_id')`));
 const job=round(base),r=f.run(job);assert.equal(r.status,0,r.stderr);assert.equal(r.summary.addedRecords,3);assert.equal(r.summary.billing.estimatedCredits,9);
 assert.deepEqual(f.contentCalls().map(a=>flag(a,'--max_id')),['','109','106']);const source=r.summary.sources[0];assert.equal(source.failed,false);assert.notEqual(source.update.noNewBodies,true);assert(source.update.gap.unresolvedIds.includes('110'));
 const archive=C.loadIndependentArchive(f.dir,'sent',uid).records;for(const id of ['109','108','107'])assert(archive.has(id));
}));

test('a proven not-sent local refusal rechecks the same page once without losing the middle or charging a duplicate',()=>fixture(base=>{
 const f=withEngine(base,{sent:[105,104,103,102,101].map(id=>row(id))}),file=path.join(base,'lib/auto-follow-budget.js'),original=fs.readFileSync(file,'utf8');
 save(file,original.replace('function validateAutomaticWire(requestId,query,context){',`let fixtureRefused=false;function validateAutomaticWire(requestId,query,context){if(query.maxId&&!fixtureRefused){fixtureRefused=true;throw safety('REQUEST_EVIDENCE_INVALID','isolated transient local proof refusal');}`));
 const job=round(base),r=f.run(job);assert.equal(r.status,0,r.stderr);assert.equal(r.summary.addedRecords,5);assert.equal(r.summary.billing.estimatedCredits,15);
 const requests=B.read(B.roundFile(base,job.id)).requests,refused=requests.find(q=>q.wireOutcome==='not-sent');assert(refused);assert.equal(refused.estimatedCredits,0);assert.equal(refused.returned,0);
 assert.deepEqual(f.contentCalls().map(a=>flag(a,'--max_id')),['','104']);for(const id of ['105','104','103','102','101'])assert(C.loadIndependentArchive(f.dir,'sent',uid).records.has(id));
}));

test('identified empty positions also bound a latest window instead of spending the remaining returns on older history',()=>fixture(base=>{
 const f=withEngine(base,{sent:Array.from({length:401},(_,i)=>row(501-i))}),shim=path.join(base,'mock-cli.js'),original=fs.readFileSync(shim,'utf8');
 save(shim,original.replace("const since=flag('--since_id')",`if(kind==='sent'&&flag('--max_id')==='500'){console.log(JSON.stringify({comments:[],next_cursor_str:'450',miss_count:50,miss_ids_str:Array.from({length:50},(_,i)=>String(500-i))}));process.exit();}const since=flag('--since_id')`));
 const job=round(base,{roundLimit:100,dailyBudget:3000}),r=f.run(job);assert.equal(r.status,0,r.stderr);
 assert.deepEqual(f.contentCalls().map(a=>[flag(a,'--count'),flag(a,'--max_id')]),[['1',''],['99','500'],['49','450']]);
 assert.equal(r.summary.addedRecords,50);assert.equal(r.summary.billing.estimatedCredits,150);const archive=C.loadIndependentArchive(f.dir,'sent',uid).records;assert(archive.has('402'));assert(!archive.has('401'));
 const next=f.run(round(base,{roundLimit:100,dailyBudget:3000}));assert.equal(next.summary.addedRecords,0);assert.equal(next.summary.billing.estimatedCredits,0);assert.equal(flag(f.contentCalls().at(-1),'--since_id'),'501');
}));

test('if the SDK fails after a not-sent recheck, its unknown outcome remains visible and is never retried again',()=>fixture(base=>{
 const f=withEngine(base,{sent:[row(105),row(104)]}),budget=path.join(base,'lib/auto-follow-budget.js'),shim=path.join(base,'mock-cli.js');
 save(budget,fs.readFileSync(budget,'utf8').replace('function validateAutomaticWire(requestId,query,context){',`let fixtureRefused=false;function validateAutomaticWire(requestId,query,context){if(query.maxId&&!fixtureRefused){fixtureRefused=true;throw safety('REQUEST_EVIDENCE_INVALID','isolated local refusal');}`));
 save(shim,fs.readFileSync(shim,'utf8').replace("const since=flag('--since_id')",`if(flag('--max_id')){console.log('invalid mock JSON');process.exit();}const since=flag('--since_id')`));
 const job=round(base),r=f.run(job),source=r.summary.sources[0];assert.equal(r.status,1);assert.equal(f.contentCalls().length,2);assert.equal(source.failed,true);assert.match(source.reason,/接口未返回有效 JSON/);
 const attempts=B.read(B.roundFile(base,job.id)).requests;assert.equal(attempts.length,3);assert.equal(attempts[1].wireOutcome,'not-sent');assert.equal(attempts[1].estimatedCredits,0);assert.equal(attempts[2].status,'unknown');assert.equal(attempts[2].reservedCredits,27);assert.equal(source.dataStatus.requestFailure.apiAttempt,true);assert.equal(source.dataStatus.requestFailure.billingUnknown,true);
}));
