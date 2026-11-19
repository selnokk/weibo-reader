(function(root){
 'use strict';
 // Generate URLs only from explicit identities, never from a hidden form target.
 const validId=value=>/^\d{5,20}$/.test(String(value||''))?String(value):'';
 const profileUrl=value=>{const id=validId(value);return id?'https://weibo.cn/u/'+id:'';};
 const links=typeof module!=='undefined'&&module.exports?require('../../lib/post-links'):root.ReaderPostLinks;
 const postUrl=(value,authorUid='')=>links.postUrl(value,authorUid);
 const noteText=value=>typeof value==='string'?value:'';
 const displayName=(entry,fallback='')=>noteText(entry?.note).trim()||fallback;
 const api={profileUrl,postUrl,noteText,displayName};
 if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
 let editor=null,owner=null,rowPopover=null,taskChooser=null,statusDialog=null,refreshChoices=null;const pending=new Map(),scope=ReaderWorkspaceChannel.createScope(()=>state.workspace);
 const gapRequests=new Map();
 let detailChoices=null;
 function stop(event){event?.preventDefault();event?.stopPropagation();}
 function external(kind,id){
  function anchor(url,label,site=''){const link=node('a','text-button entity-external-link',label);link.href=url;link.target='_blank';link.rel='noopener noreferrer';if(site)link.setAttribute('data-post-site',site);link.setAttribute('aria-label',(kind==='user'?'打开用户 ':'打开博文 ')+id+(site?' 的 weibo.'+site+' 链接':' 的微博链接'));link.addEventListener('click',event=>{stop(event);if(url)send({action:'external',url});});return link;}
  if(kind==='user')return anchor(profileUrl(id),'打开微博主页 ↗');
  const urls=links.postUrls(id,get('post',id)?.authorUid||''),group=node('span','entity-post-links');if(urls)for(const site of ['com','cn'])group.append(anchor(urls[site],'weibo.'+site+' ↗',site));return group;
 }
 function get(kind,id){return kind==='user'?(state.homeUsers?.find(u=>u.uid===id)||state.accounts?.find(u=>u.uid===id)):(state.posts?.find(p=>p.postId===id));}
 function close(){closeResume();if(editor?.dialog.open)editor.dialog.close();if(taskChooser?.open)taskChooser.close();if(statusDialog?.open)statusDialog.close();owner=null;}
 const resumeScope=ReaderWorkspaceChannel.createScope(()=>state.workspace);
 let resumePreview=null,resumeDialog=null;
 function closeResume(){
  resumePreview=null;
  if(resumeDialog?.open)resumeDialog.close();
 }
 function resumeTask(id){
  if(state.busy||state.starting||!state.workspace)return;
  closeResume();
  const requestId=crypto.randomUUID(),ownership=resumeScope.capture({view:state.view,target:currentTarget()});
  resumePreview={id,requestId,ownership};
  send({action:'resumeTaskPreview',id,requestId});
 }
 function resumeOwns(request,event){
  return resumeScope.owns(request.ownership,event)&&request.ownership.view===state.view&&request.ownership.target===currentTarget();
 }
 function resumeReceive(event){
  if(event.type==='library'){
   const owned=resumePreview?.ownership;
   resumeScope.observe(event);
   if(owned&&!resumeScope.owns(owned))closeResume();
   return false;
  }
  if(event.type==='engineStopped'||event.type==='engineTransportError')closeResume();
  const request=resumePreview;
  if(!request||event.requestId!==request.requestId)return false;
  if(!resumeOwns(request,event)){closeResume();return event.type==='resumeTaskPreview'||event.type==='error';}
  if(event.type==='error'){closeResume();toast(event.message,true);return true;}
  if(event.type!=='resumeTaskPreview'||event.id!==request.id)return false;
  if(resumeDialog?.open)return true;
  if(state.busy||state.starting){closeResume();toast('请先等待当前读取结束。');return true;}
  if(!event.middle){resumePreview=null;send({action:'resumeTask',id:request.id});return true;}
  showMiddleGapBudget(request,event);
  return true;
 }
 function showMiddleGapBudget(request,event){
  const dialog=node('dialog','delete-dialog middle-gap-dialog'),form=node('form');
  const header=node('header','middle-gap-header'),heading=node('h2','','补齐中间数据');
  heading.id='middle-gap-budget-heading';
  const entry=get('user',request.ownership.target);
  const name=displayName(entry,entry?.nickname||'UID '+request.ownership.target);
  const kinds=(event.kinds||[]).map(kind=>({sent:'发出评论',received:'收到评论'})[kind]).filter(Boolean);
  const scopeText=node('p','middle-gap-scope',name+(kinds.length?' · '+kinds.join('、'):''));
  header.append(heading,scopeText);
  dialog.setAttribute('aria-labelledby',heading.id);

  const body=node('div','middle-gap-body'),field=node('div','middle-gap-field'),input=node('input');
  const label=node('label','form-label','本次返回上限'),inputRow=node('div','middle-gap-input');
  input.id='middle-gap-limit';label.htmlFor=input.id;
  input.type='number';input.min='1';input.max=String(Number.MAX_SAFE_INTEGER);input.step='1';input.required=true;
  input.value=String(event.suggested||50);input.setAttribute('aria-describedby','middle-gap-limit-help');
  inputRow.append(input,node('span','','条'));field.append(label,inputRow);
  const estimate=node('div','middle-gap-estimate'),amount=node('strong','middle-gap-amount'),priceNote=node('span','middle-gap-price-note');
  amount.setAttribute('aria-live','polite');
  estimate.append(node('span','','预计费用上限'),amount,priceNote);
  const help=node('p','field-hint','各方向共用额度，重复返回和分页核对也计入。达到上限后会保留续读位置。');
  help.id='middle-gap-limit-help';
  body.append(field,estimate,help);
  const actions=node('div','settings-actions');
  const cancel=button('稍后再补','button secondary',()=>dialog.close()),go=node('button','button primary','开始补齐');
  cancel.type='button';go.type='submit';
  const limit=()=>/^[1-9]\d*$/.test(input.value)&&Number.isSafeInteger(Number(input.value))?Number(input.value):null;
  function sync(){
   const count=limit(),price=event.unitPrice;
   const known=Number.isFinite(price)&&price>=0;
   go.disabled=!count;
   amount.textContent=count&&known?numeric(count*price)+' credits':'—';
   priceNote.textContent=!count?'请输入大于 0 的整数。':known?'最近核实单价 '+numeric(price)+' credits / 条':'开始前核对当前单价';
  }
  input.addEventListener('input',sync);sync();
  actions.append(cancel,go);
  form.append(header,body,actions);
  dialog.append(form);document.body.append(dialog);
  form.addEventListener('submit',e=>{
   e.preventDefault();const returnBudget=limit();
   if(!returnBudget||resumePreview!==request||!resumeOwns(request)||state.busy||state.starting)return;
   closeResume();
   send({action:'resumeTask',id:request.id,returnBudget});
  });
  dialog.addEventListener('close',()=>{dialog.remove();if(resumeDialog===dialog)resumeDialog=null;if(resumePreview===request)resumePreview=null;},{once:true});
  resumeDialog=dialog;dialog.showModal();input.focus();input.select();
 }
 const isMiddleGap=task=>ReaderAcquisitionFeedback.isMiddleGap(task);
 const interruptedTask=task=>ReaderAcquisitionFeedback.interruptedTask(task);
 function continuationTitle(tasks){
  const interrupted=tasks.filter(interruptedTask).length;
  return interrupted&&interrupted===tasks.length?'继续原任务':interrupted?'待补区间与中断任务':'待补区间';
 }
 const canContinue=task=>!task.resumedBy&&!task.userGapChoice&&['interrupted','partial','failed'].includes(task.status)&&task.progressStatus?.resumable!==false;
 function continuationGroups(tasks){
  const groups=new Map(),ids=new Set();
  for(const task of tasks){
   if(!canContinue(task)||ids.has(task.id))continue;
   ids.add(task.id);
   const key=task.id;
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push(task);
  }
  return [...groups.values()];
 }
 function continuationOptions(kind,id,task){
  const options=taskNoticeOptions(kind,id,task);
  return {...options,sharedKey:'continuation:'+taskNoticeKey(task),aliases:[]};
 }
 function taskAcknowledgments(kind,id,task){return [taskNoticeOptions(kind,id,task),continuationOptions(kind,id,task)];}
 async function activeContinuations(kind,id,groups){
  const visible=await Promise.all(groups.map(tasks=>{
   const task=tasks[0];
   if(isMiddleGap(task)){
    if(task.noticeDismissed)return true;
    const options=taskNoticeOptions(kind,id,task),old=continuationOptions(kind,id,task);
    return ReaderNotices.isAcknowledged({...options,aliases:[...options.aliases,old.sharedKey]});
   }
   return ReaderNotices.isAcknowledged(continuationOptions(kind,id,task));
  }));
  return groups.filter((_,i)=>!visible[i]);
 }
 function taskChoiceReason(task){
  if(state.busy||state.starting)return '当前任务结束后可继续';
  return '';
 }
 function ignoreGap(owner,task){
  const requestId=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{gapRequests.delete(requestId);reject(Error('本地操作尚未确认，请刷新后重试'));},15000);
   gapRequests.set(requestId,{owner,task,resolve,reject,timer});
   send({action:'taskGapIgnore',uid:owner.id,id:task.id,expected:task.dismissToken,requestId});
  });
 }
 function gapChoiceReceive(event){
  const request=gapRequests.get(event.requestId);
  if(!request||!['taskGapIgnored','error'].includes(event.type))return false;
  gapRequests.delete(event.requestId);clearTimeout(request.timer);
  const {owner,task,resolve,reject}=request;
  if(!scope.owns(owner,event)){resolve(false);return true;}
  if(event.type==='error'){reject(Error(event.message));return true;}
  if(event.uid!==owner.id||event.taskId!==task.id){reject(Error('忽略区间的回执不匹配，请刷新后重试'));return true;}
  const current=get('user',owner.id)?.pendingTasks?.find(value=>value.id===task.id&&value.dismissToken===task.dismissToken);
  if(current)current.userGapChoice={id:event.id};
  window.renderUserHome?.();
  resolve(true);
  return true;
 }
 function continuationButton(kind,id,{history=false,onChoices}={}){
  const groups=()=>continuationGroups(get(kind,id)?.pendingTasks||[]);
  const captured=scope.capture({kind,id}),owns=()=>scope.owns(captured)&&
   (history||state.view==='create'&&state.selection?.kind===kind&&ReaderIdentity.target(state)===id);
  const updateChoices=choices=>{
   trigger.hidden=!choices.length;
   if(choices.length)trigger.textContent=continuationTitle(choices.map(([task])=>task))+(choices.length>1?'（'+choices.length+'）':'');
   onChoices?.(choices);
  };
  const trigger=button('待补区间','text-button task-continuations-open',async event=>{
   stop(event);if(!owns())return;
   const choices=history?groups().flat().map(task=>[task]):await activeContinuations(kind,id,groups());
   if(!owns()||!trigger.isConnected)return;
   if(!history)updateChoices(choices);
   if(!choices.length)return;
   close();
   const titleText=continuationTitle(choices.map(([task])=>task));
   const dialog=node('dialog','delete-dialog task-continuations-dialog'),heading=node('h2','',titleText),list=node('div','task-continuations-list'),actions=node('div','settings-actions');
   const header=node('header','task-continuations-header'),hint=node('p','field-hint','从已保存的位置读取。');
   header.append(heading,hint);taskChooser=dialog;
   dialog.setAttribute('aria-label',titleText+' · '+(kind==='user'?'UID ':'微博 ID ')+id);
   const currentTasks=()=>new Map((get(kind,id)?.pendingTasks||[]).filter(canContinue).map(task=>[task.id,task]));
   const live=(task,current=currentTasks())=>{
    const value=current.get(task.id);
    return value&&taskNoticeKey(value)===taskNoticeKey(task)&&JSON.stringify(value.query)===JSON.stringify(task.query);
   };
   const refresh=[],removeChoice=row=>{
    row.remove();
    if(!dialog.open)return;
    if(!list.children.length)dialog.close();
    else (list.querySelector('.task-choice-dismiss')||actions.firstElementChild)?.focus({preventScroll:true});
   };
   for(const tasks of choices){
    const task=tasks[0],row=node('div','task-continuation-row'),copy=node('div','task-continuation-copy'),source=task.query?.source||'cli';
    const title=node('strong'),mode=task.query?.mode,label=({ 'comments-both':'发出与收到','comments-sent':'发出评论','comments-received':'收到评论','mentions-comments':'评论中的 @','mentions-posts':'微博中的 @','user-posts':'用户微博','post-comments':'博文评论' }[mode]||'原任务');
    const gap=isMiddleGap(task);
    title.append(markCommentDirection(node('span','',label),mode),node('span','task-continuation-source',('微博 CLI')));
    if(titleText==='待补区间与中断任务')title.append(node('span','task-continuation-source is-gap',interruptedTask(task)?'意外中断':'待补区间'));
    const timestamp=Date.parse(task.finishedAt||task.startedAt);
    const reason=task.summary?.sources?.map(value=>value.reason).filter(Boolean).join('；')||task.progressStatus?.directions?.map(value=>value.reason).filter(Boolean).join('；');
    const date=node('span','',Number.isFinite(timestamp)?dateText(timestamp):'时间未记录');
    const detail=node('p','task-continuation-meta');
    detail.append(date,...(tasks.length>1?[node('span','','同一轮分页 · '+tasks.length+' 次获取')]:[]));copy.append(title,detail);
    if(reason&&!gap)copy.append(node('p','task-continuation-reason',reason));
    const controls=node('div','task-continuation-controls'),block=node('p','task-continuation-block',taskChoiceReason(task));
    const resume=button(ReaderAcquisitionFeedback.continuationLabel(task),'button secondary task-choice-resume',()=>{
     if(!owns()||!dialog.open||!live(task)||taskChoiceReason(task))return;
     dialog.close();resumeTask(task.id);
    });
    resume.dataset.taskId=task.id;resume.dataset.source=source;
    refresh.push(current=>{block.textContent=live(task,current)?taskChoiceReason(task):'原任务已变化，请重新打开列表';resume.disabled=!!block.textContent;});
    controls.append(resume);
    if(!history&&kind==='user'&&gap&&task.progressStatus?.canIgnoreGap){
     const canIgnore=()=>owns()&&dialog.open&&live(task)&&currentTasks().get(task.id)?.dismissToken===task.dismissToken;
     const ignore=button('忽略中间区间…','text-button gap-ignore',async()=>{
      if(!canIgnore())return;
      const accepted=await confirmManagement('忽略中间区间？','后续检查将从本轮已核实的最新保存记录继续。被跳过的旧区间仍未知，原正文、任务、费用及阅读状态保留。','忽略并保留旧证据');
      if(!accepted||!canIgnore())return;
      ignore.disabled=true;
      try{if(await ignoreGap(captured,task))removeChoice(row);}
      catch(error){if(owns()&&dialog.open)toast(error.message,true);}
      finally{ignore.disabled=false;}
     });
     controls.append(ignore);
    }
    if(!history)controls.append(button('忽略提醒','text-button task-choice-dismiss',async event=>{
     const control=event.currentTarget;if(!owns()||!dialog.open||!live(task))return;
     control.disabled=true;
     const current=currentTasks();
     const result=await ReaderNotices.acknowledge(tasks.filter(value=>live(value,current)).flatMap(value=>taskAcknowledgments(kind,id,value)),()=>owns()&&dialog.open);
     if(result==null){control.disabled=false;return;}
     removeChoice(row);renderCurrentContinuations();
    }));
    row.append(copy,controls,block);list.append(row);
   }
   if(!history)hint.textContent+=' 忽略提醒后仍可在获取历史查看原任务。';
   if(choices.some(([task])=>!isMiddleGap(task)))hint.textContent+=' 继续微博 CLI 读取可能消耗 credits。';
   actions.append(button('关闭','button secondary',()=>dialog.close()));dialog.append(header,list,actions);
   refreshChoices=()=>{const current=currentTasks();refresh.forEach(update=>update(current));};
   dialog.addEventListener('close',()=>{dialog.remove();if(taskChooser===dialog){taskChooser=null;refreshChoices=null;}});
   document.body.append(dialog);refreshChoices();dialog.showModal();actions.firstElementChild.focus();
  });
  const original=groups();if(!original.length)return null;
  if(history){
   trigger.textContent='查看'+continuationTitle(original.map(([task])=>task)).replace('继续原任务','中断任务');
  }
  if(!history){trigger.hidden=true;activeContinuations(kind,id,original).then(choices=>{
   if(scope.owns(captured)&&trigger.isConnected)updateChoices(choices);
  });}
  return trigger;
 }
 function renderContinuations(kind,id){
  if(state.selection?.kind!==kind||ReaderIdentity.target(state)!==id)return;
  refreshChoices?.();
  const owner=scope.capture({kind,id});
  const action=continuationButton(kind,id,{onChoices:choices=>{
   detailChoices={owner,taskIds:new Set(choices.flat().map(task=>task.id))};
   window.renderResultGapNotice?.();
  }}),controls=action?[action]:[];
  if(kind==='user'&&get(kind,id)?.pendingTasks?.some(task=>canContinue(task)&&isMiddleGap(task))){
   const owner=scope.capture();
   controls.push(button('获取历史','text-button task-history-shortcut',()=>{
    if(scope.owns(owner)&&ReaderIdentity.user(state)===id)showHistory(id,mode());
   }));
  }
  $('detail-continuation').replaceChildren(...controls);
  if(!action){detailChoices=null;window.renderResultGapNotice?.();}
 }
 function renderCurrentContinuations(){
  const id=ReaderIdentity.target(state),kind=state.selection?.kind;
  if(id&&kind)renderContinuations(kind,id);
 }
 function showsContinuation(kind,id,taskId){
  const owner=detailChoices?.owner;
  return !!owner&&owner.kind===kind&&owner.id===id&&scope.owns(owner)&&detailChoices.taskIds.has(taskId);
 }
 function renderHistoryContinuations(kind,id){const action=continuationButton(kind,id,{history:true});$('history-original-tasks').replaceChildren(...(action?[action]:[]));}
 function listNoticeOptions(kind,id,item){return {scope:state.workspace+'|'+kind+':'+id+'|'+(item.source||'unknown')+'|'+(item.scope||''),sharedKey:'list-notice:'+item.key,aliases:(item.aliases||[]).map(key=>'list-notice:'+key),persistent:item.persistent!==false&&['cli','unknown'].includes(item.source),beforeDismiss:item.beforeDismiss};}
 function installClearNotices(host,items){
  const control=button('清除全部通知','button secondary clear-list-notices',async()=>{
   if(control.disabled||!state.workspace)return;
   const captured=scope.capture(),options=items();
   if(!options.length){toast('暂无可清除的通知');return;}
   control.disabled=true;
   try{
    const count=await ReaderNotices.acknowledge(options,()=>scope.owns(captured));
    if(!scope.owns(captured))return;
    const id=state.selection?.kind==='post'?ReaderUX.postId(currentTarget()):ReaderIdentity.user(state);
    if(id)renderContinuations(state.selection?.kind==='post'?'post':'user',id);
    if(count>=0)toast(count?'已清除全部通知':'暂无可清除的通知');
   }catch(error){if(scope.owns(captured))toast(error.message||'关闭通知未完成，请重试。',true);}finally{control.disabled=false;}
  });
  control.title='隐藏此页面当前的通知，保留已保存内容和任务历史';
  host.append(control);return control;
 }
 function ensureEditor(){if(editor)return editor;const dialog=node('dialog','delete-dialog entity-note-dialog'),title=node('h2'),label=node('label','','备注'),input=node('textarea','entity-note-input'),counter=node('p','field-hint'),error=node('p','inline-error'),actions=node('div','settings-actions');dialog.id='entity-note-dialog';title.id='entity-note-title';input.id='entity-note-input';label.htmlFor=input.id;dialog.setAttribute('aria-labelledby',title.id);input.rows=5;input.placeholder='添加本地备注，方便区分用户或博文';error.hidden=true;error.setAttribute('role','alert');const cancel=button('取消','button secondary',close),save=button('保存备注','button primary',()=>{if(!owner||owner.requestId)return;if(!scope.owns(owner)){close();return;}const count=Array.from(input.value).length;if(count>2000){error.textContent='备注最多 2000 字。';error.hidden=false;window.ReaderNotices?.decorate(error,{scope:state.workspace+'|'+owner.kind+':'+owner.id,key:'note-validation:'+crypto.randomUUID()});return;}const requestId=crypto.randomUUID(),request={...owner,note:input.value,requestId};pending.set(requestId,request);owner=request;save.disabled=true;save.textContent='正在保存…';error.hidden=true;send({action:owner.kind==='user'?'userNoteSave':'postNoteSave',workspace:owner.workspace,...(owner.kind==='user'?{uid:owner.id}:{postId:owner.id}),note:owner.note,requestId});});actions.append(cancel,save);dialog.append(title,label,input,counter,error,actions);dialog.addEventListener('close',()=>{if(!dialog.open)owner=null;});dialog.addEventListener('cancel',()=>{owner=null;});input.addEventListener('input',()=>{const count=Array.from(input.value).length;counter.textContent=count+' / 2000 字 · 仅保存在本机';save.disabled=!!owner?.requestId||count>2000;error.hidden=true;});document.body.append(dialog);editor={dialog,title,input,counter,error,save};return editor;}
 function edit(kind,id,event){stop(event);if(!validId(id))return;const e=ensureEditor(),data=get(kind,id);owner=scope.capture({kind,id});e.title.textContent='备注 · '+(kind==='user'?(data?.nickname||'用户 '+id):(data?.author?data.author+' 的博文':'微博 '+id));e.input.value=noteText(data?.note);e.counter.textContent=Array.from(e.input.value).length+' / 2000 字 · 仅保存在本机';e.error.hidden=true;e.save.disabled=Array.from(e.input.value).length>2000;e.save.textContent='保存备注';e.dialog.showModal();e.input.focus();}
 function noteButton(kind,id){return button('备注','text-button entity-note-button',event=>edit(kind,id,event));}
 function actions(kind,id,{note=false}={}){const bar=node('div','entity-card-actions');bar.append(external(kind,id));if(note)bar.append(noteButton(kind,id));return bar;}
 // Reuse each page's existing detail button and preserve independent controls.
 function listRow(card,open){const owner=scope.capture(),selected=()=>{const selection=window.getSelection();return selection?.type==='Range'&&card.contains(selection.anchorNode);};card.classList.add('entity-list-row');card.setAttribute('role','listitem');card.addEventListener('click',event=>{if(event.target.closest('.user-open')&&selected()){event.preventDefault();event.stopPropagation();}},true);card.addEventListener('click',event=>{if(!scope.owns(owner)||event.target.closest('button,a,input,label,select,textarea,summary,details,.row-notice,.row-notices-popover,.entity-row-notices')||selected())return;open();});}
 function legacyTaskNoticeKey(task){const progress=value=>value?[value.kind,value.covered,value.budget,value.pending,value.pendingNew,value.targetCovered,value.caughtUp,value.resumable,value.reason,value.stopCode]:null,p=task.progressStatus;return JSON.stringify(['task',task.id,/^[a-f0-9]{64}$/.test(task.noticeToken||'')?task.noticeToken:[task.status,task.finishedAt,task.failureCode,task.reason,task.query?.mode,task.query?.source||'cli',task.query?._scopeId,null,p?[p.kind,p.resumable,p.targetCovered,p.dataState,p.missingBodyIds,(p.directions||[]).map(progress)]:null,task.summary?[task.summary.incomplete,task.summary.cancelled,task.summary.records,task.summary.addedRecords,(task.summary.sources||[]).map(source=>[source.kind,source.fetched,source.budget,source.failed,source.cancelled,source.reason,source.stopCode,progress(source.readProgress),source.update?.caughtUp,source.update?.protection?.latestSucceeded])]:null]]);}

 function taskNoticeKey(task){const summary=task.summary||{},sources=(summary.sources||[]).map(source=>{const p=source.readProgress||{},d=source.dataStatus||{},u=source.update||{};return [source.kind,source.fetched??p.covered,source.budget??p.budget,!!source.failed,!!source.cancelled,source.stopCode||source.autoStop?.code||'',source.reason||'',p.cursor||'',!!(p.pending??u.pending),!!(p.pendingNew??d.pendingNew??u.pending),!!(p.targetCovered??d.targetCovered)];});return JSON.stringify(['task-outcome-v2',task.id,task.query?.mode,task.status,!!summary.incomplete,!!summary.cancelled,summary.records,sources.length?sources:(task.progressStatus?.directions||[]).map(d=>[d.kind,d.covered,d.budget,!!d.pendingNew,!!d.targetCovered,d.reason||''])]);}
 function groupTasks(tasks){const groups=new Map();for(const task of tasks){const key=JSON.stringify([task.query?.source||'cli','',task.query?.mode,task.status,task.progressStatus?.targetCovered,task.progressStatus?.kind,(task.summary?.sources||[]).map(s=>[s.kind,s.stopCode||s.autoStop?.code||'',s.reason||'',!!s.failed,!!s.cancelled])]);const group=groups.get(key);if(group)group.count++;else groups.set(key,{task,count:1});}return [...groups.values()];}
 function taskNoticeOptions(kind,id,task){return {scope:state.workspace+'|'+kind+':'+id+'|'+(task.query?.source||'cli')+'|'+(''),sharedKey:'list-notice:'+taskNoticeKey(task),aliases:['list-notice:'+legacyTaskNoticeKey(task)],persistent:true,title:'仅隐藏这条提示，任务、数据、费用和订阅状态保留'};}
 function taskNotices(tasks,text='',detail=''){
  const resumable=tasks.filter(task=>canContinue(task)&&!task.noticeDismissed);
  return groupTasks(resumable).map(({task,count})=>({
   text:(interruptedTask(task)?'原任务意外中断':'待补区间')+(count>1?'（同类 '+count+' 项，详情见获取历史）':''),
   detail:interruptedTask(task)?'可继续上次未完成的读取。':'需要时可从获取历史补齐。',
   source:task.query?.source||'cli',key:taskNoticeKey(task),aliases:[legacyTaskNoticeKey(task)],className:'home-pending',
   ...(isMiddleGap(task)?{onDismiss:renderCurrentContinuations}:{})
  }));
 }
 function statusDetails(title,text,action){
  if(statusDialog?.open)statusDialog.close();
  const dialog=node('dialog','delete-dialog entity-status-dialog'),heading=node('h2','',title),message=text instanceof Node?text:node('p','entity-status-detail',text),actions=node('div','settings-actions');
  statusDialog=dialog;
  dialog.setAttribute('aria-label',title);
  if(action)actions.append(button(action.label,'button secondary',()=>{dialog.close();action.run();}));
  actions.append(button('关闭','button secondary',()=>dialog.close()));
  dialog.append(heading,message,actions);dialog.addEventListener('close',()=>{dialog.remove();if(statusDialog===dialog)statusDialog=null;});document.body.append(dialog);dialog.showModal();return dialog;
 }
 function infoTrigger(control,label){
  control.textContent='i';control.classList.add('entity-info-trigger');control.title=label;
  control.setAttribute('aria-label',label);control.setAttribute('aria-haspopup','dialog');return control;
 }
 function homeLoadStatus(section,id,retained,retry=()=>send({action:'library'})){
  retained=retained||state.homeLoading[section]?.snapshot===true;
  const status=renderHomeLoadStatus(section,id,retry),box=$(id);
  const list=$(({users:'home-users',posts:'post-home-list',subscriptions:'subscription-list'})[section]),heading=list.closest('.view').querySelector('.page-header>div');
  if(retained&&box.parentElement!==heading)heading.append(box);
  if(!retained&&box.nextElementSibling!==list)list.before(box);
  box.classList.toggle('entity-list-status-retained',retained);
  if(!retained||status==='ready')return status;
  retainedLoadStatus(box,status,box.firstElementChild?.textContent,'列表',retry);
  return status;
 }
 function retainedLoadStatus(box,status,message,kind,retry){
  if(status==='loading'){box.replaceChildren(node('span','','正在刷新'));return;}
  if(status!=='error')return;
  const captured=scope.capture(),heading='本地'+kind+'未能读取';
  const details=button('','entity-status-button',()=>statusDetails(heading,message||heading,{label:'重试读取',run:()=>{if(scope.owns(captured))retry();}}));
  box.replaceChildren(node('span','','读取失败'),infoTrigger(details,'查看'+kind+'读取失败详情'));
 }
 function renderedStatus(id){const item=$(id);return item?.getClientRects().length?item:null;}
 function statusText(item){return (item?.querySelector('.notice-copy')||item)?.textContent.trim()||'';}
 function statusClipped(item){const text=item?.querySelector('.notice-copy')||item;return text&&(text.scrollWidth>text.clientWidth+1||text.scrollHeight>text.clientHeight+1);}
 function setupDetailStatus(){
  const overview=document.querySelector('.entity-overview'),progress=document.querySelector('.task-progress-copy'),notices=document.querySelector('.entity-detail-notices');
  const progressDetails=$('progress-details'),progressMessage=$('progress-message'),progressLabel='查看任务进度详情',availabilityLabel='查看任务进度与记录缺失检测';
  const bind=(trigger,action,label)=>{const control=$(trigger);if(label)infoTrigger(control,label);control.addEventListener('click',action);};
  const taskStatus=()=>renderedStatus('progress-message');
  bind('inventory-details',()=>statusDetails('本地统计',statusText(renderedStatus('entity-inventory'))),'查看本地统计说明');
  bind('progress-details',()=>{
   const result=progressDetails.dataset.resultLabel,details=node('div','task-progress-details');
   const explanation=result?(progressMessage.hidden?'':statusText(progressMessage)):[$('progress-stage').textContent,statusText(taskStatus())].filter(Boolean).join('\n\n');
   if(explanation)details.append(node('p','entity-status-detail',explanation));
   const availability=result?null:taskAvailabilityDetails();if(availability)details.append(availability);
   const noticeKey=progressMessage.dataset.noticeKey,owner=scope.capture();
   const dismiss=result&&noticeKey?{label:'忽略提醒',run:async()=>{
    if(!scope.owns(owner)||progressMessage.dataset.noticeKey!==noticeKey)return;
    await window.ReaderNotices?.dismiss(progressMessage);
    if(progressMessage.hidden&&scope.owns(owner))$('start').focus({preventScroll:true});
   }}:null;
   const dialog=statusDetails(result?'上次获取说明':'任务进度详情',details,dismiss);
   dialog.id='task-progress-dialog';
   if(result){
    dialog.querySelector('.settings-actions button:last-child').focus();
    dialog.addEventListener('close',()=>{if(scope.owns(owner)&&progressMessage.dataset.noticeKey===noticeKey&&progressDetails.getClientRects().length)progressDetails.focus({preventScroll:true});},{once:true});
   }
  },progressLabel);
  bind('running-owner',()=>statusDetails('正在获取', $('running-owner').title));
  bind('profile-notice-jump',()=>{
   const target=renderedStatus('user-profile-status');if(!target)return;
   const owner=scope.capture({uid:ReaderIdentity.user(state)}),text=[...target.querySelectorAll('.profile-notice-message,.profile-notice-details p')].map(statusText).filter(Boolean).join('\n\n');
   statusDetails('用户资料提示',text,{label:'查看可用操作',run:()=>requestAnimationFrame(()=>{
    if(!scope.owns(owner)||ReaderIdentity.user(state)!==owner.uid||!renderedStatus('user-profile-status'))return;
    target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});
   })});
  },'查看用户资料提示');
  const display=(id,show)=>{const button=$(id);if(button.hidden===show)button.hidden=!show;};
  const update=()=>{
   const inventory=renderedStatus('entity-inventory');
   display('inventory-details',!!inventory&&!!statusClipped(inventory));
   const result=progressDetails.dataset.resultLabel,available=progressDetails.classList.contains('has-availability');
   const completed=$('task-card').classList.contains('is-result');
   const label=result?(result==='待补区间'?result:result+' · 查看说明'):available?availabilityLabel:progressLabel,text=result?label:'i';
   progressDetails.classList.toggle('entity-info-trigger',!result);
   if(progressDetails.textContent!==text)progressDetails.textContent=text;
   if(progressDetails.title!==label){progressDetails.title=label;progressDetails.setAttribute('aria-label',label);}
   display('progress-details',completed?!!result&&!progressMessage.hidden:available||!!statusClipped(taskStatus()));
   display('profile-notice-jump',!!renderedStatus('user-profile-status'));
  };
  const observer=new MutationObserver(update),attributes=['hidden','class','data-result-label'];
  for(const section of [overview,progress,notices])observer.observe(section,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:attributes});
  observer.observe($('task-card'),{attributes:true,attributeFilter:['class']});
  const resize=new ResizeObserver(update);resize.observe(overview);resize.observe(progress);update();
 }
 document.addEventListener('DOMContentLoaded',setupDetailStatus,{once:true});
 function closeRowNotices(){if(!rowPopover)return;rowPopover.panel.hidden=true;rowPopover.toggle.setAttribute('aria-expanded','false');rowPopover=null;}
 document.addEventListener('pointerdown',event=>{if(rowPopover&&!rowPopover.panel.contains(event.target)&&!rowPopover.toggle.contains(event.target))closeRowNotices();});
 window.addEventListener('resize',closeRowNotices);
 document.addEventListener('scroll',event=>{if(rowPopover&&!rowPopover.panel.contains(event.target))closeRowNotices();},true);
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&rowPopover){const toggle=rowPopover.toggle;closeRowNotices();if(toggle.isConnected)toggle.focus();event.preventDefault();}});
 function noticeSlot(card,kind,id,notices=[]){
  if(rowPopover&&!rowPopover.panel.isConnected)closeRowNotices();
  const owner=scope.capture(),slot=node('div','entity-row-notices'),toggle=button('i','row-notices-toggle',event=>{event.preventDefault();event.stopPropagation();if(!scope.owns(owner)||!card.isConnected)return;if(rowPopover?.panel===panel){closeRowNotices();return;}closeRowNotices();panel.hidden=false;toggle.setAttribute('aria-expanded','true');const anchor=toggle.getBoundingClientRect(),box=panel.getBoundingClientRect();panel.style.left=Math.max(12,Math.min(anchor.right-box.width,innerWidth-box.width-12))+'px';panel.style.top=Math.max(12,anchor.bottom+box.height+8<=innerHeight?anchor.bottom+8:anchor.top-box.height-8)+'px';rowPopover={panel,toggle};}),panel=node('div','row-notices-popover');
  panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-label','当前对象的提示');toggle.hidden=true;toggle.setAttribute('aria-label','查看当前对象的提示');toggle.setAttribute('aria-expanded','false');toggle.title='查看提示，可单独关闭';slot.append(toggle,panel);
  const sync=()=>{toggle.hidden=![...panel.children].some(line=>!line.hidden);if(toggle.hidden&&rowPopover?.panel===panel)closeRowNotices();};
  for(const item of notices){if(!item.text)continue;const line=node('span','row-notice '+(item.className||''),item.text);if(item.detail&&['user','post'].includes(kind))line.append(node('span','entity-notice-detail',item.detail));line.title=item.detail||item.text;line.setAttribute('aria-label',line.title);panel.append(line);window.ReaderNotices?.decorate(line,{...listNoticeOptions(kind,id,item),title:item.dismissTitle||'仅隐藏这条提示，任务、数据、费用和订阅状态保留',onVisibilityChange:sync,onError:error=>{if(scope.owns(owner))toast(error.message||'关闭提示未完成，请重试。',true);},onDismiss:()=>{if(scope.owns(owner))item.onDismiss?.();}});if(item.detail)line.title=item.text+' · '+item.detail;}
  (card.querySelector('.home-user-facts,.post-card-facts,.subscription-facts')||card).append(slot);sync();return slot;
 }

 function fact(label,value,detail=''){
  const row=node('div','card-fact'),body=node('span','card-fact-value',value);
  if(detail)body.append(node('span','card-fact-divider',' · '),node('span','card-fact-detail',detail));
  row.append(node('span','card-fact-label',label+'：'),body);row.title=row.textContent;return row;
 }
 function note(value,cls=''){const text=noteText(value);if(!text)return null;const box=node('div','entity-note '+cls);if(cls==='entity-card-note')box.title=text;box.append(node('span','entity-note-label','备注：'),document.createTextNode(text));return box;}
 function receive(event,kind){if(scope.observe(event)){pending.clear();closeRowNotices();close();if(editor){editor.input.value='';editor.counter.textContent='';editor.error.hidden=true;editor.save.disabled=false;editor.save.textContent='保存备注';}return false;}const success=kind==='user'?'userNoteSaved':'postNoteSaved',failure=kind==='user'?'userNoteError':'postNoteError';if(event.type!==success&&event.type!==failure)return false;const request=pending.get(event.requestId),id=kind==='user'?event.uid:event.postId;if(!request||event.workspace!==request.workspace||!scope.owns(request,event)||request.kind!==kind||request.id!==id)return false;if(event.type===success&&typeof event.note!=='string')return false;pending.delete(event.requestId);const active=owner?.requestId===event.requestId&&owner.kind===kind&&owner.id===id;if(event.type===success){for(const entry of kind==='user'?[...(state.homeUsers||[]),...(state.accounts||[])]:state.posts||[])if((kind==='user'?entry.uid:entry.postId)===id)entry.note=event.note;if(active)close();window.renderFavorites?.();return true;}if(active){owner=scope.capture({kind,id});editor.save.disabled=false;editor.save.textContent='保存备注';editor.error.textContent=event.message||'备注保存失败，请重试。';editor.error.hidden=false;window.ReaderNotices?.decorate(editor.error,{scope:state.workspace+'|'+kind+':'+id,key:event.requestId});}return false;}
 root.ReaderEntityActions={...api,external,actions,fact,note,noteButton,edit,close,receive,listRow,noticeSlot,homeLoadStatus,retainedLoadStatus,statusDetails,taskNoticeKey,legacyTaskNoticeKey,groupTasks,taskNoticeOptions,taskNotices,taskAcknowledgments,canContinue,isMiddleGap,closeResume,listNoticeOptions,installClearNotices,renderContinuations,renderHistoryContinuations,showsContinuation,resumeTask,resumeReceive,gapChoiceReceive,refreshContinuationChoices:()=>refreshChoices?.()};
})(globalThis);
