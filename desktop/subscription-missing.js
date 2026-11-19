'use strict';
// Presentation counters only. Original response/gap evidence remains untouched.
const crypto=require('node:crypto'),identity=require('../lib/subscription-key'),{exactId}=require('../lib/completeness');
const source=e=>JSON.stringify([identity.key(e),e.source||'cli']);
const views=new WeakMap();
function view(state){let cached=views.get(state);if(!cached){if(!Array.isArray(state.ids)||!Array.isArray(state.resolved)||!Number.isSafeInteger(state.dismissed)||state.dismissed<0||state.dismissed>state.ids.length||typeof state.nonce!=='string'||!state.ids.every(id=>exactId(id)===id))return null;const seen=new Set(state.ids),resolved=new Set(state.resolved),count=state.ids.slice(state.dismissed).filter(id=>!resolved.has(id)).length;cached={seen,resolved,notice:count?{count,through:state.ids.length,token:token(state,state.ids.length)}:null};views.set(state,cached);}return cached;}
function observe(entry,sources,seed=false){
 if(entry.source&&entry.source!=='cli')return;
 let state=entry.missingBodyState;
 if(!state||state.schema!==1||state.source!==source(entry)||!view(state))state={schema:1,source:source(entry),nonce:seed?crypto.createHash('sha256').update(JSON.stringify([source(entry),entry.createdAt||'',entry.lastRoundId||''])).digest('hex'):crypto.randomUUID(),ids:[],resolved:[],dismissed:0};
 const cached=view(state);let seen=cached.seen,resolved=cached.resolved,changed=false;
 const change=()=>{if(!changed){seen=new Set(seen);resolved=new Set(resolved);changed=true;}};
 for(const s of sources||[]){
  const gap=s.update?.gap,unresolved=new Set(gap?.unresolvedIds||[]);
  for(const id of gap?.reportedIds??gap?.unresolvedIds??[]){
   if(exactId(id)!==id)continue;
   if(!unresolved.has(id)){if(seen.has(id)&&!resolved.has(id)){change();resolved.add(id);}continue;}
   if(!seen.has(id)){change();seen.add(id);}
  }
  for(const id of s.update?.newRecordIds||[])if(seen.has(id)&&!resolved.has(id)){change();resolved.add(id);}
 }
 if(changed)entry.missingBodyState={...state,ids:[...seen],resolved:[...resolved]};
}
function token(state,through){return crypto.createHash('sha256').update(JSON.stringify([state.source,state.nonce,state.ids.slice(0,through)])).digest('hex');}
function snapshot(entry){
 const state=entry.missingBodyState;if(!state||state.source!==source(entry))return null;
 const notice=view(state)?.notice;return notice?{...notice}:null;
}
function dismiss(entry,notice){
 const s=entry.missingBodyState,n=notice?.through;
 if(!s||s.source!==source(entry)||!view(s)||!Number.isSafeInteger(n)||n<1||n>s.ids.length||notice.token!==token(s,n))throw Error('提示内容已变化，请刷新后重新关闭');
 return {...s,dismissed:Math.max(s.dismissed,n)};
}
module.exports={observe,snapshot,dismiss};
