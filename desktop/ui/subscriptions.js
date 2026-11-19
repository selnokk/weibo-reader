'use strict';
(()=>{
 let entries=state.subscriptions||[],type='all',workspace=state.workspace||'',generation=0,ready=false,lastListRequest='',ledgerBlocked=false;
 const pending=new Map(),removing=new Map(),noticeRequests=new Map();state.subscriptions=entries;
 const key=(kind,id)=>kind+':'+id,kind=e=>e.targetKind||'user',id=e=>e.postId||e.uid;
 const status={waiting:'订阅中',running:'检查中',paused:'已暂停',queued:'排队中','budget-paused':'预算暂停','error-paused':'异常暂停','retry-wait':'等待重试','attention-required':'等待重试'};
 const statusStyle={waiting:'success',running:'running',queued:'running','error-paused':'error','budget-paused':'warning','retry-wait':'warning','attention-required':'warning'};
 const current=()=>ready&&workspace===state.workspace;
 window.subscriptionFor=(k,v)=>current()?entries.find(e=>kind(e)===k&&id(e)===v):undefined;
 function subject(k,v){return k==='post'?(state.posts||[]).find(p=>p.postId===v):window.userInfo?.(v);}
 function label(k,v){const info=subject(k,v);return ReaderEntityActions.displayName(info,k==='post'?info?.title||'微博 '+v:info?.nickname||'用户 '+v);}
 // DOM callbacks keep the snapshot identity that created them. A workspace or
 // post-source change must never retarget an old control to the new directory.
 function capture(k,v){const entry=subscriptionFor(k,v);return {workspace,generation,kind:k,id:v,exists:!!entry,source:entry?.source||'cli'};}
 function owns(c){const entry=subscriptionFor(c.kind,c.id);return current()&&c.workspace===workspace&&c.generation===generation&&!!entry===c.exists&&(!entry||(entry.source||'cli')===c.source);}
 const needsRecovery=e=>!!(e.blockedKinds?.length||e.recovery||Object.values(e.directionRetry||{}).some(retry=>retry?.attempts>0));
 const directionLabel=kind=>kind==='sent'?'发出':kind==='received'?'收到':'博文评论';
 function retryingDirection(e){
  if(e.mode!=='both'||e.recovery)return null;
  const retrying=['sent','received'].filter(kind=>e.directionRetry?.[kind]?.attempts>0||e.blockedKinds?.includes(kind));
  return retrying.length===1?retrying[0]:null;
 }
 const serviceBlocked=e=>e?.serviceBlocks?.some(s=>s.code==='IP_GEO_DENIED');
 function currentServiceIssues(e){
  
  return (e.serviceBlocks||[]).filter(item=>item.code==='IP_GEO_DENIED'&&(
   e.blockedKinds?.includes(item.kind)||e.directionRetry?.[item.kind]?.code===item.code||e.recovery?.code===item.code||e.pauseCode===item.code
  ));
 }
 function attentionNotice(e){
  const issues=currentServiceIssues(e),service=issues.length>0&&e.status!=='paused',code=e.recovery?.code||e.pauseCode;
  const blocked=e.blockedKinds||[],recoveryError=e.recovery?.code&&!['AUTO_RETRY','AUTO_INTERRUPTED','AUTO_STATE_RECOVERY'].includes(e.recovery.code);
  if(ledgerBlocked||e.status==='paused'||!service&&!blocked.length&&e.status!=='error-paused'&&!(e.status==='attention-required'&&code)&&!recoveryError)return [];
  const text=ReaderAcquisitionFeedback.noticeSummary({code:service?'IP_GEO_DENIED':code||Object.values(e.directionRetry||{}).find(v=>v.code)?.code,enabled:e.enabled,localOnly:e.recovery?.localOnly});
  if(!text)return [];
  const receipts=service?issues.map(item=>[item.kind,item.roundId,item.requestId,item.receipt]).sort():[];
  const directions=blocked.map(kind=>[kind,e.directionRetry?.[kind]?.code,e.directionRetry?.[kind]?.lastRoundId]).filter(([,code,round])=>code||round).sort();
  // Use the current issue's own evidence. Healthy checks, countdowns and
  // unrelated history must not revive a closed notice.
  const origin=receipts.length?receipts:e.recovery?.roundId||(directions.length?directions:e.lastRoundId||e.lastCheckAt||text);
  const key=JSON.stringify(['attention',service?'IP_GEO_DENIED':code,origin]);
  const oldVersion=JSON.stringify([e.lastRoundId,e.recovery?.roundId,e.recovery?.code,e.pauseCode,e.status,e.reason,e.directionMessage,e.blockedKinds,Object.entries(e.directionRetry||{}).map(([kind,retry])=>[kind,retry.code,retry.lastRoundId]),e.dataStates]);
  return [{text,key,aliases:[JSON.stringify([service?'service':'reason',oldVersion])],source:e.source||'cli'}];
 }
 function dismissMissing(c,notice){
  if(!owns(c))return Promise.reject(Error('订阅已变化，请刷新后重试。'));
  return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID(),timer=setTimeout(()=>{noticeRequests.delete(requestId);reject(Error('关闭提示未能保存，请重试。'));},10000);noticeRequests.set(requestId,{resolve,reject,timer,c});send({action:'followMissingDismiss',workspace:c.workspace,requestId,uid:c.id,targetKind:c.kind,notice});});
 }
 function noticesFor(e){
  const notices=attentionNotice(e),missing=e.missingNotice;
  if(missing?.count>0){const c=capture(kind(e),id(e));notices.push({text:'少了 '+numeric(missing.count)+' 条正文',key:'subscription-missing:'+missing.token,source:e.source||'cli',dismissTitle:'关闭并重置提示计数，原始缺失记录保留',beforeDismiss:()=>dismissMissing(c,missing)});}
  return notices;
 }
 const header=$('subscriptions-refresh').parentElement,headerActions=node('div','subscription-header-actions');
 header.append(headerActions);
 ReaderEntityActions.installClearNotices(headerActions,()=>current()?entries.flatMap(e=>
  noticesFor(e).map(notice=>ReaderEntityActions.listNoticeOptions(kind(e),id(e),notice))
 ):[]);
 headerActions.append($('subscriptions-refresh'));
 function serviceSettings(){view('settings');requestAnimationFrame(()=>$('service-account-card')?.scrollIntoView({block:'start',behavior:'smooth'}));}
 function serviceRetry(c){if(ledgerBlocked||!owns(c)||pending.has(key(c.kind,c.id)))return;const e=subscriptionFor(c.kind,c.id);if(!serviceBlocked(e))return;const requestId=crypto.randomUUID();pending.set(key(c.kind,c.id),{on:true,requestId,source:c.source});send({action:'followResume',targetKind:c.kind,uid:c.id,...(c.kind==='post'?{postId:c.id}:{}),requestId});render();refreshToggles();}
 window.ReaderSubscriptionService={blocked:serviceBlocked,ledgerBlocked:()=>ledgerBlocked,settings:serviceSettings,retry:(k,v)=>serviceRetry(capture(k,v))};
 function requestList(){if(!state.workspace)return;lastListRequest=crypto.randomUUID();send({action:'followList',requestId:lastListRequest});}
 function toggle(c,on){if(!owns(c)||on&&ledgerBlocked)return;const e=subscriptionFor(c.kind,c.id);if(on&&serviceBlocked(e)){serviceRetry(c);return;}if(on&&!e){window.openFollow(c.id,'both',c.kind);return;}const requestId=crypto.randomUUID();pending.set(key(c.kind,c.id),{on,requestId,source:c.source});send({action:on?'followResume':'followPause',targetKind:c.kind,uid:c.id,...(c.kind==='post'?{postId:c.id}:{}),requestId});render();refreshToggles();}
 function refreshToggles(){if(ReaderIdentity.user(state))renderSubscriptionToggle('user',ReaderIdentity.user(state));if(state.selection?.kind==='post')renderSubscriptionToggle('post',ReaderUX.postId(currentTarget()));}
 window.renderSubscriptionToggle=(k,v)=>{
  const host=k==='user'?$('user-page-actions'):$('post-identity')?.querySelector('.user-page-actions');if(!host)return;host.querySelector('.subscription-switch')?.remove();
  const e=subscriptionFor(k,v),c=capture(k,v),wrap=node('label','subscription-switch'),input=node('input');input.type='checkbox';input.setAttribute('role','switch');input.setAttribute('aria-label','订阅'+label(k,v));input.checked=pending.has(key(k,v))?pending.get(key(k,v)).on:!!e?.enabled;input.disabled=!current()||pending.has(key(k,v));
  if(!current())input.title='订阅状态尚未读取，请稍后或在订阅页重试';
  if(ledgerBlocked){input.title='自动检查正在等待本地账本核对';if(!e?.enabled)input.disabled=true;}
  input.addEventListener('change',()=>{if(!owns(c)){input.checked=!!e?.enabled;return;}const on=input.checked;if(on&&!subscriptionFor(k,v))input.checked=false;toggle(c,on);});wrap.append(input,node('span','','订阅'));
  if(k==='post'){const settings=button('设置','text-button',()=>{if(owns(c))window.openFollow(v,e?.mode||'post-comments',k);});settings.disabled=!current();wrap.append(settings);}host.append(wrap);
 };
 const loadBox=node('div','home-load-status');loadBox.id='subscription-list-state';loadBox.setAttribute('role','status');$('subscription-list').before(loadBox);
 const ledgerStatus=node('div','home-load-status subscription-ledger-status retained-list-error'),ledgerCopy=node('div'),ledgerNotice=node('p');
 ledgerStatus.id='subscription-ledger-status';ledgerStatus.hidden=true;
 ledgerCopy.append(node('strong','','自动检查受阻'),ledgerNotice);
 ledgerStatus.append(ledgerCopy,button('重试读取本地状态','button secondary',requestList));loadBox.after(ledgerStatus);
 function showLedgerBlock(){
  ledgerBlocked=true;ledgerStatus.hidden=false;
  ledgerNotice.textContent='费用记录暂时无法读取，请重试。';
  ledgerNotice.setAttribute('role','alert');
  window.ReaderNotices?.decorate(ledgerNotice,{scope:workspace+'|subscriptions',key:'ledger-invalid:'+crypto.randomUUID()});
  window.subscriptionLedgerStatusChanged?.();
 }
 function clearLedgerBlock(){
  if(!ledgerBlocked)return;
  ledgerBlocked=false;ledgerStatus.hidden=true;
  window.ReaderNotices?.reset(ledgerNotice);ledgerNotice.replaceChildren();ledgerNotice.removeAttribute('role');
 }
 function loadingStatus(){
  if(ledgerBlocked){loadBox.hidden=true;return 'blocked';}
  return ReaderEntityActions.homeLoadStatus('subscriptions','subscription-list-state',state.homeLoading.subscriptions.snapshot,requestList);
 }
 function render(){
  const retained=new Map([...$('subscription-list').children].map(card=>[card.dataset.subscriptionOwner,{focus:card.contains(document.activeElement)?document.activeElement.dataset.subscriptionControl:null}]));
  const loaded=current(),term=$('subscription-search').value.trim().toLowerCase(),rows=loaded?entries.filter(e=>(type==='all'||kind(e)===type)&&(!term||[id(e),label(kind(e),id(e)),subject(kind(e),id(e))?.nickname,subject(kind(e),id(e))?.author,subject(kind(e),id(e))?.title].join(' ').toLowerCase().includes(term))):[],list=$('subscription-list');list.replaceChildren();
  $('subscription-count').textContent=loaded?entries.filter(e=>e.enabled).length:'—';$('subscription-empty').hidden=!loaded||!!rows.length;loadingStatus();
  for(const e of rows){
   const k=kind(e),v=id(e),c=capture(k,v),card=node('article','subscription-card'),top=node('div','subscription-card-heading'),identity=node('div');card.dataset.subscriptionKey=key(k,v);card.dataset.subscriptionOwner=workspace+'|'+(e.source||'cli')+'|'+key(k,v);card._subscription=e;identity.title=label(k,v);identity.append(node('span','eyebrow',k==='post'?'博文评论':'用户互动'),node('h2','',label(k,v)));const stateLabel=node('span','status-pill'),subject=node('div','subscription-identity'),open=button('','subscription-open',()=>{if(owns(c))k==='post'?openPostPage(v):openUser(v);});open.setAttribute('aria-label','打开本地'+(k==='post'?'博文 ':'用户 ')+label(k,v)+' · '+(k==='post'?'微博 ID ':'UID ')+v);open.title=open.getAttribute('aria-label');open.append(window.entityAvatar?.(k,v,'subscription-avatar')||node('span','user-avatar subscription-avatar','微'),identity);subject.append(open,node('p','field-hint subscription-id',(k==='post'?'微博 ID ':'UID ')+v));top.append(subject,stateLabel);card.append(top);
   const facts=node('div','subscription-facts'),last=node('div','subscription-check'),next=node('div','subscription-check');
   last.dataset.subscriptionLast='';next.dataset.subscriptionNext='';
   const lastAt=Date.parse(e.lastCheckAt);
   const lastDate=node('span','subscription-fact-detail',Number.isFinite(lastAt)?dateText(lastAt):'');
   lastDate.toggleAttribute('data-exact',Number.isFinite(lastAt));
   last.append(node('span','muted','最近尝试'),node('strong','','尚未尝试'),lastDate);
   next.append(node('span','muted','下次检查'),node('strong','','未安排'),node('span','subscription-fact-detail'));
   facts.append(last,next);
   const directions=e.mode==='both'?['sent','received']:[e.mode];
   const successDates=directions.map(kind=>[kind,Date.parse(e.successfulChecks?.[kind])]).filter(([,at])=>Number.isFinite(at)).sort((a,b)=>b[1]-a[1]);
   const [successKind,lastSuccess]=successDates[0]||[];
   for(const [label,value,detail]of [
    ['最近成功检查',Number.isFinite(lastSuccess)?(directions.length>1?directionLabel(successKind)+' · ':'')+relativeTime(lastSuccess):'暂无',successDates.map(([kind,at])=>directionLabel(kind)+' '+dateText(at)).join(' · ')],
    ['最近保存新评论',e.lastNewAt?numeric(e.lastNewCount)+' 条':'暂无',e.lastNewAt?dateText(Date.parse(e.lastNewAt)):''],
    ((['本周期额度',numeric(e.today?.budgetSpent??e.today?.estimatedCredits??0)+' / '+numeric(e.dailyBudget)+' credits']))]){
    const fact=node('div');
    if(detail)fact.title=detail;
    if(label==='本周期额度')fact.title='按返回量估算的使用量 / 每日额度；待核对预留 '+numeric(e.today?.reservedCredits||0)+' credits，实际扣费以服务端为准';
    fact.append(node('span','muted',label),node('strong','',value));facts.append(fact);
   }
   card.append(facts);
   if(k==='user'||e.inbox?.unread!=null||e.inbox?.unavailable)facts.children[2].append(node('span','subscription-fact-detail subscription-unread',e.inbox?.unavailable?'未读统计暂不可用':(e.inbox?.unread||0)+(k==='post'?' 条未读评论':' 条未读互动')));
   const notices=noticesFor(e);
   const actions=node('div','settings-actions');actions.append(button('设置','text-button',()=>{if(owns(c))window.openFollow(v,e.mode,k);}),button(e.enabled?'暂停':'恢复','text-button subscription-toggle',()=>toggle(c,!e.enabled)));
   actions.querySelector('.subscription-toggle').disabled=pending.has(key(k,v))||!!e.removing||ledgerBlocked&&!e.enabled;
   const remove=button(removing.has(key(k,v))||e.removing?'正在移除…':'删除订阅','text-button danger-button',()=>{if(!owns(c))return;const requestId=crypto.randomUUID();removing.set(key(k,v),{requestId,source:c.source});remove.disabled=true;remove.textContent='正在移除…';send({action:'followRemove',targetKind:k,uid:v,...(k==='post'?{postId:v}:{}),requestId});});remove.disabled=removing.has(key(k,v))||!!e.removing;actions.append(remove);card.append(actions);ReaderEntityActions.noticeSlot(card,k,v,notices);for(const control of card.querySelectorAll('button,summary'))control.dataset.subscriptionControl=control.matches('summary')?'reason':control.classList.contains('subscription-toggle')?'toggle':control.classList.contains('danger-button')?'remove':control.getAttribute('aria-label')||control.textContent;const previous=retained.get(card.dataset.subscriptionOwner);list.append(card);if(previous?.focus)for(const control of card.querySelectorAll('button,summary'))if(control.dataset.subscriptionControl===previous.focus)control.focus({preventScroll:true});
  }
  updateActivity();
  all('[data-subscription-type]').forEach(b=>{const active=b.dataset.subscriptionType===type;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
 }
 function activityFor(e,at){
  const recovering=needsRecovery(e);
  const blocked=ledgerBlocked&&e.enabled;
  const ordinary=['running','queued','budget-paused'].includes(e.status);
  let a={detail:''};
  if(blocked)a={badge:'检查受阻',warning:true,detail:'',next:'等待核对账本'};
  else if(e.recovery){
   a={badge:status[e.status],detail:ReaderAcquisitionFeedback.noticeSummary({code:e.recovery.code,enabled:e.enabled,localOnly:e.recovery.localOnly})};
  }else if(recovering)a.detail=ReaderAcquisitionFeedback.noticeSummary({code:currentServiceIssues(e).length?'IP_GEO_DENIED':e.pauseCode||Object.values(e.directionRetry||{}).find(v=>v.code)?.code,enabled:e.enabled});
  else if(ordinary)a.detail=e.status==='running'?'正在检查更新。':e.status==='budget-paused'?'额度恢复后继续检查。':'正在等待检查。';
  else if(e.enabled&&e.status==='waiting'&&e.noNewKinds?.length&&e.lastAdded===0)a.detail=ReaderAcquisitionFeedback.subscriptionEmptyNote(e);
  if(!blocked&&recovering&&e.enabled){
   a.warning=true;
   if(e.status==='waiting'){
    const retry=retryingDirection(e);
    a.badge=retry?directionLabel(retry)+'待重试':'等待重试';
    if(retry&&!currentServiceIssues(e).length){
     const retryAt=Date.parse(e.directionRetry?.[retry]?.nextRetryAt);
     if(Number.isFinite(retryAt))a.detail+=' '+directionLabel(retry)+'重试时间 '+dateText(retryAt)+'。';
    }
   }
  }
  if(!blocked&&currentServiceIssues(e).length&&e.enabled&&e.status!=='running'){a.warning=true;a.badge='恢复等待';}
  const pending=e.dataStates?e.dataStates.some(s=>s.pendingNew):e.pending;
  const incomplete=pending&&!a.detail?'有待补区间。':'';
  return {...a,detail:[a.detail,incomplete].filter(Boolean).join(' · ')};
 }
 function nextCheckDisplay(e,a,at){
  if(!e.enabled||e.status==='paused')return ['未安排',''];
  if(a.next)return [a.next,''];
  if(e.running||e.status==='running')return ['本轮结束后安排',''];
  const planned=Date.parse(e.nextCheckAt);
  if(!Number.isFinite(planned))return [e.status==='queued'?'排队中':'未安排',''];
  const deadline=planned,remaining=deadline-at;
  if(remaining<=0&&e.status==='queued')return ['排队中',''];
  if(remaining<=0&&e.status==='budget-paused')return ['等待预算重置',''];
  const exact=dateText(deadline);
  if(remaining<60000)return [e.recovery?.localOnly?'即将核对':'即将检查',exact];
  if(remaining<3600000)return [Math.ceil(remaining/60000)+' 分钟后',exact];
  if(remaining<86400000)return [Math.ceil(remaining/3600000)+' 小时后',exact];
  return [Math.ceil(remaining/86400000)+' 天后',exact];
 }
 function nextCheckLabel(e,at){
  if(ledgerBlocked||!e.enabled||e.running||e.status!=='waiting'||e.recovery||e.mode!=='both')return '下次检查';
  const planned=Date.parse(e.nextCheckAt),sent=Date.parse(e.directionRetry?.sent?.nextRetryAt),received=Date.parse(e.directionRetry?.received?.nextRetryAt);
  if(![planned,sent,received].every(Number.isFinite))return '下次检查';
  const due=Math.max(planned,at);
  if(sent<=due&&received>due)return '下次检查 · 发出';
  if(received<=due&&sent>due)return '下次检查 · 收到';
  return '下次检查';
 }
 function setText(node,text){
  if(node&&node.textContent!==text)node.textContent=text;
 }
 function updateActivity(){
  const at=Date.now();
  for(const card of $('subscription-list').children){
   const e=card._subscription;if(!e)continue;
   const a=activityFor(e,at),statusNode=card.querySelector('.status-pill');
   const badge=a.badge||(status[e.status]||'已暂停');
   const style=a.warning?'warning':a.badge?'running':statusStyle[e.status]||'';
   setText(statusNode,badge);
   const className='status-pill '+style;
   if(statusNode.className!==className)statusNode.className=className;
   const next=card.querySelector('[data-subscription-next]'),last=card.querySelector('[data-subscription-last] strong');
   const [relative,exact]=nextCheckDisplay(e,a,at);
   const nextLabel=nextCheckLabel(e,at);
   setText(next?.querySelector('.muted'),nextLabel);
   setText(next?.querySelector('strong'),relative);
   const nextDate=next?.querySelector('.subscription-fact-detail');
   setText(nextDate,exact);
   nextDate?.toggleAttribute('data-exact',!!exact);
   const nextTitle=[nextLabel,relative,exact,a.detail].filter(Boolean).join(' · ');
   if(next&&next.title!==nextTitle)next.title=nextTitle;
   if(statusNode.title!==a.detail)statusNode.title=a.detail;
   if(e.lastCheckAt)setText(last,relativeTime(e.lastCheckAt));
  }
 }
 setInterval(()=>{if(state.view==='subscriptions')updateActivity();},1000);
 window.subscriptionReceive=e=>{
  if(e.type==='library'){
   const changed=workspace!==e.workspace;
   if(changed||e.homeBlocked){
    for(const r of noticeRequests.values()){clearTimeout(r.timer);r.reject(Error('资料目录已变化，请在当前目录操作。'));}noticeRequests.clear();
    clearLedgerBlock();workspace=e.workspace;generation++;ready=false;entries=[];state.subscriptions=[];pending.clear();removing.clear();lastListRequest='';
    if(changed){type='all';$('subscription-search').value='';}
    render();queueMicrotask(refreshToggles);
   }
   return;
  }
  if(e.workspace&&e.workspace!==workspace||workspace!==state.workspace)return;
  const request=noticeRequests.get(e.requestId);if(request&&['followMissingDismissed','followError'].includes(e.type)){if(e.type==='followMissingDismissed'&&(kind(e)!==request.c.kind||id(e)!==request.c.id))return;clearTimeout(request.timer);noticeRequests.delete(e.requestId);if(!owns(request.c))request.reject(Error('订阅已变化，请刷新后重试。'));else if(e.type==='followError')request.reject(Error(e.message||'关闭提示未能保存。'));else request.resolve();return;}
  if(e.type==='followState'){
   if(Array.isArray(e.entries))clearLedgerBlock();
   if(e.requestId&&e.requestId===lastListRequest)lastListRequest='';
   entries=e.entries||[];ready=true;
   for(const [k,value]of removing){const e=entries.find(e=>key(kind(e),id(e))===k);if(!e||(e.source||'cli')!==value.source)removing.delete(k);}
   for(const [k,value]of pending){const e=entries.find(e=>key(kind(e),id(e))===k);if(!e||(e.source||'cli')!==value.source||value.on===e.enabled)pending.delete(k);}
   state.subscriptions=entries;render();refreshToggles();
  }else if(e.type==='libraryState'&&(e.section==='subscriptions'||e.section==='all')){loadingStatus();}
  else if(e.type==='followRemoved'){
   const k=key(e.targetKind||'user',e.postId||e.uid);if(!removing.has(k))return;
   toast(e.pending?'当前请求保存后会移除订阅，数据和费用记录保留。':'订阅已删除，数据和费用记录保留。');
  }else if(e.type==='followError'){
   if(e.workspace===workspace&&!e.requestId&&!id(e)&&e.code==='AUTO_LEDGER_INVALID'&&e.coreFailed===true){
    if(!ledgerBlocked){showLedgerBlock();render();refreshToggles();}
    return;
   }
   const listFailed=!!lastListRequest&&e.requestId===lastListRequest;
   if(ledgerBlocked&&listFailed)return;
   if(listFailed){lastListRequest='';state.homeLoading.subscriptions={status:'error',message:e.message,snapshot:current()};}
   let requested=false;
   for(const actions of [pending,removing])for(const [k,v]of actions){
    if(v.requestId!==e.requestId||id(e)&&key(kind(e),id(e))!==k||e.source&&e.source!==v.source)continue;
    actions.delete(k);requested=true;
   }
   if(requested)toast(e.message,true);
   if(!requested&&!listFailed)return;
   if(requested){render();refreshToggles();}else loadingStatus();
  }else if(e.type==='reportMarkedRead'){if(e.readingChanged&&subscriptionFor(kind(e),id(e)))render();}
  else if(['postsHome','homeUsers','userProfile','userNoteSaved','postNoteSaved'].includes(e.type))queueMicrotask(render);
 };
 $('subscriptions-refresh').onclick=requestList;$('subscription-search').addEventListener('input',render);for(const b of all('[data-subscription-type]'))b.onclick=()=>{type=b.dataset.subscriptionType;render();};render();
})();
