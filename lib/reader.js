'use strict';
const {sourceIncomplete}=require('./limits');
const {recoveryNote,provenanceBadge,provenanceDetails}=require('./completeness');
const {CONVERSATION_HEADING_STYLE,MODES,ENDPOINTS,text,positiveId,hasBefore,beforeDisplay,esc,linkedText,CONTENT_LINK_VERSION,POST_LINKS_STYLE,postPictures,mergePostPictures,postPicturesHtml,POST_PICTURES_STYLE,ts,postLink,userLink,replyPrefixParts,readingText,commentBodyHtml,copyButton,READING_STYLE,COPY_STYLE,COPY_SCRIPT}=require('./core');
const {directionOf,unreadButtons,timeTag,detailsFor,searchFields,itemAttrs,dayKey,browserTemplates}=require('./reader-templates');
function isMention(r){return r.group==='mentions-comments'||r.group==='mentions-posts';}
const {recordKey}=require('./records');
const MENTION_BODY_STYLE='[data-standalone-post]>.post-heading:before{display:none}[data-standalone-post]>.post-heading{cursor:default}';
function attributeRows(rows,uid){
  const records=new Map(rows.filter(r=>r.recordId&&r.postId&&r.group!=='mentions-posts').map(r=>[`${r.postId}:${r.recordId}`,r]));
  return rows.map(original=>{
    const r={...original,targetUid:uid};
    const parent=r.replyId&&r.postId?records.get(`${r.postId}:${r.replyId}`):null;
    if(parent&&parent.recordId!==r.recordId){
      if(!r.replyAuthorUid){r.replyAuthorUid=parent.authorUid;r.replyAuthor=parent.author;}
      if(!r.replyText){r.replyText=parent.content;r.replyTime=parent.time;}
    }
    r.replyInRows=!!parent;
    r.isReply=!!(r.replyId||r.replyAuthorUid||r.replyAuthor||(r.rootId&&r.rootId!==r.recordId));
    r.isTopLevel=!!(!r.isReply&&r.recordId&&r.rootId===r.recordId);
    if(r.group==='post-comments'){
      r.interactionDirection=r.authorUid&&r.postAuthorUid?(r.authorUid===r.postAuthorUid?'sent':'received'):'other';
      r.peerUid=r.authorUid;r.peerName=r.author;r.peerKey=r.authorUid?`uid:${r.authorUid}`:'unknown';return r;
    }
    let peerUid='',peerName='',direction='other';
    if(isMention(r)){
      peerUid=r.authorUid;peerName=r.author;
    }else if(r.authorUid===uid||directionOf(r)==='sent'){
      direction='sent';
      // A reply belongs to its explicit recipient, not automatically to the post owner.
      if(r.isReply){peerUid=r.replyAuthorUid;peerName=r.replyAuthor;}
      else if(r.isTopLevel){peerUid=r.postAuthorUid;peerName=r.postAuthor;}
    }else if(directionOf(r)==='received'||r.type==='发出/收到'){
      direction='received';peerUid=r.authorUid;peerName=r.author;
    }
    r.interactionDirection=direction;
    r.peerUid=positiveId(peerUid);r.peerName=text(peerName).trim()||r.peerUid;
    r.peerKey=!r.peerUid?'unknown':!isMention(r)&&r.peerUid===uid?'self':`uid:${r.peerUid}`;
    return r;
  });
}
function rankUsers(rows){
  const users=new Map(),seen=new Set();let unknown=0,self=0;
  for(const r of rows){
    if(r.isContext)continue;
    const key=recordKey(r);if(seen.has(key))continue;seen.add(key);
    if(r.peerKey==='unknown'){unknown++;continue;}
    if(r.peerKey==='self'){self++;continue;}
    if(!users.has(r.peerUid))users.set(r.peerUid,{uid:r.peerUid,name:r.peerName,total:0,sent:0,received:0,last:0});
    const entry=users.get(r.peerUid);entry.total++;
    if(r.interactionDirection==='sent')entry.sent++;
    if(r.interactionDirection==='received')entry.received++;
    if((r.ms??0)>entry.last){entry.last=r.ms??0;entry.name=r.peerName||entry.name;}
  }
  const entries=[...users.values()].sort((a,b)=>b.total-a.total||b.last-a.last||a.uid.localeCompare(b.uid));
  return {entries,unknown,self,total:seen.size,ranked:entries.reduce((n,u)=>n+u.total,0)};
}
function countingNote(kind='comments'){
 const lines=kind==='post-comments'?[
  '<strong>计数对象：</strong>按评论作者统计。每条评论及已获取的楼中楼回复各计 1 条，包括原博主自己的评论和回复。',
  '<strong>重复与引用：</strong>同一条评论只计 1 次；“引用补充”来自其他评论附带的内容，仅供阅读，不计入评论数。'
 ]:kind==='mentions'?[
  '<strong>计数对象：</strong>按发布者统计。每条提及目标用户的微博或评论计 1 次；同一条内容中多次 @ 目标用户，仍只计 1 次。',
  '<strong>历史补全与引用：</strong>此前已保存、本次补回的记录计入排名；“引用补充”仅供阅读，不计数。'
 ]:[
  '<strong>发出：</strong>目标用户回复某用户的评论，计入该用户名下；直接评论一条微博时，计入原微博作者名下。',
  '<strong>收到：</strong>按发来评论的作者统计，包括目标用户微博下收到的评论，不一定都是直接回复目标用户。',
  '<strong>条数与合计：</strong>同一条评论只计 1 次，每位用户的合计为发出与收到的条数之和。例如，目标用户向 A 发出 3 条评论、收到 A 的 2 条评论，则 A 的合计为 5 条。',
  '<strong>单列记录：</strong>无法确认互动对象的评论，以及目标用户与自身的互动，单独列出，不计入其他用户的排名。',
  '<strong>历史补全：</strong>此前已保存、本次补回的评论，去重后计入排名；这不表示它目前仍可在微博查看。',
  '<strong>引用补充：</strong>用于补充对话上下文的引用内容或本地已保存评论，不计入本报告的正式条数或排名。'
 ];
 lines.push('<strong>用户识别：</strong>按账号唯一标识（UID）区分用户。同一账号更改昵称仍合并统计；不同账号即使昵称相同，也分别统计。',
  '<strong>统计范围：</strong>仅统计本报告中的记录。搜索和筛选只改变下方显示的内容，不改变排行榜。');
 return '<details class="counting-note"><summary>统计口径</summary><ul>'+lines.map(line=>'<li>'+line+'</li>').join('')+'</ul></details>';
}
function rankingHtml(ranking,mentions,mixed=false){
  const entries=ranking.entries,max=entries[0]?.total||1;
  const body=entries.map((u,i)=>`<tr><td class="rank-number">${i+1}</td><td class="rank-user">${userLink(u.name,u.uid)}<span class="uid">UID ${esc(u.uid)} ${copyButton(u.uid,'UID')}</span><span class="rank-track"><span class="rank-bar" style="width:${Math.round(u.total/max*100)}%"></span></span></td>
    ${mentions?'':`<td class="sent-number">${u.sent}</td><td class="received-number">${u.received}</td>`}<td class="rank-total">${u.total} ${mentions?'次':'条'}</td>
    <td><button type="button" class="rank-filter" data-peer-button="uid:${u.uid}" aria-pressed="false">${mentions?'查看记录':'查看对话'}</button></td></tr>`).join('');
  const exceptions=[ranking.unknown?`对象或 UID 未确认 ${ranking.unknown} 条`:'',ranking.self?`本人对自己的评论 ${ranking.self} 条`:''].filter(Boolean);
  return `<section class="panel ranking" aria-label="${mentions?'被@次数排行榜':'互动次数排行榜'}">
    <div class="ranking-heading"><div><h2>${mixed?'互动与提及记录':mentions?'被谁 @ 了多少次':'跟谁互动了多少条'}</h2><p>${entries.length} 位用户 · ${ranking.ranked} 条${mixed?'可归属的互动与被 @ 记录':mentions?'被 @ 记录':'可归属的互动记录'}${exceptions.length?` · ${esc(exceptions.join(' · '))}`:''}</p></div><span class="scope-label">本文件统计</span></div>
    ${entries.length?`<div class="rank-scroll"><table class="rank-table"><thead><tr><th>排名</th><th>用户</th>${mentions?'':'<th>发出</th><th>收到</th>'}<th>${mentions?'被 @ 次数':'合计'}</th><th>记录</th></tr></thead><tbody>${body}</tbody></table></div>`:'<p class="rank-empty">暂无可按 UID 确认的排行；仍可在下方阅读全部记录。</p>'}
    ${countingNote(mentions?'mentions':'comments')}${mixed?'<p class="ranking-note">发出、收到仅统计评论互动；被 @ 记录另计，合计可能大于两项之和。</p>':''}
  </section>`;
}
// Simplify comment reading text; preserve the complete raw text for details and search.
function postHeadingText(row){
  if(row.group==='mentions-posts')return row.postId&&row.recordId===row.postId?text(row.content):'';
  return row.postText||'';
}
function mentionedPostCard(r,i){
 const author=require('./post-links').confirmedAuthor([r],r.postId),name=r.postAuthor||'',body=postHeadingText(r),badges=unreadButtons([r]).replace(/title="[^"]*"/g,'title="定位这条未读微博"');
 return `<article class="post-group" data-post-group data-standalone-post data-record-ids="${i}" data-post-id="${esc(r.postId)}"><div class="post-heading" ${itemAttrs(r,i)}><span class="post-summary-main"><span class="post-origin-line"><span class="source-label">原微博作者：</span>${name||author?userLink(name,author):'<span class="muted">未返回</span>'}${postLink(r.postId,'原文：',author)}${copyButton(r.postId,'微博 ID')}</span>${r.postTime?`<span class="post-origin-time">发布时间：${esc(r.postTime)}</span>`:''}${body?`<span class="post-heading-text">${linkedText(body)}</span>`:''}${postPicturesHtml(r.postPictures,r.postId)}</span><span class="post-heading-badges"><span data-group-unread${badges?'':' hidden'}>${badges}</span></span></div><div class="thread-body" hidden></div></article>`;
}
function groupPosts(rows){
  const groups=new Map();
  rows.forEach((r,i)=>{
    const id=r.postId?`${r.group==='mentions-posts'?'mentioned-post':'post'}:${r.postId}`:`missing:${i}`;
    if(!groups.has(id))groups.set(id,{id,postId:r.postId,author:r.postAuthor,authorUid:r.postAuthorUid,postText:postHeadingText(r),postTime:r.postTime,postPictures:postPictures(),isPost:r.group==='mentions-posts',entries:[]});
    const g=groups.get(id);g.entries.push({r,i});
    g.postPictures=mergePostPictures(g.postPictures,r.postPictures);
    if(!g.author&&r.postAuthor)g.author=r.postAuthor;
    if(!g.authorUid&&r.postAuthorUid)g.authorUid=r.postAuthorUid;
    if(!g.postText)g.postText=postHeadingText(r);
    if(!g.postTime&&r.postTime)g.postTime=r.postTime;
  });
  for(const g of groups.values())g.authorUid=require('./post-links').confirmedAuthor(g.entries.map(e=>e.r),g.postId);return [...groups.values()];
}
function rootOf(r,all){
 if(!all.rootMemo){all.rootMemo=new Map();all.referenced=new Set([...all.values()].flatMap(x=>[x.replyId,x.rootId]).filter(Boolean));}
 const visited=new Set(),chain=[];let current=r,root='';
 while(current){if(current.recordId&&visited.has(current.recordId)){root='';break;}if(all.rootMemo.has(current.recordId)){root=all.rootMemo.get(current.recordId);break;}if(current.recordId){visited.add(current.recordId);chain.push(current.recordId);}if(current.rootId){root=current.rootId;break;}if(current.replyId){if(!all.has(current.replyId)){root=current.replyId;break;}current=all.get(current.replyId);continue;}if(current.recordId&&(visited.size>1||all.referenced.has(current.recordId)))root=current.recordId;break;}
 for(const id of chain)all.rootMemo.set(id,root);return root;
}
// Merge only actual quoted payloads. Formal records always win; quote-only rows never affect ranking.
function buildConversationRows(rows,supplemental=[]){
  const mains=rows.map(r=>({...r}));
  const keyFor=(postId,id)=>`${postId}:${id}`;
  const formal=new Set(mains.filter(r=>r.postId&&r.recordId&&r.group!=='mentions-posts').map(r=>keyFor(r.postId,r.recordId)));
  const contexts=new Map();
  for(const extra of supplemental){
    if(!extra.isContext||!positiveId(extra.recordId)||!positiveId(extra.postId)||!text(extra.content).trim())continue;
    const key=keyFor(extra.postId,extra.recordId);if(formal.has(key))continue;
    const refs=[...new Set(extra.contextFor||[])].filter(i=>Number.isInteger(i)&&mains[i]?.postId===extra.postId);
    if(refs.length)contexts.set(key,{...extra,contextFor:new Set(refs)});
  }
  mains.forEach((r,i)=>{
    if(!r.postId||r.group==='mentions-posts')return;
    let quoted=r.replyRecord;
    if(!quoted&&r.replyId&&r.replyText){
      const time=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.replyTime||'')
        ?Date.parse(r.replyTime.replace(' ','T')+'+08:00'):null;
      quoted={recordId:r.replyId,rootId:'',author:r.replyAuthor,authorUid:r.replyAuthorUid,content:r.replyText,time:r.replyTime||'未知',ms:time};
    }
    if(!quoted?.recordId||!text(quoted.content).trim())return;
    const key=keyFor(r.postId,quoted.recordId);
    if(formal.has(key))return;
    if(!contexts.has(key)){
      contexts.set(key,{...quoted,shareView:r.shareView,type:'引用补充',group:'context',isContext:true,
        postId:r.postId,postAuthor:r.postAuthor,postAuthorUid:r.postAuthorUid,postText:r.postText,postTime:r.postTime,postPictures:r.postPictures,
        rootId:quoted.rootId||r.rootId,interactionDirection:quoted.authorUid&&r.targetUid?(quoted.authorUid===r.targetUid?'sent':'received'):'other',
        isReply:!!(quoted.replyId||quoted.replyAuthorUid||(quoted.rootId&&quoted.rootId!==quoted.recordId)),
        contextFor:new Set(),contextSortMs:r.ms,peerKey:'context',peerUid:'',peerName:''});
    }
    const context = contexts.get(key);
    context.contextFor.add(i);
    const prefix=replyPrefixParts(context.content);
    if(prefix){
      context.displayReplyAuthor=prefix.name;
      context.displayReplyAuthorUid=prefix.name===context.replyAuthor?context.replyAuthorUid:'';
    }
    if(Number.isFinite(r.ms))context.contextSortMs=Number.isFinite(context.contextSortMs)?Math.min(context.contextSortMs,r.ms):r.ms;
    r.replyInConversation=true;
  });
  for (const context of contexts.values()) context.contextFor = [...context.contextFor];
  return [...mains, ...contexts.values()];
}
function conversationAttrs(r,i){
  if(!r.isContext)return itemAttrs(r,i);
  return `data-context data-comment-id="${esc(r.recordId)}" data-context-for="${r.contextFor.join(',')}" data-context-source="${esc(r.contextSource||'quote')}" data-search="${searchFields(r)}" data-author-uid="${esc(positiveId(r.authorUid))}"`;
}
function groupCountLabel(items){
  const main=items.filter(({r})=>!r.isContext).length,context=items.length-main;
  return `${main} 条${context?` + ${context} 引用`:''}`;
}
function conversationHtml(rows,supplemental=[],lazy=false,postOrder={},postAuthor=null){
  const {exactIdOrder}=require('./comment-order');
  const conversations=groupPosts(buildConversationRows(rows,supplemental)).map(g=>({g,items:g.entries,last:g.entries.reduce((latest,x)=>Math.max(latest,x.r.ms??0),0)}));
  conversations.sort((a,b)=>b.last-a.last);
  return conversations.map(({items,g})=>{
    if(items.length===1&&items[0].r.group==='mentions-posts'&&items[0].r.recordId===g.postId)return mentionedPostCard(items[0].r,items[0].i);
    const ordered=items.slice().sort((a,b)=>(a.r.ms??a.r.contextSortMs??Infinity)-(b.r.ms??b.r.contextSortMs??Infinity)||Number(!!b.r.isContext)-Number(!!a.r.isContext)||
      (a.r.group==='post-comments'&&b.r.group==='post-comments'?(postOrder[a.r.recordId]-postOrder[b.r.recordId]||exactIdOrder(a.r.recordId,b.r.recordId)):0)||a.i-b.i);
    const recordMap=new Map(items.filter(({r})=>r.recordId&&r.group!=='mentions-posts').map(({r})=>[r.recordId,r]));
    const branches=new Map(),entryBranch=new Map();
    for(const {r,i} of ordered){
      const root=rootOf(r,recordMap),key=root?`root:${root}`:'unlinked';
      if(!branches.has(key))branches.set(key,{root,index:branches.size+1});
      entryBranch.set(i,branches.get(key));
    }
    const roots=[...branches.values()].map(branch=>branch.root).filter(Boolean);
    const root=branches.size===1?(roots[0]||''):'';
    const people=new Map();
    for(const {r} of ordered)for(const [id,name,url] of [[r.authorUid,r.author,r.authorUrl],[r.replyAuthorUid,r.replyAuthor,'']]){
      if(!id&&!name)continue;
      const key=id||url||`name:${name||'未知用户'}`;if(!people.has(key))people.set(key,{id,name,url});
    }
    const names=[...people.values()].slice(0,4).map(u=>userLink(u.name,u.id,u.url)).join('<span class="person-sep">、</span>');
    const extra=people.size>4?` 等 ${people.size} 人`:'';
    const latest=ordered.findLast(({r})=>r.ms!=null)?.r.time||'时间未知';
    let day='';
    const cardParts=ordered.map(({r,i})=>{
      let divider='';const date=dayKey(r);
      if(date!==day){divider=`<div class="day-divider" data-day-group><span data-day="${esc(date)}">${esc(date)}</span></div>`;day=date;}
      const branch=entryBranch.get(i);
      return `${divider}<article class="bubble-row bubble-${r.interactionDirection||directionOf(r)}${r.isContext?' bubble-context':''}" ${conversationAttrs(r,i)} data-branch="${branch.index}" data-branch-root="${esc(branch.root)}" data-message-day="${esc(date)}"><div class="bubble-wrap"><div class="bubble-meta"><strong class="message-author">${userLink(r.author,r.authorUid,r.authorUrl)}</strong>${!r.isContext&&r.isUnread?'<span class="unread-record-badge">未读</span>':''}${r.isNew?'<span class="new-record-badge">新增</span>':''}${r.isContext?`<span class="context-badge" title="${r.shareView?'对话前文，仅供阅读':r.contextSource==='local-cache'?'来自本地此前保存的同一对话，仅补充阅读，不计入正式条数或排行榜':'来自其他评论的引用补充，不计入排行榜'}">${r.shareView?'前文':'引用补充'}</span>`:''}${provenanceBadge(r)}${timeTag(r,true)}${detailsFor(r,true)}</div><div class="bubble-content">${commentBodyHtml(r)}</div></div></article>`;
    });const cards=lazy==='paged'?{entries:ordered.map(({r,i},n)=>({index:i,context:!!r.isContext,refs:r.contextFor||[],html:cardParts[n]}))}:cardParts.join('');
    const scoped=postAuthor?.postId===g.postId,authorUid=scoped?postAuthor.uid:g.authorUid,authorName=scoped?postAuthor.nickname:g.author;
    const origin=`<span class="post-origin-line"><span class="source-label">原微博作者：</span>${authorName||authorUid?userLink(authorName,authorUid):'<span class="muted">未返回</span>'}${g.postId?postLink(g.postId,'原文：',authorUid)+copyButton(g.postId,'微博 ID'):'<span class="muted">原微博 ID 未返回</span>'}</span>`;
    const published=g.postTime?`<span class="post-origin-time">发布时间：${esc(g.postTime)}</span>`:'';
    const originalText=g.postText?`<span class="post-heading-text">${linkedText(g.postText)}</span>`:g.isPost?'':'<span class="post-heading-text muted">原微博正文未返回</span>';
    const participants=g.isPost?'':`<span class="conversation-people"><span class="source-label">参与者：</span>${names||'用户信息未返回'}${extra}</span><span class="conversation-latest">最近记录 ${esc(latest)}</span>`;
    const basis=branches.size>1?`同一原微博下的记录；回复对象可在每条详情中查看`:root?`回复分组 ID：${root}；回复对象可在每条详情中查看`:'按时间展示；回复对象见详情，未推断具体父评论';
    return `<details class="post-group" data-post-group data-root="${esc(root)}" data-record-ids="${items.filter(x=>!x.r.isContext).map(x=>x.i).join(',')}" data-post-id="${esc(g.postId)}" data-branch-count="${branches.size}" data-roots="${esc(roots.join(' '))}"><summary class="post-heading" data-author-uid="${esc(authorUid)}" title="${esc(basis)}"><span class="post-summary-main">${origin}${published}${originalText}${postPicturesHtml(g.postPictures,g.postId)}${participants}</span><span class="post-heading-badges"><span class="post-count" data-group-count>${groupCountLabel(items)}</span><span data-group-unread${items.some(({r})=>!r.isContext&&r.isUnread)?'':' hidden'}>${unreadButtons(items.map(({r})=>r))}</span></span></summary><div class="post-body"><div class="thread-body">${lazy?'':cards}</div>${lazy?'<script type="application/json" data-lazy-thread>'+require('./report-records').jsonPayload(cards)+'</script>':''}</div></details>`;
  }).join('');
}
function timeRange(rows) {
 let oldest = Infinity, newest = -Infinity;
 for (const {ms} of rows) {
  if (!Number.isFinite(ms)) continue;
  oldest = Math.min(oldest, ms);
  newest = Math.max(newest, ms);
 }
 return oldest === Infinity ? {oldest:null, newest:null} : {oldest, newest};
}
function coverageInfo(meta){
  return meta.map(source=>{
    const rows = source.rows || [];
    return {kind:source.kind,label:ENDPOINTS[source.kind]?.label||source.kind,count:rows.length,
      ...timeRange(rows),
      cachedCalls:source.cachedCalls||0,apiCalls:(source.requests||0)-(source.cachedCalls||0),
      cacheTimes:[...new Set(source.cacheTimes||[])].filter(Number.isFinite).sort((a,b)=>a-b)};
  });
}
function render(o,inputRows,meta,label){
 if(o.shareReport&&!o._publicRendered)return require('./share-report').renderShared(o,inputRows,meta,label,render);
  const evidence=[...inputRows,...(o.conversationContext||[]),...(o.postAuthors||[])],linkAuthors=require('./post-links').authorIndex(evidence);o={...o,conversationContext:(o.conversationContext||[]).map(r=>({...r,postLinkAuthor:linkAuthors[r.postId]||''}))};
  const newKeys=new Set(o.updateInfo?.newKeys||[]),rows=attributeRows(inputRows,o.uid).map(row=>({...row,postLinkAuthor:linkAuthors[row.postId]||'',isNew:newKeys.has(recordKey(row))})),ranking=rankUsers(rows),mentions=o.mode.startsWith('mentions-'),postMode=o.mode==='post-comments';
  const colorModel=require('./reader-colors').colorModel(o,inputRows,o.conversationContext||[],ranking.entries.map(u=>u.uid));
  const heading=`${label} · ${o.unreadContext?'未读互动':o.unreadOnly?'未读评论':o.mergeInfo?'互动总报告':MODES[o.mode]}`;
  const unreadScope=o.unreadContext?' · '+require('./share-report').unreadContextLabel(rows):'';
  const types=[...new Set(rows.map(r=>r.type))];
  const typeOptions=['<option value="">全部类型</option>',...types.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`)].join('');
  const peerOptions=['<option value="">全部用户</option>',...ranking.entries.map(u=>`<option value="uid:${u.uid}">${esc(u.name)} · ${u.uid}（${u.total}）</option>`),ranking.unknown?'<option value="unknown">对象 / UID 未确认</option>':'',ranking.self?'<option value="self">本人对自己</option>':''].join('');
  const {oldest, newest} = timeRange(rows);
  const range = oldest === null ? '未返回可识别时间' : `${ts(new Date(oldest).toISOString()).display} — ${ts(new Date(newest).toISOString()).display}`;
  const subtitle=postMode?`目标微博：${postLink(o.postId,'打开微博',linkAuthors[o.postId])}${copyButton(o.postId,'微博 ID')} · 原作者：${require('./reader-visual').originalAuthor(evidence,o.postId)} · ${rows.length} 条去重评论`:`目标用户：${userLink(label,o.uid)} · UID ${esc(o.uid)} · ${rows.length} 条去重记录${require('./record-availability').availabilityNote(meta)}${o.recoveryInfo?'<span class="recovery-note"> · 已取回记录，本地重建</span>':""}${o.mergeInfo?` · 本地合并 ${o.mergeInfo.sourceCount} 份报告（已保存记录）`:""}`;
  const partial=meta.some(sourceIncomplete),partialReasons=meta.filter(sourceIncomplete).map(m=>m.reason).filter(Boolean).join('；');
  const replyGap=meta.some(m=>m.incompleteReplies?.length),incrementalGap=meta.map(m=>m.update?.gap).find(g=>g&&(g.unresolvedIds?.length||g.unidentifiedMissing));
  const status=partial?` <span class="report-state" title="${esc(partialReasons)}">· 查询未完成</span>`:incrementalGap?`<span class="report-state"> · 增量区间仍缺 ${incrementalGap.unresolvedIds.length} 个已知 ID${incrementalGap.unidentifiedMissing?"，另有未定位缺失":""}</span>`:replyGap?'<span class="report-state"> · 部分回复未取得</span>':'';
  const cutoff=hasBefore(o)?`截至 ${esc(beforeDisplay(o))}（包含所选当天） · `:'';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(heading)}</title>
<style>
${COPY_STYLE}${POST_LINKS_STYLE}${MENTION_BODY_STYLE}
${READING_STYLE}${CONVERSATION_HEADING_STYLE}
${POST_PICTURES_STYLE}${require('./core').COMMENT_PICTURES_STYLE}${require('./reader-paged').FLOW_STYLE}
${require('./reader-visual').style('comments')}
</style></head><body data-report-visual="${require('./reader-visual').VERSION}" data-comment-picture-version="${require('./core').COMMENT_PICTURE_VERSION}" data-mention-body-version="3" data-content-link-version="${CONTENT_LINK_VERSION}" data-post-link-version="7" data-reader-version="2" data-conversation-layout-version="1" data-conversation-window-version="1" data-history-version="3" data-color-mode="${postMode?'posts':'users'}"${postMode?' data-comment-order="1"':''} data-target-uid="${esc(o.uid||'')}"><main>
<header class="report-header"><h1>${esc(heading)}</h1><p class="subtitle">${subtitle}${unreadScope}${recoveryNote(rows)}${status}<br>${o.database?'本地导出：'+esc(require('./date-range').label(o.from,o.to,'全部已保存日期'))+'；仅含已保存记录 · 新增费用 0 credits<br>':''}${o.updateInfo?'更新批次：'+esc(ts(o.updateInfo.updatedAt).display)+' · 本报告含新增 '+rows.filter(r=>r.isNew).length+' / 本次新保存 '+o.updateInfo.addedTotal+' 条<br>':''}${cutoff}记录时间：${esc(range)} · 仅反映本次导出的记录</p></header>
${postMode?postRankingHtml(ranking):rankingHtml(ranking,mentions,o.mode==='all')}
<div class="panel">${o.updateInfo?`<div class="new-record-tools"><button type="button" id="new-only" aria-pressed="true">只看新增（${rows.filter(r=>r.isNew).length}）</button><button type="button" id="new-all" aria-pressed="false">本报告全部（${rows.length}）</button><button type="button" id="new-prev">上一条新增</button><button type="button" id="new-next">下一条新增</button><span>新增指本次首次保存的独立记录，引用不计数。</span></div>`:''}<div class="toolbar" id="record-toolbar"><input type="search" id="q" placeholder="搜索昵称、正文、原微博" aria-label="搜索记录"><select id="type" aria-label="筛选记录类型">${typeOptions}</select>${['sent','received','both','all'].includes(o.mode)?'<select id="direction" aria-label="筛选互动方向"><option value="">全部互动</option><option value="sent">只看发出</option><option value="received">只看收到</option></select>':''}<select id="peer" aria-label="筛选用户">${peerOptions}</select><button id="clear" type="button">清空筛选</button><span class="counter" id="stats">显示 ${rows.length} / ${rows.length} 条</span>
<div class="view-switch" role="tablist" aria-label="阅读模式"><button type="button" role="tab" aria-selected="true" data-view-button="conversation" aria-controls="conversation">${o.mode==='mentions-posts'?'微博卡片':mentions?'折叠记录':'折叠对话'}</button><button type="button" role="tab" aria-selected="false" data-view-button="timeline" aria-controls="timeline" tabindex="-1">时间线</button></div></div>
<div id="conversation" class="view" role="tabpanel" data-view="conversation" data-dialog-order="branches"><div class="dialog-tools"${o.mode==='mentions-posts'?' hidden':''}><div class="dialog-order-switch" role="group" aria-label="对话排列方式"><button type="button" data-dialog-order="branches" aria-pressed="true">按分支</button><button type="button" data-dialog-order="time" aria-pressed="false">时间顺序</button></div><button type="button" id="expand-all">全部展开</button><button type="button" id="collapse-all">全部收起</button></div>${conversationHtml(rows,o.conversationContext||[],rows.length>200?'paged':!!o.lazyConversations,o.commentOrder,colorModel.postAuthor)}</div>
<div id="timeline" class="view" role="tabpanel" data-view="timeline" hidden></div><p id="empty-state" class="empty-state" hidden>没有符合筛选条件的记录，可点击“清空筛选”。</p></div>
</main>
<script type="application/json" id="weibo-report-records">${require('./report-records').jsonPayload({schema:2,paged:rows.length>1000,uid:o.uid,rows,updateInfo:o.updateInfo||null,context:o.conversationContext||[],...(o.unreadContext?{unreadContext:true}:{})})}</script>
<script>(()=>{
${browserTemplates(!!o.shareReport)}
const startPagedReader=${require('./reader-paged').startPagedReader.toString()};
(${require('./reader-runtime').startReader.toString()})();
${COPY_SCRIPT}
})();${require('./post-ownership').OWNERSHIP_SCRIPT}</script>${require('./reader-mobile').markup()}${require('./reader-colors').markup(colorModel)}</body></html>`;
}
function postCollectionHtml(o,meta){
 const source=meta.find(m=>m.kind==='post-comments');if(!source)return '';
 return `<section class="collection-status" aria-label="评论采集状态"><strong>采集状态：${esc(source.reason)}</strong>${source.reportedTotal!=null?`<p>接口报告总数 ${source.reportedTotal}，本文件 ${source.rows.length} 条独立记录；两者口径可能不同。</p>`:''}${source.incompleteReplies?.length?`<p>有 ${source.incompleteReplies.length} 个分组报告的回复数多于实际返回数，可能缺少楼中楼；当前接口未提供独立楼中楼续取参数。</p>`:''}<p>已保留接口返回的楼中楼；引用补充单独标注、不计排行榜。接口不可见、已删除或未返回的内容无法补齐，分页结束不代表已核实微博全部历史。</p></section>`;
}
function postRankingHtml(ranking){
 const max=ranking.entries[0]?.total||1;
 const body=ranking.entries.map((u,i)=>`<tr><td class="rank-number">${i+1}</td><td class="rank-user">${userLink(u.name,u.uid)}<span class="uid">UID ${esc(u.uid)} ${copyButton(u.uid,'UID')}</span><span class="rank-track"><span class="rank-bar" style="width:${Math.round(u.total/max*100)}%"></span></span></td><td class="rank-total">${u.total} 条</td><td><button type="button" class="rank-filter" data-peer-button="uid:${u.uid}" aria-pressed="false">查看评论</button></td></tr>`).join('');
 return `<section class="panel ranking" aria-label="评论者排行榜"><div class="ranking-heading"><div><h2>谁评论了多少条</h2><p>${ranking.entries.length} 位用户 · ${ranking.ranked} 条可确认作者 UID 的评论${ranking.unknown?` · 作者 UID 未确认 ${ranking.unknown} 条`:''}</p></div><span class="scope-label">本文件统计</span></div>${body?`<div class="rank-scroll"><table class="rank-table"><thead><tr><th>排名</th><th>用户</th><th>评论数</th><th>记录</th></tr></thead><tbody>${body}</tbody></table></div>`:'<p class="rank-empty">暂无可按 UID 确认的排行。</p>'}${countingNote('post-comments')}</section>`;
}


module.exports={mentionedPostCard,MENTION_BODY_STYLE,postHeadingText,countingNote,render,attributeRows,rankUsers,rootOf,coverageInfo,buildConversationRows,recordKey,postCollectionHtml,postRankingHtml};
