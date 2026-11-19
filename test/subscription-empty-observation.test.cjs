'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,withEngine,uid,row,save}=require('./subscription-fixture.cjs');
const B=require('../lib/auto-follow-budget'),I=require('../lib/incremental'),J=require('../lib/request-journal');
const {createAutoFollow}=require('../desktop/auto-follow');

function setup(base,{both=false}={}){
 const engine=withEngine(base,{received:[206,205,204,203,202,201].map(id=>row(id,'received'))});
 const shim=path.join(base,'mock-cli.js'),original=fs.readFileSync(shim,'utf8');
 const inject=(raw,lastPage={comments:[],next_cursor_str:'0'})=>save(shim,original.replace("const since=flag('--since_id')",`if(kind==='received'){console.log(JSON.stringify(flag('--max_id')?${JSON.stringify(lastPage)}:${JSON.stringify(raw)}));process.exit();}const since=flag('--since_id')`));
 let at=Date.parse('2026-11-18T12:00:00Z'),service;
 const jobs=[],runs=[],create=()=>createAutoFollow(base,{now:()=>at,random:()=>0,setTimer:()=>null,launch:r=>{jobs.push(r);const result=engine.run(r,{at});runs.push(result);assert.equal(service.finish(r.id,{code:result.status,summary:result.summary,reason:result.stderr}).coreFailed,false);}});
 service=create();
 const entry=()=>service.snapshot().entries[0];
 return {engine,jobs,runs,inject,entry,get service(){return service;},get at(){return at;},
  start(){service.save({uid,mode:both?'both':'received',frequency:'fixed',interval:15,roundLimit:both?4:2,dailyBudget:3000,enabled:true},'enable');at+=1000;service.tick();},
  next(){const count=jobs.length;at=Date.parse(entry().nextCheckAt);service.tick();assert.equal(jobs.length,count+1);return runs.at(-1);},
  restore(){save(shim,original);},reopen(){service.close();service.release();service=create();},
  close(){service.close();service.release();}
 };
}
function artifact(name,entry){const dir=process.env.WEIBO_EMPTY_OBSERVATION_ARTIFACTS;if(dir)save(path.join(dir,name+'.json'),entry);}
const empty={comments:[],next_cursor_str:'208',miss_count:1,miss_ids_str:['209']};

for(const both of [false,true])test('empty latest subscription observation uses normal cadence without certifying the retained gap'+(both?' in both directions':''),()=>fixture(base=>{
 const h=setup(base,{both});
 try{
  h.start();assert.equal(h.runs[0].status,0,h.runs[0].stderr);
  const before=fs.readFileSync(I.stateFile(h.engine.dir,'received')),old=I.readState(h.engine.dir,'received',uid);
  assert(old.pending);const missingBefore=h.engine.contentCalls().length,lastNewAt=h.entry().lastNewAt;
  h.inject(empty);
  let proof;
  for(let n=0;n<2;n++){
   const result=h.next(),source=result.summary.sources.find(s=>s.kind==='received');
   assert.equal(result.status,0,result.stderr);assert.equal(source.update.noNewBodies,true);
   assert.equal(source.update.protection.latestComplete,true);assert.equal(source.update.protection.latestSucceeded,true);
   assert.equal(source.update.caughtUp,false);assert.equal(result.summary.addedRecords,0);
   assert.equal(result.summary.billing.estimatedCredits,0);assert.equal(result.summary.billing.unknownRequests,0);
   const entry=h.entry();assert.equal(entry.status,'waiting');assert.equal(entry.directionRetry.received.attempts,0);
   assert.equal(entry.directionRetry.received.code,'');assert.equal(Date.parse(entry.directionRetry.received.nextRetryAt),h.at+15*60000);
   assert(entry.successfulChecks?.received);assert.equal(entry.lastNewCount,2);assert.equal(entry.lastNewAt,lastNewAt);
   assert(entry.noNewKinds.includes('received'));assert.match(entry.reason,/待补区间/);assert.doesNotMatch(entry.reason,/暂无新增/);assert.equal(entry.recovery,undefined);
   assert.equal(entry.missingNotice.count,1);assert.equal(entry.missingBodyState,undefined,'counter IDs stay out of UI transport');
   assert.deepEqual(fs.readFileSync(I.stateFile(h.engine.dir,'received')),before);
   const round=B.read(B.roundFile(base,h.jobs.at(-1).id)),request=round.requests.find(q=>q.kind==='received');
   assert.equal(request.count,1);assert.equal(request.returned,0);assert.equal(request.status,'estimated');
   const [file]=J.subscriptionRequests(h.engine.dir,round.id,request.id),journal=B.read(file);
   assert.equal(journal.query.maxId,'');assert.equal(journal.query.sinceId,old.pending.head);
   const response=path.join(path.dirname(file),journal.responseFile);assert.deepEqual(B.read(response).response,empty);proof??={file:response,bytes:fs.readFileSync(response)};
   if(n===0){artifact(both?'both-empty':'empty',entry);h.reopen();assert.equal(h.entry().directionRetry.received.attempts,0);}
  }
  const calls=h.engine.contentCalls().slice(missingBefore);assert.equal(calls.length,both?6:4);
  assert(calls.every(args=>!args.includes('--max_id')||args[args.indexOf('--max_id')+1]==='208'),'only the same newest-window continuation is followed');
  assert.deepEqual(fs.readFileSync(proof.file),proof.bytes);
  const notice=h.entry().missingNotice;h.inject({...empty,next_cursor_str:'210',miss_ids_str:['211']});h.next();assert.equal(h.entry().missingNotice.count,2);artifact('concurrent-missing',h.entry());
  h.service.dismissMissing('user:'+uid,notice);assert.equal(h.entry().missingNotice.count,1);artifact('after-old-dismissal',h.entry());
  h.service.dismissMissing('user:'+uid,h.entry().missingNotice);assert.equal(h.entry().missingNotice,null);
  h.inject(empty);
  h.reopen();h.next();assert.equal(h.entry().missingNotice,null,'the same missing ID stays acknowledged after restart');
  h.inject({...empty,next_cursor_str:'212',miss_ids_str:['213']});h.next();assert.equal(h.entry().missingNotice.count,1);
  h.service.dismissMissing('user:'+uid,notice);assert.equal(h.entry().missingNotice.count,1,'a late old dismissal cannot clear the newer ID');
  h.service.dismissMissing('user:'+uid,h.entry().missingNotice);assert.equal(h.entry().missingNotice,null);
  h.restore();const cfg=JSON.parse(fs.readFileSync(h.engine.conf));cfg.received=[row(210,'received'),...cfg.received];save(h.engine.conf,cfg);
  const newer=h.next();assert.equal(newer.summary.addedRecords,1);assert.equal(newer.summary.billing.estimatedCredits,3);
  assert(require('../lib/completeness').loadIndependentArchive(h.engine.dir,'received',uid).records.has('210'));
  assert(require('../lib/follow-inbox').unreadIds(require('../lib/follow-inbox').view(base,uid)).has('210'));
  assert.deepEqual(fs.readFileSync(proof.file),proof.bytes);assert(I.readState(h.engine.dir,'received',uid).pending);
 }finally{h.close();}
}));

test('a later failed prerequisite clears the previous empty observation and retains recovery',()=>fixture(base=>{
 const h=setup(base);
 try{
  h.start();h.inject(empty);h.next();assert.deepEqual(h.entry().noNewKinds,['received']);
  const count=h.engine.contentCalls().length,cfg=JSON.parse(fs.readFileSync(h.engine.conf));cfg.balance=null;save(h.engine.conf,cfg);
  h.next();const entry=h.entry();assert.deepEqual(entry.noNewKinds,[]);assert.equal(entry.status,'retry-wait');
  assert.equal(h.engine.contentCalls().length,count);assert.doesNotMatch(entry.reason,/本轮暂无新增/);
 }finally{h.close();}
}));

test('an identified returned placeholder is an empty body, with one persistent distinct notice and ordinary polling',()=>fixture(base=>{
 const h=setup(base);
 try{
  h.start();h.inject({comments:[{...row(209,'received'),text:''}],next_cursor_str:'208'});
  for(let n=0;n<2;n++){
   const r=h.next(),source=r.summary.sources[0];assert.equal(r.status,0,r.stderr);assert.equal(source.failed,false);assert.equal(source.update.newCount,0);assert.equal(source.update.noNewBodies,true);
   assert.equal(h.entry().directionRetry.received.attempts,0);assert.equal(h.entry().missingNotice.count,1);assert.equal(r.summary.addedRecords,0);
  }
  h.service.dismissMissing('user:'+uid,h.entry().missingNotice);h.reopen();h.next();assert.equal(h.entry().missingNotice,null);
 }finally{h.close();}
}));

for(const [name,raw] of [
 ['missing cursor',{comments:[],miss_count:1,miss_ids_str:['209']}],
 ['malformed missing count',{comments:[],next_cursor_str:'208',miss_count:'invalid',miss_ids_str:['209']}],
 ['out-of-window missing ID',{comments:[],next_cursor_str:'208',miss_count:1,miss_ids_str:['207']}]
])test('empty subscription response still retries on '+name,()=>fixture(base=>{
 const h=setup(base);
 try{h.start();h.inject(raw);const result=h.next(),source=result.summary.sources[0];assert.notEqual(source.update.noNewBodies,true);assert.equal(h.entry().directionRetry.received.attempts,1);artifact('invalid-empty',h.entry());}
 finally{h.close();}
}));

test('a valid empty first page cannot hide contradictory evidence on the next page',()=>fixture(base=>{
 const h=setup(base);
 try{
  h.start();
  const count=h.engine.contentCalls().length;
  h.inject(empty,{comments:[],next_cursor_str:'0',miss_count:'invalid'});
  const result=h.next(),entry=h.entry(),source=result.summary.sources[0];
  assert.equal(source.stopCode,'DELTA_END_UNVERIFIED');
  assert.notEqual(source.update.noNewBodies,true);
  assert.deepEqual(entry.noNewKinds,[]);assert.equal(entry.directionRetry.received.attempts,1);
  assert.doesNotMatch(entry.reason,/暂无新增/);assert.equal(result.summary.billing.estimatedCredits,0);
  assert.equal(h.engine.contentCalls().length-count,2);
 }finally{h.close();}
}));
