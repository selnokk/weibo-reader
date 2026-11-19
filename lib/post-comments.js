'use strict';
const fs=require('node:fs'),path=require('node:path');
const {text,positiveId,reliableId,userId,userName,cleanText,postPictures,mergePostPictures,rawArray,apiError,runCli,ts,normalize,replyPrefixParts,sortRecords,terminalTarget}=require('./core');
const {storagePaths,postSourceFromFolder,findPostFolder,commitPostFolder,getOne}=require('./storage');
const {render}=require('./reader');
const {createCreditMeter}=require('./credits');
const {reportShortcut,createProgress,requestPolicy,conciseError}=require('./terminal-report');
function postPageRows(raw,postId){
 const parsed=rawArray(raw,'post-comments');if(!parsed)throw Error('评论响应缺少记录数组');
 const rows=[],expectedReplies=new Map(),postAuthors=[];let source={};
 const considerPost=value=>{
  if(value&&reliableId('原微博 ID',value.idstr,value.id,value.mid)===postId){
   const uid=reliableId('原微博作者 UID',value.user?.idstr,value.user?.id,value.user?.uid);
   if(uid)postAuthors.push({postId,postAuthorUid:uid,postAuthor:userName(value.user)});
   source={...value,...source,user:source.user||value.user};
  }
 };
 for(const box of [raw,raw?.data,parsed.container]){considerPost(box?.status);considerPost(box?.weibo);}
 const seen=new Set();
 function visit(c,parent=null,root=''){
  if(!c||typeof c!=='object')throw Error('评论记录格式无效');
  if(seen.has(c))return;seen.add(c);
  const id=reliableId('评论 ID',c.idstr,c.id,c.mid);
  const status=c.status??c.weibo,actualPost=reliableId('原微博 ID',status?.idstr,status?.id,status?.mid,c.status_idstr,c.status_id,c.statusid);
  if(actualPost&&actualPost!==postId)throw Error('接口返回其他微博的评论，已停止以免混入');
  reliableId('原微博作者 UID',status?.user?.idstr,status?.user?.id,status?.user?.uid);
  considerPost(status);
  const copy={...c,status:{...(status||source),idstr:postId}};
  const explicitReply=reliableId('回复评论 ID',c.reply_idstr,c.reply_id),quotedId=reliableId('引用评论 ID',c.reply_comment?.idstr,c.reply_comment?.id,c.reply_comment?.mid);reliableId('根评论 ID',c.rootidstr,c.rootid);
  if(parent&&!explicitReply&&!quotedId){
   copy.reply_idstr=positiveId(parent.idstr,parent.id,parent.mid);copy.reply_user=c.reply_user||parent.user;
  }
  if(!positiveId(copy.rootidstr,copy.rootid)){
   if(root)copy.rootidstr=root;
   else if(!positiveId(copy.reply_idstr,copy.reply_id)&&!quotedId&&!replyPrefixParts(cleanText(copy.text_raw??copy.text??'')))copy.rootidstr=id;
  }
  const row=normalize(copy,'post-comments','');if(!require('./record-body').completeBody(row,copy)){row.bodyMissing=true;for(const k of ['bodyMissing','contentMissing','truncated'])if(copy[k]===true)row[k]=true;}row.type=row.replyId||(row.rootId&&row.rootId!==row.recordId)?'回复':'评论';rows.push(row);
  const children=['comments','replies','children'].flatMap(key=>Array.isArray(c[key])?c[key]:(rawArray(c[key],'post-comments')?.items||[]));
  const count=Number(c.reply_count??c.comments?.total_number??c.replies?.total_number??(Object.hasOwn(c,'comments')||children.length?c.total_number:undefined));
  if(id&&Number.isSafeInteger(count)&&count>0)expectedReplies.set(id,count);
  for(const child of children)visit(child,c,root||positiveId(copy.rootidstr,copy.rootid)||id);
 }
 for(const c of parsed.items)visit(c);
 return {rows,source,postAuthors,expectedReplies,items:parsed.items,container:parsed.container};
}
function harvestPost(o,dir,fetchPage=getOne){
 o.dataTaskId??=process.env.WEIBO_DATA_SCOPE||require('node:crypto').randomUUID();
 o.knownRecordIds??=new Set(require('./local-database').localPostComments(o,dir).rows.map(r=>r.recordId));
 o.cacheSession??=require('./cache-session').createCacheSession({maxBytes:16*1024*1024});
 const out={kind:'post-comments',budget:o.count,rows:[],activityRows:[],fetched:0,newFetched:0,requests:0,cachedCalls:0,cacheTimes:[],reason:'',source:{},postPictures:postPictures(),reportedTotal:null,incompleteReplies:[],ended:false,failed:false};
 const progress=createProgress(o);
 const unique=new Map(),signatures=new Set(),expected=new Map();let cursor='',numbered=false,offset=0,firstPageWidth=0,pageProbe=false,probeEcho=false;const rootIds=new Set();
 const gcd=(a,b)=>b?gcd(b,a%b):a;
 for(let page=1;;page++){
  let wanted=Math.min(o.pageSize,o.count-out.fetched);
  if(numbered&&pageProbe)wanted=1;else if(numbered&&offset)wanted=gcd(offset,wanted);
  const postPage=numbered?offset/wanted+1:1;if(page===1)firstPageWidth=wanted;
  if(wanted<=0){out.reason='达到手动设置的请求条数上限，尚未确认分页结束';break;}
  const capped=out.requests-out.cachedCalls>=o.pages;let packet;
  try{packet=fetchPage({...o,postPage,offline:o.offline||capped},dir,'post-comments',wanted,cursor);}catch(error){out.failed=true;out.reason=`第 ${page} 页请求失败：${error.message}`;require('./collection-failure').accountFailure(out,error);break;}
  if(!packet){out.reason=capped?'达到 --pages 新增 API 请求上限，尚未确认分页结束；缓存仍保留':'离线缓存不足，尚未确认分页结束；可移除 --offline 后继续';break;}
  out.requests++;if(packet.cached)out.cachedCalls++;
  if(packet.cached&&Number.isFinite(packet.cacheTimeMs))out.cacheTimes.push(packet.cacheTimeMs);
  const returned=rawArray(packet.raw,'post-comments');
  if(!returned||apiError(packet.raw)){out.failed=true;out.reason=apiError(packet.raw)||'评论响应缺少记录数组';break;}
  if(!packet.cached)out.newFetched+=returned.items.length;
  const total=Number(returned.container.total_number??returned.container.total);
  if(Number.isSafeInteger(total)&&total>=0)out.reportedTotal=total;
  // A larger existing cache may satisfy a smaller requested export. Never discard an oversized new paid response.
  const previousSize=unique.size;
  const items=packet.cached?returned.items.slice(0,wanted):returned.items;
  if(page===1)firstPageWidth=items.length;
  let parsed;
  try{parsed=postPageRows({...packet.raw,comments:items},o.postId);}catch(error){out.failed=true;out.reason=error.message;break;}
  if(page===1&&!packet.cached)out.activityRows=parsed.rows;
  if(!userId(out.source.user)&&userId(parsed.source.user))out.source.user=parsed.source.user;
  for(const [key,value] of Object.entries(parsed.source))if(out.source[key]==null||out.source[key]==='')out.source[key]=value;
  out.postPictures=mergePostPictures(out.postPictures,postPictures(parsed.source));
  for(const [id,count] of parsed.expectedReplies)expected.set(id,Math.max(expected.get(id)||0,count));
  for(const item of items){const id=positiveId(item.idstr,item.id,item.mid);if(id)rootIds.add(id);}
  out.fetched=rootIds.size;
  const added=[];
  for(const row of parsed.rows){
   const key=row.recordId||`${row.authorUid}/${row.time}/${row.content}`;
   if(!unique.has(key)){
    unique.set(key,row);
    if(o.noteNewRecords&&require('./record-body').completeBody(row))added.push(row);
   }
  }
  o.noteNewRecords?.(added);
  require('./events').emit('collection',{kind:'post-comments',phase:'collect',fetched:unique.size,budget:Number.isFinite(o.count)?o.count:null});
  progress.update(`${o.creditMeter?o.creditMeter.progress()+' · ':''}微博评论 · ${unique.size} 条 · API ${out.requests-out.cachedCalls} 次`, `  #${page} comments show/all --id ${o.postId} --count ${wanted} --page ${postPage}${cursor?' --max_id '+cursor:''} | ${packet.cached?'缓存':'API'}返回 ${returned.items.length} 条，累计去重 ${unique.size} 条（含返回的楼中楼）`);
  if(!items.length){
   if(!numbered&&out.reportedTotal>unique.size){numbered=true;offset=firstPageWidth;cursor='';out.pageFallback=true;pageProbe=true;continue;}
   out.ended=true;out.reason='接口返回空页，分页结束（仅限接口当前可见范围）';break;
  }
  if(!packet.cached&&returned.items.length>wanted){out.reason='接口超出请求条数，已完整保留本页并停止后续请求';break;}
  if(out.fetched>=o.count){out.reason='达到手动设置的请求条数上限，尚未确认分页结束';break;}
  const ids=items.map(c=>positiveId(c.idstr,c.id,c.mid));
  if(ids.some(id=>!id)){out.reason='本页评论缺少 ID，无法安全继续分页';break;}
  const signature=ids.slice().sort().join(',');
  if(signatures.has((numbered?'page:':'cursor:')+signature)){if(!numbered&&out.reportedTotal>unique.size){numbered=true;offset=firstPageWidth;cursor='';out.pageFallback=true;pageProbe=true;continue;}out.reason='接口重复返回同一页，已停止；尚未确认完整';break;}signatures.add((numbered?'page:':'cursor:')+signature);
  if(numbered){
   if(pageProbe){
    if(unique.size===previousSize){if(!probeEcho){probeEcho=true;offset++;continue;}out.reason='页码探测重复返回已保存评论，无法确认后续可见记录；已停止以避免重复计费';break;}
    pageProbe=false;offset=firstPageWidth;continue;
   }
   if(unique.size===previousSize){out.reason='页码未带来新评论，已停止以避免重复计费，完整性未核实';break;}
   offset+=wanted;continue;
  }
  const serverNext=returned.container.next_cursor_str??returned.container.next_cursor;
  if(serverNext!=null&&/^\d+$/.test(String(serverNext))&&BigInt(serverNext)>0n){const next=String(serverNext);if(cursor&&BigInt(next)>=BigInt(cursor)){out.reason='服务器续取游标未推进，尚未确认完整';break;}cursor=next;continue;}
  const lowest=ids.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);
  if(BigInt(lowest)<=1n){out.reason='评论 ID 无法继续向前分页，尚未核实末页';break;}
  const next=(BigInt(lowest)-1n).toString();
  if(cursor&&BigInt(next)>=BigInt(cursor)){out.reason='分页游标未向前推进，已停止；尚未确认完整';break;}
  cursor=next;
 }
 progress.end();out.rows=[...unique.values()];
 for(const [root,count] of expected){
  const actual=out.rows.filter(row=>row.recordId!==root&&row.rootId===root).length;
  if(actual<count)out.incompleteReplies.push({rootId:root,expected:count,actual});
 }
 out.totalGap=out.reportedTotal!=null&&out.rows.length<out.reportedTotal;
 out.complete=out.ended&&!out.failed&&!out.totalGap&&!out.incompleteReplies.length;
 if(out.totalGap)out.reason+=`；接口报告 ${out.reportedTotal} 条，已取得 ${out.rows.length} 条，数量不一致，完整性未核实（不能据此认定删除）`;
 if(out.incompleteReplies.length)out.reason+='；部分楼中楼回复尚未返回';
 if(!out.reason)out.reason='已停止，尚未确认分页结束';
 for(const row of out.rows){
  if(!row.postAuthor)row.postAuthor=userName(out.source.user);
  if(!row.postAuthorUid)row.postAuthorUid=userId(out.source.user);
  if(!row.postText)row.postText=cleanText(out.source.longText?.longTextContent??out.source.text_raw??out.source.text??'');
  if(!row.postTime&&out.source.created_at)row.postTime=ts(out.source.created_at).display;
  row.postPictures=mergePostPictures(row.postPictures,out.postPictures);
 }
 return out;
}
function runPostComments(o){
 o.syncStartedAt=new Date().toISOString();
 const posts=storagePaths().postComments;let dir=findPostFolder(posts,o.postId);
 const identify=source=>`微博 ${o.postId}${userName(source?.user)?` · 原作者：${terminalTarget(userId(source.user),userName(source.user))}`:''}`;
 console.log(`目标：${identify()} | post-comments | ${Number.isFinite(o.count)?`最多请求 ${o.count} 条`:'自动分页读取'}${Number.isFinite(o.pages)?` | 每接口最多新增 API ${o.pages} 次`:''}`);
 if(o.dryRun){
  console.log(`  comments show/all --id ${o.postId} --count ${Math.min(o.pageSize,o.count)} --page 1 --filter_by_author 0`);
  console.log('  优先使用续取游标；空页与总数矛盾时尝试页码分页，直到可见末尾或手动上限；保留接口返回的楼中楼。');return;
 }
 console.log(requestPolicy(o));
 if(!o.offline){
  const details=JSON.parse(runCli(['commands','show','comments','show/all','--output','json']));
  const command=details.command||details,flags=new Set((command.flags||[]).map(flag=>flag.name));
  if(command.action!=='show/all'||command.group!=='comments'||command.method!=='GET'||!['id','count','max_id','page','filter_by_author'].every(flag=>flags.has(flag)))throw Error('当前 CLI 未确认支持微博全部评论接口及分页参数；已在读取前停止');
 }
 o.creditMeter=createCreditMeter(o);o.creditMeter.start();
 const initial=o.syncOnly?require('./local-database').localPostComments(o,dir).rows:null;
 if(initial)o.knownRecordIds??=new Set(initial.map(row=>row.recordId));
 const beforeKeys=initial?new Set(initial.map(require('./database-sync').key)):null;
 require('./database-sync').trackNewRecords(o,beforeKeys);
 const result=harvestPost(o,dir);
 const ownerUid=userId(result.source.user),owner=userName(result.source.user);
 console.log(`[结果] ${identify(result.source)}`);
 console.log(`  ${result.rows.length} 条去重评论（含返回的楼中楼；引用补充另计）`);
 console.log('  '+conciseError(result.reason,o));
 if(result.reportedTotal!=null)console.log(`  接口报告总数：${result.reportedTotal}；实际独立记录：${result.rows.length}（统计口径可能不同）`);
 if(result.incompleteReplies.length)console.log(`  注意：${result.incompleteReplies.length} 个分组报告的回复数多于实际返回数；当前接口未提供独立楼中楼续取参数，仍可能缺少回复。`);
 if(o.verbose)console.log('  接口不可见、已删除或未返回的内容无法据此补齐，不保证与网页全部历史一致。');
 if(result.failed&&!result.requests){o.creditMeter.finish();process.exitCode=1;return;}
 dir=commitPostFolder(posts,o.postId,dir,userName(result.source.user)?result.source:postSourceFromFolder(dir,o.postId));
 if(o.syncOnly){o.creditMeter.finish({skipFinalBalanceIfKnown:!!o.autoGuard});const sync=require('./database-sync');result.newRows=result.rows.filter(row=>require('./record-body').completeBody(row)&&!beforeKeys.has(sync.key(row)));sync.finishSync(o,dir,[{kind:'post-comments',...result}],owner||'微博 '+o.postId,beforeKeys);if(result.failed)process.exitCode=1;return;}
 let filename=path.join(require('./data-layout').reportDir(dir),require('./report-name').fileName(owner||o.postId,o,result.rows.length));
 const catalog=require('./report-catalog'),opts={...o,uid:ownerUid,reportPartial:!result.complete},rows=sortRecords(result.rows),label=owner||`微博 ${o.postId}`;filename=catalog.write(filename,opts,rows,label,()=>render(opts,rows,[result],label),catalog.contentKey(opts,rows,[result],label)).file;
 if(result.billingUnknown)console.log('注意：失败请求计费未知，请核对服务端账单。');
 console.log(`${result.complete?'完成':'未完成'}：1 个 HTML | API ${result.requests-result.cachedCalls} 次，返回 ${result.newFetched} 条 | 缓存 ${result.cachedCalls} 次`);
 require('./events').emit('summary',{written:1,apiCalls:result.requests-result.cachedCalls,newRecords:result.newFetched,cachedCalls:result.cachedCalls,incomplete:!result.complete,records:result.rows.length,reason:result.reason,reportedTotal:result.reportedTotal});
 o.creditMeter.finish();
 reportShortcut(filename,o);
 if(result.failed)process.exitCode=1;
}

module.exports={postPageRows,harvestPost,runPostComments};
