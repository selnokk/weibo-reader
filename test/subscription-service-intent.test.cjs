'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const B=require('../lib/auto-follow-budget'),J=require('../lib/request-journal'),I=require('../lib/incremental'),P=require('../lib/update-progress'),{createAutoFollow}=require('../desktop/auto-follow');
const {fixture,withEngine,uid,row,save}=require('./subscription-fixture.cjs');
function artifact(name,value,empty){const dir=process.env.WEIBO_SUBSCRIPTION_SERVICE_ARTIFACTS;if(dir){fs.mkdirSync(dir,{recursive:true});save(path.join(dir,name+'-'+(empty?'empty':'body')+'.json'),value);}}
const denial=JSON.stringify({success:false,error:{code:'IP_GEO_DENIED',message:'PRIVATE_REFUSAL_NOT_FOR_UI'}});
function baseline(dir,kind,head,at){const id=crypto.randomUUID(),raw={comments:[row(Number(head),kind)],next_cursor_str:'0'},a=J.begin(dir,{uid,kind,count:1,maxId:'',sinceId:'',page:1,taskId:id});J.receive(a,JSON.stringify(raw),'');const receipt=J.save(a,raw,''),ref={...receipt,file:path.relative(dir,receipt.file),count:1,maxId:'',sinceId:''},proof={schema:1,id,uid,kind,upper:head,lower:'',initial:true,packets:[ref],scopes:[id]},file=path.join(dir,'cache/update-connections',id+'.json');save(file,proof);save(I.stateFile(dir,kind),{schema:1,uid,kind,anchor:head,checkedAt:new Date(at-1000).toISOString(),endPolicyVersion:2,origin:'data-update-v1',pending:null,baselinePacket:ref,connection:{file:path.relative(path.join(dir,'cache'),file),hash:P.token(file)}});}
for(const empty of[false,true])test('service refusal retries in bounded independent windows; '+(empty?'empty':'body')+' recovery continues after restart without another enable',()=>fixture(base=>{
 const f=withEngine(base,{received:empty?[]:[row(200001,'received')],fail:denial});let at=Date.now()+10000,s;baseline(f.dir,'received','200000',at);const jobs=[],runs=[],launch=r=>{jobs.push(r);const p=f.run(r,{at});runs.push(p);s.finish(r.id,{code:p.status,summary:p.summary,reason:p.stderr});},create=()=>createAutoFollow(base,{now:()=>at,random:()=>0,setTimer:()=>null,launch});s=create();const next=()=>{at=Date.parse(s.snapshot().entries[0].nextCheckAt)+1;s.tick();};
 try{
  s.save({uid,mode:'received',frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,enabled:true},'enable');at+=2000;s.tick();assert.equal(jobs.length,1);let e=s.snapshot().entries[0];assert.equal(e.enabled,true);assert.equal(e.serviceBlocks.length,1);assert.equal(e.serviceBlocks[0].code,'IP_GEO_DENIED');assert.match(e.directionMessage,/收到评论请求被服务拒绝/);assert(!JSON.stringify(e).includes('PRIVATE_REFUSAL_NOT_FOR_UI'));artifact('denied',e,empty);const failed=jobs[0],old=fs.readFileSync(B.roundFile(base,failed.id)),requestFiles=J.subscriptionRequests(f.dir,failed.id,B.read(B.roundFile(base,failed.id)).requests[0].id),raw=new Map(requestFiles.map(file=>[file,fs.readFileSync(file)]));
  for(let n=0;n<2;n++){const expected=jobs.length+1;next();assert.equal(jobs.length,expected,'a later automatic window executes one new protected probe');const r=B.read(B.roundFile(base,jobs.at(-1).id));assert.equal(r.automaticRecovery.policy,'continuous-cli-v1');assert.equal(r.requests.length,1);assert.equal(r.requests[0].count,1);assert(r.requests[0].automaticRecovery);assert(r.requests[0].automaticRecovery.windowId===r.id);assert.notEqual(r.requests[0].automaticRecovery.taskId,B.read(requestFiles[0]).query.taskId);assert.equal(s.snapshot().entries[0].serviceRetry,undefined,'automatic recovery is not manufactured explicit intent');}
  e=s.snapshot().entries[0];artifact('blocked',e,empty);const deadline=e.directionRetry.received.nextRetryAt,attempts=e.directionRetry.received.attempts;s.close();s.release();s=create();assert.equal(s.snapshot().entries[0].directionRetry.received.nextRetryAt,deadline);assert.equal(s.snapshot().entries[0].directionRetry.received.attempts,attempts);const count=jobs.length;at+=1000;s.tick();assert.equal(jobs.length,count,'restart and early ticks cannot claim an extra probe');
  const cfg=JSON.parse(fs.readFileSync(f.conf));delete cfg.fail;save(f.conf,cfg);next();assert.equal(jobs.length,count+1);assert(runs.at(-1).summary.sources[0].update.protection?.latestSucceeded||runs.at(-1).summary.sources[0].update.caughtUp,'current independent response must really succeed even while old gaps remain partial');const recovered=B.read(B.roundFile(base,jobs.at(-1).id));assert(recovered.requests.every(q=>q.status==='estimated'&&q.file&&q.hash&&Number.isSafeInteger(q.returned)));assert.equal(s.snapshot().entries[0].directionRetry.received.attempts,0);assert.deepEqual(s.snapshot().entries[0].serviceBlocks,[]);artifact('restored',s.snapshot().entries[0],empty);
  s.close();s.release();s=create();const updated=JSON.parse(fs.readFileSync(f.conf));updated.received=[row(200002,'received'),...(empty?[]:[row(200001,'received')])];save(f.conf,updated);next();assert(runs.at(-1).summary.sources[0].update.protection?.latestSucceeded||runs.at(-1).summary.sources[0].update.caughtUp);assert(require('../lib/completeness').loadIndependentArchive(f.dir,'received',uid).records.has('200002'));assert.equal(s.snapshot().entries[0].enabled,true);assert.deepEqual(fs.readFileSync(B.roundFile(base,failed.id)),old);for(const [file,bytes]of raw)assert.deepEqual(fs.readFileSync(file),bytes);s.pause(uid);const calls=f.contentCalls().length;s.wake();s.tick();assert.equal(f.contentCalls().length,calls);assert.equal(s.snapshot().entries[0].enabled,false);
 }finally{s.close();s.release();}
}));

for(const fault of ['reserve','wire'])test('one subscription inspection shares restoration candidates and rechecks receipts before '+fault,()=>fixture(base=>{
 const f=withEngine(base,{fail:denial}),kind='received',head='200000';let at=Date.now()+10000,s;
 baseline(f.dir,kind,head,at);
 const jobs=[];let result;const launch=job=>{jobs.push(job);result=f.run(job,{at});s.finish(job.id,{code:result.status,summary:result.summary,reason:result.stderr});};
 s=createAutoFollow(base,{now:()=>at,random:()=>0,setTimer:()=>null,launch});
 const entry=()=>s.snapshot().entries[0],roundPath=()=>B.roundFile(base,jobs.at(-1).id);
 const next=()=>{const n=jobs.length;at=Date.parse(entry().nextCheckAt)+1;s.tick();assert.equal(jobs.length,n+1);return B.read(roundPath());};
 const change=changes=>save(f.conf,{...JSON.parse(fs.readFileSync(f.conf)),...changes});
 try{
  s.save({uid,mode:kind,frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,enabled:true},'enable');
  const denied=[];for(let n=0;n<3;n++){const r=next();assert.equal(r.requests[0].status,'unknown');denied.push(roundPath());}
  const originals=denied.map(file=>fs.readFileSync(file));change({fail:null,received:[row(200001,kind)]});
  const restored=next(),restoredRound=roundPath();assert.equal(restored.requests[0].returned,1);
  const inbox=require('../lib/follow-inbox'),unread=()=>inbox.unreadIds(inbox.view(base,uid));assert(unread().has('200001'));
  const R=require('../desktop/subscription-recovery'),V=require('../lib/file-view-cache'),S=require('../lib/subscription-service-proof'),manifest=V.manifest;
  const ledger=path.dirname(restoredRound),receipt=path.resolve(f.dir,restored.requests[0].file),wireBefore=f.contentCalls().length,inspectedEntry=entry();
  let ledgerScans=0,journalScans=0;
  V.manifest=(dir,...args)=>{if(dir===ledger)ledgerScans++;if(dir===J.folder(f.dir))journalScans++;return manifest(dir,...args);};
  try{
   const checked=R.inspect(base,inspectedEntry,f.dir);assert.equal(checked.unresolvedRanges.length,3);
   assert(checked.unresolvedRanges.every(q=>q.serviceRestored?.roundId===restored.id));
   assert.equal(ledgerScans,4);assert.equal(journalScans,2);
  }finally{V.manifest=manifest;}
  const rejection=S.rejection;
  for(const changed of [restoredRound,receipt]){
   const bytes=fs.readFileSync(changed);let count=0;
   S.rejection=(...args)=>{const proof=rejection(...args);if(proof&&++count===2)fs.appendFileSync(changed,' ');return proof;};
   try{assert.throws(()=>R.inspect(base,inspectedEntry,f.dir),{code:'REQUEST_EVIDENCE_INVALID'});assert.equal(count,3);assert.equal(f.contentCalls().length,wireBefore);}
   finally{S.rejection=rejection;fs.writeFileSync(changed,bytes);}
  }
  change({received:[row(200002,kind)]});
  const receiptBytes=fs.readFileSync(receipt);
  const target=path.join(base,'lib',fault==='reserve'?'auto-follow-budget.js':'request-journal.js'),bytes=fs.readFileSync(target),hit=path.join(base,'fault-hook.json');
  const inject=fault==='reserve'
   ?`{const start=module.exports.createBudget;module.exports.createBudget=(...args)=>{const b=start(...args),reserve=b.reserve;b.reserve=(...values)=>{const fs=require('fs');fs.writeFileSync(${JSON.stringify(hit)},JSON.stringify({roundId:b.job.id,requests:module.exports.read(b.file).requests.length}));fs.appendFileSync(${JSON.stringify(receipt)},' ');return reserve(...values);};return b;};}`
   :`{const original=module.exports.begin;module.exports.begin=(...args)=>{const result=original(...args),reservation=args[2];if(reservation){const fs=require('fs'),B=require('./auto-follow-budget'),round=B.read(B.roundFile(${JSON.stringify(base)},reservation.roundId));fs.writeFileSync(${JSON.stringify(hit)},JSON.stringify({...reservation,query:result.query,status:round.requests.find(q=>q.id===reservation.id)?.status}));fs.appendFileSync(${JSON.stringify(receipt)},' ');}return result;};}`;
  fs.appendFileSync(target,'\n'+inject+'\n');
  try{
   const attempt=next();assert(!attempt.automaticRecovery);assert.equal(f.contentCalls().length,wireBefore);
   const reached=JSON.parse(fs.readFileSync(hit)),source=result.summary?.sources[0],diagnostic=JSON.stringify({stderr:result.stderr,source});
   assert.equal(reached.roundId,attempt.id,diagnostic);
   if(fault==='reserve'){
    assert.equal(reached.requests,0);assert.deepEqual(attempt.requests,[],diagnostic);
    assert.equal(source.stopCode,'AUTO_OUTCOME_UNKNOWN',diagnostic);assert.match(source.reason,/原服务拒绝回执已变化|服务恢复正常响应证据已变化/);
   }else{
    assert.equal(reached.status,'reserved');assert.equal(attempt.requests.length,1,diagnostic);
    const request=attempt.requests[0];assert.equal(request.id,reached.id);assert.equal(request.wireOutcome,'not-sent');assert.equal(request.estimatedCredits,0);
    const [file]=J.subscriptionRequests(f.dir,attempt.id,reached.id),journal=B.read(file);
    assert.equal(journal.status,'not-sent');assert.equal(journal.notSent.code,'REQUEST_EVIDENCE_INVALID');assert.deepEqual(journal.query,reached.query);
    assert.equal(source.stopCode,'REQUEST_EVIDENCE_INVALID',diagnostic);assert.match(source.reason,/原始证据在发送前变化/);
   }
   assert.equal(I.readState(f.dir,kind,uid).anchor,'200001');assert.deepEqual([...unread()],['200001']);
  }finally{fs.writeFileSync(target,bytes);fs.writeFileSync(receipt,receiptBytes);}
  const continued=next();assert.equal(continued.requests[0]?.returned,1,JSON.stringify(result.summary?.sources));assert.equal(f.contentCalls().length,wireBefore+1);
  assert.equal(I.readState(f.dir,kind,uid).anchor,'200002');assert.deepEqual([...unread()].sort(),['200001','200002']);
  const archive=require('../lib/completeness').loadIndependentArchive(f.dir,kind,uid).records;
  for(const id of ['200001','200002'])assert.equal(archive.get(id).row.content,'独立评论 '+id);
  denied.forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),originals[i]));
 }finally{s.close();s.release();}
}));

for(const fault of ['', 'response-changed', 'wrong-direction', 'changed-before-wire'])test('dual subscription recovers after region refusal from verified empty latest responses'+(fault?' · '+fault:''),()=>fixture(base=>{
 const f=withEngine(base),anchors={sent:'100000',received:'200000'},kinds=Object.keys(anchors);
 let at=Date.now()+10000,s;
 for(const kind of kinds)baseline(f.dir,kind,anchors[kind],at);
 const jobs=[],runs=[],launch=job=>{jobs.push(job);const run=f.run(job,{at});runs.push(run);s.finish(job.id,{code:run.status,summary:run.summary,reason:run.stderr});};
 const create=()=>createAutoFollow(base,{now:()=>at,random:()=>0,setTimer:()=>null,launch});
 const entry=()=>s.snapshot().entries[0],current=()=>B.read(B.roundFile(base,jobs.at(-1).id));
 const next=()=>{at=Date.parse(entry().nextCheckAt)+1;const n=jobs.length;s.tick();assert.equal(jobs.length,n+1);return current();};
 const configure=changes=>{const cfg=JSON.parse(fs.readFileSync(f.conf));for(const [key,value] of Object.entries(changes)){if(value===undefined)delete cfg[key];else cfg[key]=value;}save(f.conf,cfg);};
 const originFiles=files=>new Map([...new Set(files)].map(file=>[file,fs.readFileSync(file)]));
 const assertFiles=files=>{for(const [file,bytes] of files)assert.deepEqual(fs.readFileSync(file),bytes);};
 const query=(round,q)=>JSON.parse(fs.readFileSync(J.subscriptionRequests(f.dir,round.id,q.id)[0])).query;
 s=create();
 try{
  s.save({uid,mode:'both',frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,enabled:true},'enable');
  const quiet=next();assert.equal(quiet.requests.length,2);assert(quiet.requests.every(q=>q.status==='estimated'&&q.returned===0));
  const quietProof=Object.fromEntries(kinds.map(kind=>{const checkpoint=I.readState(f.dir,kind,uid),connection=path.join(f.dir,'cache',checkpoint.connection.file),proof=JSON.parse(fs.readFileSync(connection));assert.equal(proof.lower,anchors[kind]);assert.equal(proof.upper,anchors[kind]);assert.equal(proof.packets.length,1);return [kind,{checkpoint,connection,proof,file:path.resolve(f.dir,proof.packets[0].file)}];}));
  const quietBytes=originFiles(Object.values(quietProof).flatMap(({connection,file})=>[connection,file,file.replace(/\.response\.json$/,'.request.json'),file.replace(/\.response\.json$/,'.received.json')]));
  const sentState=I.stateFile(f.dir,'sent'),retained={...quietProof.sent.checkpoint,baselineScope:'user-selected-latest-head',userSelectedHead:{head:'99999'}};
  save(sentState,retained);assert.equal(require('../lib/subscription-latest').safeLower(f.dir,'sent',uid),anchors.sent);
  configure({fail:denial});
  const denied=next();assert.deepEqual(denied.requests.map(q=>q.kind).sort(),kinds.slice().sort());assert(denied.requests.every(q=>q.status==='unknown'&&q.reservedCredits===3));
  const originalTasks=Object.fromEntries(denied.requests.map(q=>[q.kind,query(denied,q).taskId]));
  const deniedBytes=originFiles([B.roundFile(base,denied.id),...denied.requests.flatMap(q=>J.subscriptionRequests(f.dir,denied.id,q.id).flatMap(file=>[file,file.replace(/\.request\.json$/,'.rejection.json')]))]);
  const pending=Object.fromEntries(kinds.map(kind=>[kind,I.readState(f.dir,kind,uid).pending]));
  if(fault==='response-changed')fs.appendFileSync(quietProof.sent.file,' ');
  if(fault==='wrong-direction'){
   const {connection,proof}=quietProof.sent;
   save(connection,{...proof,packets:[{...quietProof.received.proof.packets[0],sinceId:anchors.sent}]});
   const current=I.readState(f.dir,'sent',uid);save(sentState,{...current,connection:{...current.connection,hash:P.token(connection)}});
  }
  if(fault==='changed-before-wire'){
   const target=path.join(base,'lib/request-journal.js'),ref=quietProof.sent.proof.packets[0].file;
   fs.appendFileSync(target,`\nlet emptyVerifications=0;const originalVerifier=module.exports.verifySavedResponse;\nmodule.exports.verifySavedResponse=(dir,ref)=>{if(ref.file===${JSON.stringify(ref)}&&++emptyVerifications===3)fs.appendFileSync(path.resolve(dir,ref.file),' ');return originalVerifier(dir,ref);};\n`);
  }
  s.close();s.release();s=create();
  configure({failKind:'sent',received:[row(200001,'received')]});
  const before=f.contentCalls().length,recover=next(),newCalls=f.contentCalls().slice(before);
  if(fault){
   assert.equal(newCalls.length,1,JSON.stringify({kind:recover.kinds,reason:recover.reason,stderr:runs.at(-1).stderr,events:runs.at(-1).events?.slice(-4),retry:entry().directionRetry}));assert.equal(newCalls[0][1],'to_me/other');
   const sent=recover.requests.filter(q=>q.kind==='sent');
   if(fault==='changed-before-wire'){assert.equal(sent.length,1);assert.equal(sent[0].wireOutcome,'not-sent');assert.equal(sent[0].estimatedCredits,0);}
   else assert.equal(sent.length,0);
   assert.deepEqual(entry().requestedKinds,['received']);assert.equal(entry().directionRetry.sent.code,'REQUEST_EVIDENCE_INVALID');
   assert.match(entry().directionMessage,/发出评论未请求：等待核对本地请求证据/);assert.doesNotMatch(entry().directionMessage,/请求被服务拒绝/);
   assert.equal(I.readState(f.dir,'received',uid).anchor,'200001');assert.deepEqual(I.readState(f.dir,'sent',uid).pending,pending.sent);assertFiles(deniedBytes);
   for(const file of fault==='wrong-direction'?[quietProof.sent.connection]:[quietProof.sent.file])quietBytes.delete(file);
   assertFiles(quietBytes);return;
  }
  assert.equal(newCalls.length,2,JSON.stringify(runs.at(-1).summary?.sources));
  assert.deepEqual(recover.automaticRecovery.kinds.slice().sort(),kinds.slice().sort());
  assert.deepEqual(recover.requests.map(q=>[q.kind,q.returned??null,q.count,q.sinceId]).sort(),[['received',1,1,anchors.received],['sent',null,1,anchors.sent]]);
  for(const q of recover.requests){assert.equal(q.automaticRecovery.windowId,recover.id);assert.notEqual(query(recover,q).taskId,originalTasks[q.kind]);}
  assert.deepEqual(I.readState(f.dir,'sent',uid).pending,pending.sent);
  assert.equal(I.readState(f.dir,'received',uid).anchor,'200001');assert.equal(entry().directionRetry.received.attempts,0);assert(entry().directionRetry.sent.attempts>0);
  assertFiles(quietBytes);assertFiles(deniedBytes);
  configure({fail:undefined,failKind:undefined,sent:[row(100001)],received:[row(200002,'received')]});
  for(let n=0;n<5&&(I.readState(f.dir,'sent',uid).anchor!=='100001'||I.readState(f.dir,'received',uid).anchor!=='200002');n++)next();
  assert.equal(I.readState(f.dir,'sent',uid).anchor,'100001');assert.equal(I.readState(f.dir,'received',uid).anchor,'200002');
  assert.deepEqual(entry().serviceBlocks,[]);assert.equal(entry().enabled,true);assert(kinds.every(kind=>entry().directionRetry[kind].attempts===0));
  const inbox=require('../lib/follow-inbox'),unread=()=>inbox.unreadIds(inbox.view(base,uid)),archive=kind=>require('../lib/completeness').loadIndependentArchive(f.dir,kind,uid).records;
  assert(unread().has('100001'));assert(unread().has('200001'));
  assert.equal(inbox.markRead(base,uid,['100001','200001']).changed,2);
  configure({sent:[row(100002)],received:[row(200003,'received')]});
  for(let n=0;n<5&&(!unread().has('100002')||!unread().has('200003'));n++)next();
  assert(unread().has('100002'));assert(unread().has('200003'));assert(!unread().has('100001'));assert(!unread().has('200001'));
  assert.equal(archive('sent').get('100002').row.content,'独立评论 100002');assert.equal(archive('received').get('200003').row.content,'独立评论 200003');
  assertFiles(quietBytes);assertFiles(deniedBytes);
 }finally{s.close();s.release();}
}));

test('an empty advancing response stays intact while the next window saves later replies',()=>fixture(base=>{
 const f=withEngine(base),latest=require('../lib/subscription-latest'),kind='sent',head='100000';
 const shim=path.join(base,'mock-cli.js'),marker='const scopedFailure=cfg.fail;',source=fs.readFileSync(shim,'utf8');assert(source.includes(marker));
 save(shim,source.replace(marker,'const cursor=cfg.emptyPages?.[flag("--max_id")];if(cursor){console.log(JSON.stringify({comments:[],next_cursor_str:cursor}));process.exit();}'+marker));
 let at=Date.now()+10000,s;baseline(f.dir,kind,head,at);
 const runs=[],jobs=[],launch=job=>{jobs.push(job);const result=f.run(job,{at});runs.push(result);s.finish(job.id,{code:result.status,summary:result.summary,reason:result.stderr});};
 const start=()=>createAutoFollow(base,{now:()=>at,random:()=>0,setTimer:()=>null,launch}),entry=()=>s.snapshot().entries[0];
 const checkpoint=()=>I.readState(f.dir,kind,uid),configure=cfg=>save(f.conf,{balance:100000,sent:[],received:[],price:3,...cfg});
 const next=()=>{at=Date.parse(entry().nextCheckAt)+1;const n=jobs.length;s.tick();assert.equal(jobs.length,n+1);return B.read(B.roundFile(base,jobs.at(-1).id));};
 s=start();
 try{
  s.save({uid,mode:kind,frequency:'fixed',interval:1,roundLimit:10,dailyBudget:3000,enabled:true},'enable');
  assert.equal(next().requests[0].returned,0);assert.equal(latest.safeLower(f.dir,kind,uid),head);
  configure({fail:denial,emptyPages:{'':'100010','100010':'100005'}});
  const empty=next();assert.deepEqual(empty.requests.map(q=>[q.maxId,q.returned]),[['',0],['100010',0],['100005',undefined]]);
  const pending=checkpoint().pending;assert.equal(pending.packets.length,2);assert.equal(pending.cursor,'100005');
  const paths=[B.roundFile(base,empty.id),...pending.packets.flatMap(ref=>{const file=path.resolve(f.dir,ref.file);return [file,file.replace(/\.response\.json$/,'.received.json'),file.replace(/\.response\.json$/,'.request.json')];})],kept=new Map(paths.map(file=>[file,fs.readFileSync(file)]));
  s.close();s.release();s=start();configure({sent:[row(100001)]});
  const before=f.contentCalls().length,recovered=next();assert.equal(f.contentCalls().length-before,1,JSON.stringify(runs.at(-1).summary));
  const fresh=recovered.requests[0];assert.equal(fresh.returned,1);assert.equal(fresh.sinceId,head);assert.equal(fresh.maxId,'');assert.notEqual(B.read(J.subscriptionRequests(f.dir,recovered.id,fresh.id)[0]).query.taskId,pending.id);
  assert.equal(checkpoint().pending,null);assert.equal(checkpoint().anchor,'100001');const preserved=checkpoint().supersededSubscriptionIntervals.at(-1);assert.deepEqual(B.read(path.join(f.dir,preserved.file)).originalState.pending,pending);
  configure({sent:[row(100002)]});const nextBefore=f.contentCalls().length,again=next();assert.equal(f.contentCalls().length-nextBefore,1);assert.equal(again.requests[0].returned,1);assert.equal(again.requests[0].sinceId,'100001');
  assert.equal(checkpoint().anchor,'100002');assert.equal(checkpoint().pending,null);assert.deepEqual(B.read(path.join(f.dir,preserved.file)).originalState.pending,pending);
  for(const [file,bytes] of kept)assert.deepEqual(fs.readFileSync(file),bytes);
  const inbox=require('../lib/follow-inbox'),ids=inbox.unreadIds(inbox.view(base,uid));assert(ids.has('100001'));assert(ids.has('100002'));
 }finally{s.close();s.release();}
}));
