'use strict';
// Reuse the ordinary archive merger, opening only original sources that can
// contain this latest window. The disposable ID index is solely a locator.
const C=require('./completeness'),fs=require('node:fs'),path=require('node:path');
function selectedExchange(dir,kind,uid,files){
 const E=require('./exchange-records'),schema=require('./exchange-schema'),root=E.folder(dir),entries=[],knownIds=new Set();
 for(const file of files){
  if(path.dirname(file)!==root||! /^[a-f0-9]{64}\.json$/.test(path.basename(file)))continue;
  const bytes=E.bytes(file),hash=path.basename(file,'.json');if(schema.hash(bytes)!==hash)throw Error('导入内容哈希损坏');
  const value=JSON.parse(bytes);if(value.owner?.kind!=='user'||value.owner.id!==uid||value.channel!==kind||!['packet','records'].includes(value.role))continue;
  entries.push({value,file,hash});for(const row of E.rowsOf(value))if(!row.isContext&&C.exactId(row.recordId))knownIds.add(row.recordId);
  const box=value.role==='packet'?require('./core').rawArray(value.response,kind)?.container:null;
  const missing=box?.miss_ids_str??box?.miss_ids;for(const id of Array.isArray(missing)?missing:[])if(C.exactId(id))knownIds.add(C.exactId(id));
 }
 let preferred={};try{preferred=JSON.parse(require('./regular-file').read(path.join(root,'preferred.json'))).records||{};}catch(error){if(error.code&&error.code!=='ENOENT')throw error;}
 return {[kind]:{knownIds,records:E.selectVersions(E.versionsFromEntries(entries,dir,kind,uid),preferred,kind)}};
}
function withinLowerBound(archive,lower){
 // A full-loader fallback has the same scope as a targeted read. Otherwise
 // switching loaders after a response makes old bodies appear newly saved.
 for(const id of archive.records.keys())if(BigInt(id)<=BigInt(lower))archive.records.delete(id);
 for(const id of archive.knownIds)if(BigInt(id)<=BigInt(lower))archive.knownIds.delete(id);
 return archive;
}
function load(dir,kind,uid,lower,session){
 const selected=require('./inventory-index').bodySourceCandidates(dir,{category:'user-comments',id:uid},kind,lower);
 if(!selected)return withinLowerBound(C.loadIndependentArchive(dir,kind,uid,session),lower);
 const empty=()=>({[kind]:{records:new Map(),knownIds:new Set(),warnings:[],session}});
 const preference=path.join(dir,'cache/exchange-v1/preferred.json'),stamp=()=>require('./file-view-cache').regularStamp(preference)?.signature,beforePreference=stamp();
 const archive=C.loadIndependentArchives(dir,[kind],uid,session,{
  source(file,role,build){return selected.files.has(file)?build:empty;},reusable(){return null;},
  exchange(){return selectedExchange(dir,kind,uid,selected.files);}
 })[kind];
 if(!selected.unchanged()||stamp()!==beforePreference)throw Object.assign(Error('订阅所需的本地来源在读取时变化，未继续请求'),{code:'LOCAL_VIEW_CHANGED'});
 // Older bodies are outside an exclusive since-bound. The original state,
 // missing-body journals and all skipped response bytes remain untouched.
 return withinLowerBound(archive,lower);
}
module.exports={load};
