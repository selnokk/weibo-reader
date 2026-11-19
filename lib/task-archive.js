'use strict';
// One authoritative multi-direction read under the collector's object lease.
// Revalidate source identities before reuse; this is not a continuity index.
const path=require('node:path'),C=require('./completeness'),V=require('./file-view-cache');
function create(dir,kinds,uid,session){
 const root=path.join(dir,'cache'),owner={category:'user-comments',id:uid},S=require('./inventory-sources');
 function manifest(){
  const files=V.manifest(root,{children:['request-journal','report-snapshots','exchange-v1'],strict:true}).files;
  const values=new Map();for(const f of files){const name=path.relative(root,f.file).split(path.sep).join('/'),role=S.sourceKind(name,owner);if(kinds.includes(role)||['receipt','snapshot','exchange'].includes(role)||name==='exchange-v1/preferred.json')values.set(f.file,{...f,role});}
  return {files:values,exchange:require('./exchange-store').signatureFor(dir)};
 }
 const before=manifest(),parts=C.loadIndependentArchives(dir,kinds,uid,session),after=manifest();
 const same=(a,b)=>a.exchange===b.exchange&&a.files.size===b.files.size&&[...a.files].every(([file,f])=>b.files.get(file)?.signature===f.signature);
 const stable=same(before,after),stats={scans:1,reuses:0};
 function load(folder,kind,target){
  if(path.resolve(folder)!==path.resolve(dir)||target!==uid||!kinds.includes(kind))throw Error('读取快照与当前目标或方向不匹配');
  const current=manifest();let reusable=stable&&current.exchange===before.exchange;
  if(reusable)for(const [file,f]of before.files){if(kinds.includes(f.role)&&f.role!==kind)continue;if(current.files.get(file)?.signature!==f.signature){reusable=false;break;}}
  if(reusable)for(const [file,f]of current.files){
   if(before.files.has(file)||kinds.includes(f.role)&&f.role!==kind)continue;
   if(f.role==='receipt')try{const box=session.read(file).raw;if(box.schema!==1||box.query?.uid!==uid||box.query.kind!==kind)continue;}catch{/* Recheck through the authoritative loader below. */}
   reusable=false;break;
  }
  if(reusable&&same(current,manifest())){stats.reuses++;return parts[kind];}
  stats.scans++;return C.loadIndependentArchive(dir,kind,uid,session);
 }
 return {load,stats};
}
module.exports={create};
