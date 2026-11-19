'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const M=require('../desktop/subscription-missing'),B=require('../lib/auto-follow-budget'),{createAutoFollow}=require('../desktop/auto-follow');
const {fixture,withEngine,uid,save}=require('./subscription-fixture.cjs');
const observed=ids=>[{kind:'received',update:{gap:{reportedIds:ids,unresolvedIds:ids}}}];
test('missing counters deduplicate across directions, restarts and acknowledgments; a late close preserves new IDs',()=>{
 const e={uid,targetKind:'user',source:'cli'};
 for(let n=0;n<100;n++)M.observe(e,[...observed(['209','209']),{kind:'sent',update:{gap:{reportedIds:['209'],unresolvedIds:['209']}}}]);
 const first=M.snapshot(e);assert.equal(first.count,1);
 M.observe(e,observed(['210']));assert.equal(M.snapshot(e).count,2);e.missingBodyState=M.dismiss(e,first);assert.equal(M.snapshot(e).count,1);
 e.missingBodyState=M.dismiss(e,M.snapshot(e));const restarted=JSON.parse(JSON.stringify(e));
 for(let n=0;n<100;n++)M.observe(restarted,observed(['209','210']));assert.equal(M.snapshot(restarted),null);
 M.observe(restarted,observed(['211']));assert.equal(M.snapshot(restarted).count,1);
 M.observe(restarted,[{kind:'received',update:{newRecordIds:['211']}}]);assert.equal(M.snapshot(restarted),null);
 assert.throws(()=>M.dismiss({...e,uid:'9876543210'},first));
 assert.throws(()=>M.dismiss(restarted,{...first,token:'0'.repeat(64)}));
});

test('closing a missing count persists only its acknowledgment and rolls back after a failed settings save',()=>fixture(base=>{
 withEngine(base);const e={uid,targetKind:'user',mode:'received',source:'cli',frequency:'fixed',interval:15,roundLimit:100,dailyBudget:3000,enabled:false,status:'paused',timeZone:'UTC'};
 M.observe(e,observed(['209']));save(path.join(B.directory(base),'settings.json'),{schema:1,entries:[e]});
 let s=createAutoFollow(base,{setTimer:()=>null,launch:()=>assert.fail('no subscription is enabled')});
 try{
  const before=s.snapshot().entries[0],notice=before.missingNotice;assert.equal(before.missingBodyState,undefined);
  const atomic=B.atomic;B.atomic=(file,...args)=>{if(file.endsWith('settings.json'))throw Object.assign(Error('simulated save failure'),{code:'ENOSPC'});return atomic(file,...args);};
  try{assert.throws(()=>s.dismissMissing('user:'+uid,notice),/simulated save failure/);assert.deepEqual(s.snapshot().entries[0].missingNotice,notice);}finally{B.atomic=atomic;}
  s.dismissMissing('user:'+uid,notice);assert.equal(s.snapshot().entries[0].missingNotice,null);
  assert.equal(s.snapshot().entries[0].enabled,false);assert.equal(s.snapshot().entries[0].dailyBudget,before.dailyBudget);
  s.close();s.release();s=createAutoFollow(base,{setTimer:()=>null});assert.equal(s.snapshot().entries[0].missingNotice,null);
 }finally{s.close();s.release();}
}));

test('a paused legacy subscription can close its seeded count before acquiring a scheduler lease',()=>fixture(base=>{
 withEngine(base);const e={uid,mode:'received',frequency:'fixed',interval:15,roundLimit:100,dailyBudget:3000,enabled:false,status:'paused',timeZone:'UTC',lastRoundId:'11111111-1111-4111-8111-111111111111',directions:observed(['209'])};
 save(path.join(B.directory(base),'settings.json'),{schema:1,entries:[e]});const s=createAutoFollow(base,{setTimer:()=>null});
 try{const notice=s.snapshot().entries[0].missingNotice;assert.equal(notice.count,1);s.dismissMissing('user:'+uid,notice);assert.equal(s.snapshot().entries[0].missingNotice,null);assert.equal(s.snapshot().entries[0].enabled,false);}
 finally{s.close();s.release();}
}));

test('actual bridge binds count dismissal to its workspace, typed owner and request; no service dispatch occurs',async()=>{
 const os=require('node:os'),base=fs.mkdtempSync(path.join(os.tmpdir(),'reader-missing-bridge-'));let service,bridge;
 try{
  withEngine(base);const e={uid,targetKind:'user',mode:'received',frequency:'fixed',interval:15,roundLimit:100,dailyBudget:3000,enabled:false,status:'paused',timeZone:'UTC'};M.observe(e,observed(['209']));save(path.join(B.directory(base),'settings.json'),{schema:1,entries:[e]});
  service=createAutoFollow(base,{setTimer:()=>null});const events=[];
  bridge=require('../desktop/bridge').runBridge({workspace:base,deferBootstrap:true,followService:service,send:e=>events.push(e),spawn:()=>assert.fail('must stay offline')});
  const notice=service.snapshot().entries[0].missingNotice;
  await bridge.handle({action:'followMissingDismiss',workspace:base+'-foreign',requestId:'foreign',uid,targetKind:'user',notice});
  assert(events.some(e=>e.type==='followError'&&e.requestId==='foreign'));assert.equal(service.snapshot().entries[0].missingNotice.count,1);
  await bridge.handle({action:'followMissingDismiss',workspace:base,requestId:'wrong-kind',uid,targetKind:'post',notice});assert.equal(service.snapshot().entries[0].missingNotice.count,1);
  await bridge.handle({action:'followMissingDismiss',workspace:base,requestId:'correct',uid,targetKind:'user',notice});
  assert.equal(service.snapshot().entries[0].missingNotice,null);
  assert(events.some(e=>e.type==='followMissingDismissed'&&e.uid===uid&&e.workspace===base&&e.requestId==='correct'));
  assert(events.some(e=>e.type==='localWriteState'&&e.requestId==='correct'&&e.busy===false));
 }finally{service?.close();service?.release();fs.rmSync(base,{recursive:true,force:true});}
});
