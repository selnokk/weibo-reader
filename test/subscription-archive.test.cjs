'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture,withEngine,uid,row,save}=require('./subscription-fixture.cjs'),C=require('../lib/completeness'),A=require('../lib/subscription-archive'),V=require('../lib/inventory-index'),S=require('../lib/cache-session');
test('the latest-window locator opens necessary original bodies with ordinary archive precedence',()=>fixture(base=>{
 const f=withEngine(base);save(path.join(f.dir,'cache/sent_c2_m105.json'),{comments:[row(105),row(104)]});
 const receipt=path.join(f.dir,'cache/request-journal',crypto.randomUUID()+'.response.json');save(receipt,{schema:1,query:{uid,kind:'sent'},response:{comments:[{...row(105),text:'original independent response'}]}});
 const owner={id:uid,category:'user-comments'};V.inventory(f.dir,owner,'sent');
 const expected=C.loadIndependentArchive(f.dir,'sent',uid),session=S.createCacheSession(),actual=A.load(f.dir,'sent',uid,'100',session);
 assert.deepEqual([...actual.records],[...expected.records].filter(([id])=>BigInt(id)>100n));assert.equal(actual.records.get('105').row.content,'original independent response');
 assert(session.stats.bytes<fs.readFileSync(receipt).length+4000);assert(!actual.records.has('100'));
 save(path.join(f.dir,'cache/sent_c1_m106.json'),{comments:[row(106)]});assert(A.load(f.dir,'sent',uid,'100',session).records.has('106'));
 const cache=JSON.parse(fs.readFileSync(V.file(f.dir)));cache.hash='0'.repeat(64);save(V.file(f.dir),cache);assert(A.load(f.dir,'sent',uid,'100',session).records.has('106'),'corrupt locator rebuilds from the original sources');
}));
test('the latest archive does not decode large unrelated historical packets on each check',()=>fixture(base=>{
 const f=withEngine(base);save(path.join(f.dir,'cache/sent_c1_m90.json'),{comments:[{...row(90),text:'old history '.repeat(100000)}]});
 V.inventory(f.dir,{category:'user-comments',id:uid},'sent');const session=S.createCacheSession(),actual=A.load(f.dir,'sent',uid,'100',session);
 assert.equal(actual.records.size,0);assert.equal(session.stats.reads,0);assert.equal(session.stats.bytes,0);
}));
test('the full-loader fallback retains the exact latest-window bound for bodies and missing IDs',()=>fixture(base=>{
 const f=withEngine(base);save(path.join(f.dir,'cache/sent_c4_m0.json'),{comments:[row(105),row(100),row(90)],miss_ids_str:['106','100','89']});
 const locate=V.bodySourceCandidates;V.bodySourceCandidates=()=>null;
 try{const actual=A.load(f.dir,'sent',uid,'100',S.createCacheSession());assert.deepEqual([...actual.records.keys()],['105']);assert.deepEqual([...actual.knownIds].sort(),['105','106']);}finally{V.bodySourceCandidates=locate;}
}));
test('a source change during targeted original reading blocks before acquisition',()=>fixture(base=>{
 const f=withEngine(base),file=path.join(f.dir,'cache/sent_c1_m105.json');save(file,{comments:[row(105)]});V.inventory(f.dir,{category:'user-comments',id:uid},'sent');
 const session=S.createCacheSession(),read=session.read;session.read=(name,...args)=>{const result=read(name,...args);if(name===file)save(file,{comments:[row(106)]});return result;};
 assert.throws(()=>A.load(f.dir,'sent',uid,'100',session),{code:'LOCAL_VIEW_CHANGED'});
}));

test('the latest archive verifies only relevant imported documents and retains the original version selector',()=>fixture(base=>{
 const f=withEngine(base),E=require('../lib/exchange-records'),core=require('../lib/core'),schema=require('../lib/exchange-schema'),files=[];
 for(const [id,text]of [[90,'historical imported '.repeat(50000)],[105,'new imported body']]){
  const value={schema:1,owner:{kind:'user',id:uid},channel:'sent',role:'records',savedAt:'2026-11-01T00:00:00Z',rows:[core.normalize({...row(id),text},'sent',uid)]},bytes=Buffer.from(JSON.stringify(value)),hash=schema.hash(bytes),file=path.join(f.dir,'cache/exchange-v1',hash+'.json');save(file,value);files.push(file);
 }
 V.inventory(f.dir,{category:'user-comments',id:uid},'sent');const expected=C.loadIndependentArchive(f.dir,'sent',uid),original=E.bytes,read=[];E.bytes=file=>{read.push(file);return original(file);};
 try{const actual=A.load(f.dir,'sent',uid,'100',S.createCacheSession());assert.deepEqual([...actual.records],[...expected.records].filter(([id])=>BigInt(id)>100n));assert(read.includes(files[1]));assert(!read.includes(files[0]));}finally{E.bytes=original;}
}));
