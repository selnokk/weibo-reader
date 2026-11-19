const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {harvestBefore}=require('../lib/history'),{sourceIncomplete}=require('../lib/limits'),{render}=require('../lib/reader'),{persistCollectionRun,loadIndependentArchive}=require('../lib/completeness'),{createCacheSession}=require('../lib/cache-session'),{historyIndex}=require('../lib/history');
const uid='1234567890';
const raw=(id,time='2026-10-28T00:00:00Z')=>({idstr:String(id),created_at:time,text:'记录 '+id,user:{idstr:uid,screen_name:'目标'},status:{idstr:'8888888888'}});
function temp(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-optimization-'));try{return fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
test('unknown dates cannot turn a two-record historical query into a completed one-record report',()=>temp(dir=>{
 const log=console.log;console.log=()=>{};let result;
 const options={uid,mode:'sent',count:2,pageSize:200,pages:Infinity,beforeMs:Date.parse('2026-10-29T23:59:59+08:00')};
 const calls=[];try{result=harvestBefore(options,dir,'sent',2,(_o,_d,_k,n,max)=>{calls.push({n,max});return {cached:false,raw:{comments:!max?[raw(200)]:max==='199'?[raw(199,'not-a-date')]:[],next_cursor_str:max?'0':'199'}};});assert.deepEqual(calls.map(c=>c.max),['','199','198']);assert.equal(calls.at(-1).n,1);}finally{console.log=log;}
 assert.equal(result.ended,true);assert.equal(result.rows.length,1);assert.deepEqual(result.unknownTimeIds,['199']);assert.equal(result.coverageUnverified,true);assert.equal(sourceIncomplete(result),true);
 assert.match(render(options,result.rows,[result],'目标'),/查询未完成/);
 const run=JSON.parse(fs.readFileSync(persistCollectionRun(dir,options,[result])));assert.equal(run.endpoints[0].result.status,'unverified');assert.equal(run.endpoints[0].result.incomplete,true);assert.deepEqual(run.endpoints[0].unknownTimeIds,['199']);
}));
test('archive and cursor index share one read, parse, normalization and hash per unchanged raw file',()=>temp(dir=>{
 const cache=path.join(dir,'cache');fs.mkdirSync(cache);let expected=0;
 for(const [name,data]of [['sent_c2_m0.json',{comments:[raw(200),raw(199)],next_cursor_str:'198'}],['sent_c1_m198.json',{comments:[raw(198)],next_cursor_str:'0'}]]){const bytes=JSON.stringify(data);expected+=Buffer.byteLength(bytes);fs.writeFileSync(path.join(cache,name),bytes);}
 const session=createCacheSession(),archive=loadIndependentArchive(dir,'sent',uid,session),index=historyIndex(dir,'sent',uid,true,{session});
 assert.equal(archive.records.size,3);assert.equal(index.records.size,3);assert.deepEqual(session.stats,{reads:2,bytes:expected,parses:2,hashes:2});
 const file=path.join(cache,'sent_c1_m198.json'),original=session.read(file),pending=file+'.tmp';fs.writeFileSync(pending,JSON.stringify({comments:[raw(197)]}));fs.renameSync(pending,file);
 const changed=session.read(file);assert.notEqual(changed.hash,original.hash);assert.equal(changed.raw.comments[0].idstr,'197');assert.equal(session.stats.reads,3);
 const another=createCacheSession();assert.equal(another.stats.reads,0,'separate tasks cannot inherit stale or other-user parsed responses');
}));

test('an interrupted audit save publishes no partial run and can be retried', () => temp(dir => {
 const options = {uid, mode:'sent', count:5};
 const rename = fs.renameSync;
 fs.renameSync = (from, to, ...args) => {
  if (path.dirname(to) === path.join(dir, 'cache/runs')) throw Object.assign(Error('磁盘空间不足'), {code:'ENOSPC'});
  return rename(from, to, ...args);
 };
 try {
  assert.throws(() => persistCollectionRun(dir, options, []), {code:'ENOSPC'});
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache/runs')), []);
 } finally { fs.renameSync = rename; }
 const file = persistCollectionRun(dir, options, []);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)).endpoints, []);
}));
