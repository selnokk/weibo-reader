'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture,withEngine,uid,row,save}=require('./subscription-fixture.cjs'),S=require('../lib/cache-session'),T=require('../lib/task-archive');
test('one task shares original archive reads while ignoring only newly saved receipts of another exact direction',()=>fixture(base=>{
 const f=withEngine(base),session=S.createCacheSession({maxBytes:1024*1024}),t=T.create(f.dir,['sent','received'],uid,session);
 assert.equal(t.load(f.dir,'sent',uid).records.size,2);
 const file=path.join(f.dir,'cache/request-journal',crypto.randomUUID()+'.response.json');
 save(file,{schema:1,query:{uid,kind:'sent'},response:{comments:[row(101)]},savedAt:new Date().toISOString()});
 assert.equal(t.load(f.dir,'received',uid).records.size,2);assert.equal(t.stats.scans,1);
 assert(t.load(f.dir,'sent',uid).records.has('101'));assert.equal(t.stats.scans,2);
 assert.throws(()=>t.load(f.dir,'sent','9876543210'));assert.throws(()=>t.load(path.dirname(f.dir),'sent',uid));
}));
test('source replacement, removal and newly received bodies invalidate that direction before its next use',()=>fixture(base=>{
 const f=withEngine(base),t=T.create(f.dir,['sent','received'],uid,S.createCacheSession());
 const file=path.join(f.dir,'cache/received_c2_m0.json');save(file,{comments:[{...row(200,'received'),text:'changed body'}]});
 assert.equal(t.load(f.dir,'received',uid).records.get('200').row.content,'changed body');
 fs.unlinkSync(file);assert.equal(t.load(f.dir,'received',uid).records.size,0);
 save(path.join(f.dir,'cache/received_c1_m0.json'),{comments:[row(201,'received')]});assert(t.load(f.dir,'received',uid).records.has('201'));
 assert.equal(t.stats.reuses,0);
}));
test('a source changed while a new peer receipt is inspected cannot escape the final snapshot recheck',()=>fixture(base=>{
 const f=withEngine(base),session=S.createCacheSession(),t=T.create(f.dir,['sent','received'],uid,session);
 const received=path.join(f.dir,'cache/received_c2_m0.json'),peer=path.join(f.dir,'cache/request-journal',crypto.randomUUID()+'.response.json');
 save(peer,{schema:1,query:{uid,kind:'sent'},response:{comments:[row(101)]}});
 const read=session.read;session.read=(file,...args)=>{const result=read(file,...args);if(file===peer)save(received,{comments:[{...row(200,'received'),text:'changed during peer inspection'}]});return result;};
 assert.equal(t.load(f.dir,'received',uid).records.get('200').row.content,'changed during peer inspection');assert.equal(t.stats.reuses,0);
}));
