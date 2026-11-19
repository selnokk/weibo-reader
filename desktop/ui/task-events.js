'use strict';
// This owner is independent of the selected page and of presentation busy flags.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ReaderTaskEvents=factory();})(typeof globalThis!=='undefined'?globalThis:this,()=>{
 const scoped=new Set(['plan','collection','phase','progress','credits','summary','source','report','stopping','log','target','autoSafety','serviceLogoutResult']);
 const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
 function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
 function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
 function sameQuery(expected,actual){if(!expected)return true;if(!actual)return false;return JSON.stringify(canonical(expected))===JSON.stringify(canonical(Object.fromEntries(Object.keys(expected).map(k=>[k,actual[k]]))));}
 function create(){
  let pending=null,active=null;const closedTasks=new Set(),closedRequests=new Set();
  const result=(route,task=null,release=false)=>({route,task,release});
  function retire(task){if(task?.taskId)closedTasks.add(task.taskId);if(task?.requestId)closedRequests.add(task.requestId);for(const entries of [closedTasks,closedRequests])while(entries.size>256)entries.delete(entries.values().next().value);}
  function begin(requestId,query){if(active||pending||typeof requestId!=='string'||!requestId||closedRequests.has(requestId))return false;pending={requestId,query:freeze(clone(query)),phase:'pending',taskId:null};return true;}
  // Retire only the captured UI owner when its workspace is no longer accepted.
  // This drops late notifications; it never cancels or starts an engine request.
  function forget(requestId){const task=active||pending;if(!task||task.requestId!==requestId)return false;retire(task);active=null;pending=null;return true;}
  function snapshot(){const task=active||pending;return {busy:!!task,starting:!!task&&task.phase!=='running',activeId:active?.taskId||null,requestId:task?.requestId||null,query:task?.query||null};}
  function route(event){
   if(event.automatic)return result('automatic');
   if(event.type==='engineStopped'||event.type==='engineTransportError'){const task=active||pending;retire(active);retire(pending);active=null;pending=null;return result('global',task,true);}
   if(event.type==='finished'&&event.kind==='account')return result('global');
   const id=event.taskId||(['preparing','started','finished'].includes(event.type)?event.id:null),request=event.requestId||null;
   if((id&&closedTasks.has(id))||(request&&closedRequests.has(request)))return result('drop');
   if(event.type==='manualQueued'){
    if(!pending||request!==pending.requestId||!sameQuery(pending.query,event.query))return result('drop');pending={...pending,query:pending.query||freeze(clone(event.query)),phase:'queued',queueId:event.id};return result('task',pending);
   }
   if(event.type==='preparing'||event.type==='started'){
    if(!id)return result('drop');
    if(active){if(active.taskId!==id||request&&request!==active.requestId||event.type==='preparing'||active.phase==='running')return result('drop');if(!sameQuery(active.query,event.query))return result('drop');}
    else if(pending){if(request!==pending.requestId||event.query&&!sameQuery(pending.query,event.query))return result('drop');}
    else return result('drop');
    if(event.type==='started'&&event.kind==='collect'&&!event.query)return result('drop');
    const previous=active||pending;active={taskId:id,requestId:request||previous?.requestId||null,query:previous?.query||freeze(clone(event.query)),phase:event.type==='started'?'running':'preparing',kind:event.kind||'collect'};pending=null;return result('task',active);
   }
   if(event.type==='taskAlreadyConnected'){if(!pending||!request||request!==pending.requestId)return result('drop');const task=pending;retire(task);pending=null;return result('task',task,true);}
   if(event.type==='finished'){
    const task=active||pending;if(!task||!id||active&&id!==active.taskId||request&&request!==task.requestId||!active&&(!request||request!==task.requestId))return result('drop');retire({...task,taskId:id});active=null;pending=null;return result('task',task,true);
   }
   if(event.type==='error'){
    const task=active||pending;
    if(id||request){if(!task||id&&id!==active?.taskId||request&&request!==task.requestId)return result('drop');const release=!!event.needsLogin||!active||active.phase==='preparing';if(release){retire(task);active=null;pending=null;}return result('task',task,release);}
    return result('global');
   }
   if(scoped.has(event.type)){
    if(!active||!id||id!==active.taskId||request&&request!==active.requestId)return result('drop');
    if(event.type==='summary'&&active.query?.subject?.kind==='user'&&event.uid&&event.uid!==active.query.subject.uid)return result('drop');
    if(event.type==='summary'&&active.query?.subject?.kind==='post'&&event.target&&event.target!==active.query.subject.id)return result('drop');
    return result('task',active);
   }
   return result('global');
  }
  return {begin,route,snapshot,forget};
 }
 return {create,sameQuery};
});
