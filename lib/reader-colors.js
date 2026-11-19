'use strict';
// One presentation policy for exact account identities, including lazy views.
const VERSION='4';
const LEGACY_SCRIPT_HASHES={
 1:'c86ba4543a2645fc53752e4f62837c8b499914b2b02163805d66c7c4934820e9',
 2:'15d06889ad40d0d849cb14e10b307ea0ab821ec35bb9ae55408fa6704d8370aa',
 3:'8699514a875556edde24cef3822c1e67f523a879998576aac4d3332114da57be'
};
function accountColors(values,mode='post-comments',targetUid='',priority=[]){
 const exact=value=>typeof value==='string'&&/^[0-9]{1,20}$/.test(value)&&BigInt(value)>0n?value:'';
 const ids=[...new Set(values.map(exact).filter(Boolean))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:a.localeCompare(b));
 const targets=new Set((Array.isArray(targetUid)?targetUid:[targetUid]).map(exact).filter(Boolean));
 const blue='#1f5fbf',green='#28764a';
 if(mode!=='post-comments')return new Map(ids.map(uid=>[uid,targets.has(uid)?blue:green]));
 const palette=[green,'#8a2ba2','#b14500','#8d3d42','#00748f','#8a5a16','#bc2063','#756800','#5946ad','#356785','#6a4b79','#52692d'];
 let paletteIndex=0;
 const known=new Set(ids),ordered=[],seen=new Set(),colors=new Map(),used=new Set([blue]),space=92**3;
 for(const uid of [...priority.map(exact),...ids])if(known.has(uid)&&!seen.has(uid)){seen.add(uid);ordered.push(uid);}
 for(const uid of ordered){
  if(targets.size===1&&targets.has(uid)){colors.set(uid,blue);continue;}
  let color=palette[paletteIndex++]||'';
  if(!color){
   let hash=2166136261;for(const digit of uid)hash=Math.imul(hash^digit.charCodeAt(0),16777619)>>>0;
   let code=hash%space;
   do{color='#'+[24+code%92,24+Math.floor(code/92)%92,24+Math.floor(code/(92**2))%92].map(value=>value.toString(16).padStart(2,'0')).join('');code=(code+104729)%space;}while(used.has(color));
  }
  used.add(color);colors.set(uid,color);
 }
 return colors;
}
function colorModel(o,rows,context=[],priority=[]){
 const exact=value=>typeof value==='string'&&/^[0-9]{1,20}$/.test(value)&&BigInt(value)>0n?value:'';
 const all=[...(rows||[]),...(context||[])],ids=new Set(),targets=new Set();
 function visit(row,depth=0){if(!row||depth>4)return;for(const key of ['authorUid','postAuthorUid','replyAuthorUid','displayReplyAuthorUid','peerUid']){const uid=exact(row[key]);if(uid)ids.add(uid);}if(row.group!=='post-comments'){const uid=exact(row.targetUid);if(uid&&o.mode!=='post-comments')targets.add(uid);}visit(row.repost,depth+1);visit(row.replyRecord,depth+1);}
 all.forEach(row=>visit(row));
 let postAuthor;
 if(o.mode==='post-comments'){postAuthor={postId:o.postId,...require('./post-links').savedPostAuthor([...all,...(o.postAuthors||[])],o.postId)};if(postAuthor.uid)targets.add(postAuthor.uid);}
 else {const uid=exact(o.uid);if(uid)targets.add(uid);}
 for(const uid of targets)ids.add(uid);
 return {version:VERSION,mode:o.mode==='post-comments'?'post-comments':'users',targets:[...targets],ids:[...ids],priority:priority.filter(uid=>exact(uid)),...(postAuthor?{postAuthor}:{})};
}
const ACCOUNT_COLOR_STYLE='a.user-link[data-user-id]{color:var(--account-color,#64748b)}.bubble-row[data-author-uid],.entry[data-author-uid],.repost[data-author-uid]{border-left-color:var(--account-color,#9aa6b5)}.post-card[data-author-uid],.post-heading[data-author-uid]{border-left:3px solid var(--account-color,#9aa6b5)}.context-text[data-author-uid]{border-left:3px dashed var(--account-color,#9aa6b5);padding-left:10px}.message-author{color:#64748b}.bubble-context[data-author-uid] .context-badge{color:var(--account-color,#64748b);border-color:currentColor;background:#fff}.rank-user .rank-bar{background:var(--account-color,#8798b0)}';
// Verified historical color blocks include this rule in exactly this position.
const legacyTableStyle='.records-table tr[data-author-uid]>.author-cell{border-left:3px solid var(--account-color,#9aa6b5)}';
const legacyStyle=ACCOUNT_COLOR_STYLE.replace('.context-text[data-author-uid]',legacyTableStyle+'.context-text[data-author-uid]');
function installAccountColors(accountColors,version,legacyRow=''){
 let model;try{model=JSON.parse(document.getElementById('weibo-report-colors')?.textContent||'null');}catch{}if(model?.version!==version)return;
 const exact=value=>typeof value==='string'&&/^[0-9]{1,20}$/.test(value)&&BigInt(value)>0n?value:'';
 function accountUid(link){return exact(link?.dataset.userId||link?.getAttribute('href')?.match(/^https?:\/\/(?:www\.)?weibo\.(?:cn|com)\/u\/(\d+)$/)?.[1]||'');}
 const links=[...document.querySelectorAll('a.user-link')],priority=model.priority?.length?model.priority:[...document.querySelectorAll('.rank-user > a.user-link,#conversation .message-author a.user-link')].map(accountUid);
 const colors=accountColors([...(model.ids||[]),...links.map(accountUid)],model.mode,model.targets||[],priority);
 const color=uid=>colors.get(exact(uid))||'#64748b';
 function apply(root=document){
  const select=selector=>[...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)];
  if(model.postAuthor)for(const heading of select('.post-heading')){
   const {postId,uid,nickname}=model.postAuthor;
   if(!exact(postId)||heading.closest('[data-post-group]')?.dataset.postId!==postId)continue;
   const current=heading.querySelector('.post-origin-line>.source-label')?.nextElementSibling;
   if(!current?.matches('span,a.user-link')||current.matches('.post-link-pair'))continue;
   const user=exact(uid),label=nickname||user||'未返回';
   if(accountUid(current)!==user||current.textContent!==label){
    const author=document.createElement(user?'a':'span');author.textContent=label;
    if(user){author.className='user-link';author.href='https://weibo.cn/u/'+user;author.dataset.userId=user;author.title='微博主页 · UID '+user;author.target='_blank';author.rel='noopener noreferrer';}
    else if(!nickname)author.className='muted';
    current.replaceWith(author);
   }
   heading.dataset.authorUid=user;
  }
  for(const link of select('a.user-link')){const uid=accountUid(link);link.dataset.userId=uid;link.style.setProperty('--account-color',color(uid));}
  for(const message of select('.bubble-row,.entry,.post-card,.repost,.post-heading,.context-text'+(legacyRow?','+legacyRow:''))){
   const author=message.querySelector('.message-author .user-link,.entry-top > strong .user-link,:scope > header > strong .user-link,:scope > .source > .user-link,:scope > .post-summary-main > .post-origin-line > .user-link,:scope > strong > .user-link');
   const uid=exact(message.dataset.authorUid)||accountUid(author);if(!uid&&!message.hasAttribute('data-author-uid'))continue;
   message.dataset.authorUid=uid;message.style.setProperty('--account-color',colors.get(uid)||'#9aa6b5');
  }
  for(const cell of select('.rank-user'))cell.style.setProperty('--account-color',color(accountUid(cell.querySelector('.user-link'))));
 }
 window.ReaderAccountColors={version,color,apply};apply();
 document.addEventListener('reader-view-ready',event=>apply(event.detail?.pane||document));
 // Older managed reports rebuild ranking rows outside the main lazy reader.
 const ranking=document.querySelector('.ranking');if(ranking){let queued=false;new MutationObserver(changes=>{if(queued||!changes.some(c=>[...c.addedNodes].some(n=>n.nodeType===1)))return;queued=true;queueMicrotask(()=>{queued=false;apply(ranking);});}).observe(ranking,{childList:true,subtree:true});}
}
const ACCOUNT_COLOR_SCRIPT=';('+installAccountColors.toString()+')('+accountColors.toString()+','+JSON.stringify(VERSION)+');';
const colorRuntime=(style,script)=>'<style data-account-color-style="'+VERSION+'">'+style+'</style><script data-account-colors="'+VERSION+'">'+script+'</script>';
const ACCOUNT_COLOR_RUNTIME=colorRuntime(ACCOUNT_COLOR_STYLE,ACCOUNT_COLOR_SCRIPT);
const TABLE_COLOR_RUNTIME=colorRuntime(legacyStyle,';('+installAccountColors.toString()+')('+accountColors.toString()+','+JSON.stringify(VERSION)+',".records-table tr[data-author-uid]");');
function markup(model,runtime=ACCOUNT_COLOR_RUNTIME){return '<script type="application/json" id="weibo-report-colors">'+require('./report-records').jsonPayload(model)+'</script>'+runtime;}
function repairedMarkup(model,legacyTable){
 return markup(model,legacyTable ? TABLE_COLOR_RUNTIME : ACCOUNT_COLOR_RUNTIME);
}
function repair(html,entry={}){
 if(html.includes(ACCOUNT_COLOR_RUNTIME)||!/<\/body>/i.test(html))return null;
 // Older table reports without a palette receive this exact block at the end
 // of the body. Reopening a repaired report need not parse its full DOM.
 if(html.endsWith(TABLE_COLOR_RUNTIME,html.lastIndexOf('</body>')))return null;
 const tree=require('parse5').parse(html,{sourceCodeLocationInfo:true});
 const body=tree.childNodes.find(node=>node.tagName==='html')?.childNodes.find(node=>node.tagName==='body');
 const bodyEnd=body?.sourceCodeLocation?.endTag?.startOffset;
 if(bodyEnd===undefined)return null;
 const attr=(node,name)=>node?.attrs?.find(a=>a.name===name)?.value;
 const models=[],runtimes=[];let legacyTable=false;
 function collect(node){
  const id=attr(node,'id');
  if(id==='weibo-report-colors')models.push(node);
  if(id==='table'&&attr(node,'data-view')==='table')legacyTable=true;
  if(attr(node,'data-account-colors')!==undefined)runtimes.push(node);
  for(const child of node.childNodes||[])collect(child);
 }
 collect(tree);
 if(models.length>1||runtimes.length>1)return null;
 const readJson=node=>{
  const loc=node?.sourceCodeLocation;
  if(node?.parentNode!==body||node.tagName!=='script'||attr(node,'type')!=='application/json'||!loc?.endTag)return null;
  return JSON.parse(html.slice(loc.startTag.endOffset,loc.endTag.startOffset));
 };
 const formal=require('./report-records').locateReportPayload(html,tree);
 if(formal?.invalid)return null;
 let payload;try{payload=formal&&JSON.parse(formal.text);}catch{return null;}
 if(formal&&!Array.isArray(payload?.rows))return null;
 const postMode=entry.mode==='post-comments'||attr(body,'data-color-mode')==='posts',rows=payload?.rows||[];
 if(!rows.length&&entry.mode!=='user-posts')return null;
 const postIds=[...new Set(rows.filter(r=>r&&!r.isContext&&r.group==='post-comments').map(r=>r.postId).filter(id=>typeof id==='string'))];
 const o={mode:postMode?'post-comments':entry.mode||'both',uid:entry.uid||payload?.uid||'',postId:entry.postId||(postIds.length===1?postIds[0]:''),postAuthors:entry.postAuthors};
 const context=Array.isArray(payload?.context)?payload.context:[];
 if(models.length||runtimes.length){
  // Replace a known generated block before its observers can run.
  const [runtime]=runtimes,[modelNode]=models,version=attr(runtime,'data-account-colors'),loc=runtime?.sourceCodeLocation;
  if(runtime?.parentNode!==body||runtime.tagName!=='script'||!loc?.endTag||!Object.hasOwn(LEGACY_SCRIPT_HASHES,version))return null;
  let model;try{model=readJson(modelNode);}catch{return null;}
  if(model?.version!==version)return null;
  const modelLoc=modelNode.sourceCodeLocation,data=html.slice(modelLoc.startTag.endOffset,modelLoc.endTag.startOffset);
  const script=html.slice(loc.startTag.endOffset,loc.endTag.startOffset);
  if(require('node:crypto').createHash('sha256').update(script).digest('hex')!==LEGACY_SCRIPT_HASHES[version])return null;
  const expected='<script type="application/json" id="weibo-report-colors">'+data+'</script><style data-account-color-style="'+version+'">'+legacyStyle+'</style><script data-account-colors="'+version+'">'+script+'</script>';
  const start=modelLoc.startOffset,end=loc.endOffset;
  if(end>bodyEnd||html.slice(start,end)!==expected)return null;
  const updated=repairedMarkup(colorModel(o,rows,context,Array.isArray(model.priority)?model.priority:[]),legacyTable);
  return html.slice(0,start)+updated+html.slice(end);
 }
 if(/<script\b[^>]*\bdata-account-colors\s*=/i.test(html))return null;
 return html.slice(0,bodyEnd)+repairedMarkup(colorModel(o,rows,context),legacyTable)+html.slice(bodyEnd);
}
module.exports={VERSION,accountColors,colorModel,ACCOUNT_COLOR_STYLE,ACCOUNT_COLOR_SCRIPT,installAccountColors,markup,repair};
