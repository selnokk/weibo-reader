'use strict';
// Disposable local-display cache. The authoritative archive loader owns all
// body precedence; neither projection file can supply acquisition evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),v8=require('node:v8');
const views=require('./file-view-cache'),channels=['sent','received','mentions-comments','mentions-posts'];
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const dependencies=['completeness','core','comment-media','record-body','records','exchange-records','exchange-merge','record-quality','post-ownership','inventory-sources','local-archive-view'];
const hashes=Object.fromEntries(dependencies.map(name=>[name,digest(fs.readFileSync(require.resolve('./'+name)))]));
const version=overrides=>digest(process.versions.v8+'|'+dependencies.map(name=>overrides[name]||hashes[name]).join('|'));
const recentCandidates=require('./report-recent-candidates');
const implementation=digest(version({})+'|'+digest(fs.readFileSync(require.resolve('./report-recent-candidates'))));
// The previous native projections use the same normalization and precedence.
// Reuse their bound bytes when only the report's index-reading path changed.
const previousImplementation=version({
 completeness:'b67b8bf0ada31c9a6aeec90cb07c73cd3311305427a984b8db7d8cd53a0ecd22',
 'exchange-records':'8b73936ae61e97cb8d57608a76636a69dd50af269206eda9e813573898834970',
 'local-archive-view':'11b1e6c56246aaddf65aa3227289d8a9b51a2c19fb40c932fa985b08b400efa9'
});
const compatibleImplementations=new Set([implementation,previousImplementation]);
// These revisions only changed report projection reads or collection diagnostics.
for(const completeness of ['032724de924c6a8b9ae5c5d7afa842304efa501c241c78f082fb4299d58a668a','ff1d5424440970f18951cadc2b67f8bb607cc08cac8c485ed94f9c249d71881b']){
 for(const archiveView of ['be49d0f484922f3fd90edb39db09aae5b66c90a9904460aaf37da51c914b4b3f','cf156c95ed3f9de5d74fd93e95b349ba052dab7bec438a8668f660e3ddea1ff6','a1f06afd6b28ce04e7a62fe845926b90f55fb929f3a7ffc585e148811b4a1aad']){
  compatibleImplementations.add(version({completeness,'local-archive-view':archiveView}));
 }
}
const compatible=value=>compatibleImplementations.has(value);
const COLD_REPACK_CHANGED_SOURCES=32;
function manifestSignature(native,exchangeSignature){
 return digest([...native].map(([file,stamp])=>file+'\0'+stamp).join('\n')+'|'+exchangeSignature);
}
function create(base,dir,uid){
 let cached=null,compact=null,sourceHash='',sources=null,bodies={},metadata={},imported=null;
 const stats={builds:0,reuses:0,sourceReads:0,exchangeBuilds:0},owner=JSON.stringify([path.relative(base,dir),uid]);
 const file=path.join(dir,'cache/view-indexes/local-archive-v1.json'),sourceFile=path.join(dir,'cache/view-indexes/local-archive-sources-v1.bin.gz');
 const exchangeFile=path.join(dir,'cache/view-indexes/local-archive-exchange-v1.bin.gz');
 const resolvedFile=path.join(dir,'cache/view-indexes/local-archive-resolved-v1.bin.gz');
 function manifest(){
  const root=path.join(dir,'cache'),value=views.manifest(root,{children:['request-journal','report-snapshots','exchange-v1'],filter:/\.json$/,strict:true});
  const native=new Map(),exchanged=[];
  for(const f of value.files){
   const name=path.relative(root,f.file).split(path.sep).join('/');
   const role=require('./inventory-sources').sourceKind(name,{category:'user-comments',id:uid});
   if(role==='exchange'||name==='exchange-v1/preferred.json')exchanged.push(name+'\0'+f.signature);
   else if(role)native.set(f.file,f.signature);
  }
  const exchangeSignature=digest(exchanged.join('\n')+'|'+require('./exchange-store').signature(base));
  return {native,exchangeSignature,signature:manifestSignature(native,exchangeSignature)};
 }
 const valid=part=>channels.every(k=>Array.isArray(part?.[k]?.records)&&Array.isArray(part[k].knownIds)&&Array.isArray(part[k].warnings));
 const indexDigest=box=>digest(JSON.stringify([box.signature,box.exchangeSignature,box.sourceHash,box.channels]));
 const validReferences=part=>valid(part)&&channels.every(k=>part[k].records.every(e=>e[0]===bodies[e[1]]?.recordId&&require('./completeness').exactId(e[0])===e[0]&&metadata[e[2]]));
 const rowKeys=new WeakMap();
 function resolve(ref){
  const row=bodies[ref[1]];
  if(rowKeys.get(row)!==ref[1]){
   if(!require('./record-body').completeBody(row)||digest(JSON.stringify(row))!==ref[1])throw Error('本地来源正文校验失败');
   rowKeys.set(row,ref[1]);
  }
  return {row,...metadata[ref[2]]};
 }
 function hydrate(part,session){return Object.fromEntries(channels.map(k=>[k,{records:new Map(part[k].records.map(ref=>[ref[0],resolve(ref)])),knownIds:new Set(part[k].knownIds),warnings:part[k].warnings,session}]));}
 function replay(part){return Object.fromEntries(channels.map(k=>[k,{...part[k],resolve}]));}
 const read=require('./regular-file').read;
 function readPack(name,signature){
  try{
   const bytes=read(name,{maxBytes:64*1024*1024}),payload=bytes.subarray(65);
   if(bytes[64]!==10||bytes.subarray(0,64).toString()!==digest(payload))return null;
   const box=v8.deserialize(zlib.gunzipSync(payload,{maxOutputLength:128*1024*1024}));
   return box.schema===1&&box.owner===owner&&compatible(box.implementation)&&(signature===undefined||box.signature===signature)?box:null;
  }catch{return null;}
 }
 function writePack(name,signature,parts,basis){
  try{
   const pack=extra=>{
    const bytes=v8.serialize({schema:1,owner,implementation,signature,parts,basis:extra});
    if(bytes.length>128*1024*1024)return null;
    const compressed=zlib.gzipSync(bytes,{level:1});
    return compressed.length+65<=64*1024*1024?compressed:null;
   };
   // Keep the resolved rows usable when optional candidate history would put
   // an otherwise readable projection over the existing decoder limits.
   let payload=pack(basis);
   if(!payload&&basis?.recent)payload=pack({...basis,recent:undefined});
   if(!payload&&basis)payload=pack(undefined);
   if(!payload)return;
   require('./incremental').atomicText(name,Buffer.concat([Buffer.from(digest(payload)+'\n'),payload]));
  }catch{/* A disposable projection is optional. */}
 }
 function resolvedSignature(before){
  // A large archive may have many historical candidates per resolved record.
  // Bind the smaller projection to both support files and the raw manifest.
  try{
   const support=views.regularStamp(sourceFile),index=views.regularStamp(file);
   return support?.size>8*1024*1024&&index?digest(before.signature+'|'+support.signature+'|'+index.signature):null;
  }catch(error){
   if(error.code==='LOCAL_SOURCE_INVALID')return null;
   throw error;
  }
 }
 function readResolved(before,session,box){
  const signature=resolvedSignature(before),parts=signature&&box?.signature===signature?box.parts:null;
  if(!parts||!channels.every(k=>parts[k]?.records instanceof Map&&parts[k].knownIds instanceof Set&&Array.isArray(parts[k].warnings)))return null;
  return Object.fromEntries(channels.map(k=>[k,{...parts[k],session}]));
 }
 function writeResolved(before,data,recent){
  const signature=resolvedSignature(before);
  if(!signature)return;
  const parts=Object.fromEntries(channels.map(k=>{const {session,...part}=data[k];return [k,part];}));
  if(sources)recent=recentCandidates.capture(channels,data,sources,dir,resolve);
  const basis={native:before.native,exchangeSignature:before.exchangeSignature,recent};
  writePack(resolvedFile,signature,parts,basis);
  if(!sources)compact={signature,parts,basis};
 }
 function replayOverlaps(ids,recent,additions,before,session){
  const files=recentCandidates.sourcesFor(channels,recent,ids);
  if(!files)return null;
  for(const file of files.keys())if(!before.native.has(file))return null;
  for(const [file,part] of additions)files.set(file,part);
  const imported=exchange(before.exchangeSignature);
  const exchangeRows=Object.fromEntries(channels.map(kind=>{
   const records=new Map();
   for(const id of ids)if(imported[kind].records.has(id))records.set(id,imported[kind].records.get(id));
   return [kind,{knownIds:[],records}];
  }));
  // Enumerate the current filenames in canonical packet/receipt/snapshot order,
  // then apply the same imported-record precedence as for a full archive load.
  return require('./completeness').loadIndependentArchives(dir,channels,uid,session,{
   nativeFiles:new Set(files.keys()),source:name=>()=>files.get(name),reusable:()=>null,exchange:()=>exchangeRows
  });
 }
 // Only append-only changes can reuse the compact view. Replacements and
 // deletions can expose an older version, so always return to the full loader.
 function appendNativeSources(before,session,box){
  const basis=box?.basis;
  if(!(basis?.native instanceof Map)||basis.exchangeSignature!==before.exchangeSignature)return null;
  const count=before.native.size-basis.native.size;
  if(count<=0||count>COLD_REPACK_CHANGED_SOURCES)return null;
  for(const [name,stamp] of basis.native)if(before.native.get(name)!==stamp)return null;
  const previous={signature:manifestSignature(basis.native,basis.exchangeSignature)};
  const data=readResolved(previous,session,box);
  if(!data||channels.some(kind=>data[kind].warnings.length))return null;
  const added=new Set([...before.native.keys()].filter(name=>!basis.native.has(name)));
  const additions=new Map();
  const delta=require('./completeness').loadIndependentArchives(dir,channels,uid,session,{
   nativeFiles:added,onNativeSource:(file,part)=>additions.set(file,part)
  });
  if(additions.size!==added.size)return null;
  const overlaps=new Set();
  for(const kind of channels){
   if(delta[kind].warnings.length)return null;
   for(const id of delta[kind].records.keys())if(data[kind].records.has(id))overlaps.add(id);
  }
  if(overlaps.size){
   const replayed=replayOverlaps(overlaps,basis.recent,additions,before,session);
   if(!replayed)return null;
   for(const kind of channels)for(const id of overlaps){
    if(!delta[kind].records.has(id))continue;
    const entry=replayed[kind].records.get(id);
    if(!entry)return null;
    delta[kind].records.set(id,entry);
   }
  }
  for(const kind of channels){
   const {records,knownIds}=delta[kind];
   if(records.size){
    const combined=new Map(data[kind].records);
    for(const [id,entry] of records)combined.set(id,entry);
    data[kind].records=combined;
   }
   if(knownIds.size){
    const combined=new Set(data[kind].knownIds);
    for(const id of knownIds)combined.add(id);
    data[kind].knownIds=combined;
   }
  }
  if(manifest().signature!==before.signature||resolvedSignature(previous)!==box.signature){
   throw Object.assign(Error('本地数据正在变化，请稍后重新生成'),{code:'LOCAL_SNAPSHOT_BUSY'});
  }
  const recent=recentCandidates.extend(channels,basis.recent,additions,box.parts,data);
  return {channels:data,recent};
 }
 function exchange(signature){
  if(imported?.signature===signature)return imported.parts;
  const box=readPack(exchangeFile,signature);
  if(box&&channels.every(k=>box.parts?.[k]?.records instanceof Map&&box.parts[k].contexts instanceof Map&&box.parts[k].knownIds instanceof Set)){
   imported=box;
  }else{
   const parts=require('./exchange-records').projectUserArchive(dir,channels,uid);
   if(manifest().exchangeSignature!==signature)throw Object.assign(Error('本地导入数据正在变化，请稍后重新生成'),{code:'LOCAL_SNAPSHOT_BUSY'});
   stats.exchangeBuilds++;
   imported={signature,parts};
   writePack(exchangeFile,signature,parts);
  }
  return imported.parts;
 }
 function freeze(data){return Object.fromEntries(channels.map(k=>[k,{records:[...data[k].records].map(([id,e])=>{
  let key=rowKeys.get(e.row);
  if(!key){key=digest(JSON.stringify(e.row));rowKeys.set(e.row,key);}
  const {row,...meta}=e,m=digest(JSON.stringify(meta));bodies[key]??=row;metadata[m]??=meta;return [id,key,m];
 }),knownIds:[...data[k].knownIds],warnings:data[k].warnings}]));}
 function readSources(){
  if(sources)return true;
  sources={};bodies={};metadata={};
  if(!sourceHash)return false;
  try{
   const bytes=read(sourceFile,{maxBytes:128*1024*1024});
   if(digest(bytes)!==sourceHash)throw Error('本地来源索引校验失败');
   const box=v8.deserialize(zlib.gunzipSync(bytes,{maxOutputLength:256*1024*1024}));
   if(box.schema!==1||box.owner!==owner||!compatible(box.implementation)||!box.bodies||!box.sources||!box.metadata)throw Error('本地来源索引身份不匹配');
   bodies=box.bodies;metadata=box.metadata;
   if(!Object.values(metadata).every(e=>Number.isFinite(e.stamp)&&e.provenance&&typeof e.provenance.file==='string')||!Object.values(box.sources).every(s=>typeof s.signature==='string'&&['packet','receipt','snapshot'].includes(s.role)&&validReferences(s.part)))throw Error('本地来源索引无效');
   sources=box.sources;return true;
  }catch{sources={};bodies={};metadata={};return false;}
 }
 function readIndex(){
  const box=JSON.parse(read(file,{maxBytes:128*1024*1024}));
  if(box.schema!==5||!compatible(box.implementation)||box.owner!==owner||box.hash!==indexDigest(box)||!valid(box.channels)||!/^[a-f0-9]{64}$/.test(box.sourceHash||''))throw Error('本地正文索引无效');
  return box;
 }
 function snapshot(session){
  const before=manifest();if(cached?.signature===before.signature)return cached.channels;
  const cold=!sources;
  let resolvedPack;
  if(!sources&&resolvedSignature(before)){
   resolvedPack=compact||readPack(resolvedFile);
   const exact=readResolved(before,session,resolvedPack);
   const reads=session.stats.reads;
   const incremental=exact?null:appendNativeSources(before,session,resolvedPack);
   const resolved=exact||incremental?.channels;
   if(resolved){
    stats.reuses++;stats.sourceReads+=session.stats.reads-reads;
    if(!exact||!resolvedPack.basis)writeResolved(before,resolved,incremental?.recent);
    else compact=resolvedPack;
    cached={signature:before.signature,exchangeSignature:before.exchangeSignature,channels:resolved};
    return resolved;
   }
  }
  // Reload the durable baseline when an intervening append-only view cannot
  // handle a change. Its selected rows may differ from the candidate index.
  if(!sources){cached=null;compact=null;}
  if(!cached)try{
   const box=readIndex();
   sourceHash=box.sourceHash;if(!readSources()||!validReferences(box.channels))throw Error('本地正文索引引用无效');
   const channels=readResolved(box,session,resolvedPack)||hydrate(box.channels,session);
   cached={signature:box.signature,exchangeSignature:box.exchangeSignature,channels};stats.reuses++;
   if(cached.signature===before.signature){writeResolved(before,cached.channels);return cached.channels;}
  }catch{sources=null;sourceHash='';}
  const reusedSources=readSources();
  const next={},oldReads=session.stats.reads;
  let changedSources=0;
  const affected=Object.fromEntries(channels.map(kind=>[kind,new Set()]));
  function dirty(part){
   if(part)for(const kind of channels)for(const [id]of part[kind].records)affected[kind].add(id);
  }
  const data=require('./completeness').loadIndependentArchives(dir,channels,uid,session,{
   source(name,role,build){
    const relative=path.relative(dir,name),stamp=before.native.get(name),previous=sources[relative];
    if(stamp&&previous?.signature===stamp&&previous.role===role){next[relative]=previous;return ()=>replay(previous.part);}
    changedSources++;
    const part=build();
    if(!stamp||views.stamp(name)?.signature!==stamp)throw Object.assign(Error('本地数据正在变化，请稍后重新生成'),{code:'LOCAL_SNAPSHOT_BUSY'});
    const frozen=freeze(part);
    next[relative]={signature:stamp,role,part:frozen};
    dirty(previous?.part);dirty(frozen);
    return ()=>part;
   },
   exchange:()=>exchange(before.exchangeSignature),
   reusable(){
    if(!cached||cached.exchangeSignature!==before.exchangeSignature)return null;
    const retained=Object.keys(sources).filter(name=>next[name]===sources[name]);
    const order=Object.keys(next).filter(name=>next[name]===sources[name]);
    if(retained.some((name,i)=>name!==order[i]))return null;
    for(const [name,source]of Object.entries(sources))if(!next[name])dirty(source.part);
    return (kind,id)=>!affected[kind].has(id)&&cached.channels[kind].records.get(id);
   }
  });
  stats.sourceReads+=session.stats.reads-oldReads;stats.builds++;
  if(manifest().signature!==before.signature)throw Object.assign(Error('本地数据正在变化，请稍后重新生成'),{code:'LOCAL_SNAPSHOT_BUSY'});
  for(const name of Object.keys(sources))if(!next[name])changedSources++;
  // Keep the already verified durable base through small deltas across restarts.
  // Larger changes are compacted to keep cold catch-up work bounded.
  const writeIndex=cold&&(!reusedSources||changedSources>=COLD_REPACK_CHANGED_SOURCES);
  // Final selection and individual sources reference the same validated bodies.
  // Preserve both: a later source deletion may reveal an older retained version.
  sources=next;
  // Following an active subscription can change a few rows on every visit.
  // Keep those projections in memory. On the next cold load, the durable
  // index still supplies unchanged sources and only changed files are parsed.
  const saved=writeIndex?freeze(data):null,used=new Set(),metas=new Set();
  for(const part of [...(saved?[saved]:[]),...Object.values(sources).map(s=>s.part)])for(const k of channels)for(const e of part[k].records){used.add(e[1]);metas.add(e[2]);}
  bodies=Object.fromEntries(Object.entries(bodies).filter(([key])=>used.has(key)));metadata=Object.fromEntries(Object.entries(metadata).filter(([key])=>metas.has(key)));
  if(writeIndex)try{
   const bytes=zlib.gzipSync(v8.serialize({schema:1,owner,implementation,sources,bodies,metadata}),{level:1});
   // Write supporting projections first. A crash between replacements makes the
   // pair fail validation and rebuild offline; old raw data remains untouched.
   require('./incremental').atomicText(sourceFile,bytes);sourceHash=digest(bytes);
   const box={schema:5,implementation,owner,signature:before.signature,exchangeSignature:before.exchangeSignature,sourceHash,channels:saved};
   require('./update-progress').atomic(file,{...box,hash:indexDigest(box)});
   writeResolved(before,data);
  }catch(error){for(const k of channels)data[k].warnings.push('本地正文索引未能保存：'+error.message);}
  // A small cold delta leaves the large candidate pack intact. Refresh its
  // compact resolved view as well, so the next cold open need not deserialize
  // all historical candidates again. Bind it to the current raw manifest and
  // unchanged durable support, exactly as for a full rebuild.
  if(cold&&!writeIndex)writeResolved(before,data);
  cached={signature:before.signature,exchangeSignature:before.exchangeSignature,channels:data};return data;
 }
 function load(_dir,kind,_uid,session){
  if(_dir!==dir||_uid!==uid||!channels.includes(kind))throw Error('本地正文索引身份不匹配');
  return snapshot(session)[kind];
 }
 function contexts(){
  const parts=exchange(cached?.exchangeSignature??manifest().exchangeSignature);
  return channels.flatMap(k=>[...parts[k].contexts.values()].map(e=>e.row));
 }
 return {load,snapshot,contexts,stats};
}
module.exports={create};
