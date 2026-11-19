'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const uid='1234567890',peer='9876543210',post='8888888888';
const save=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file;};
function fixture(){const base=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-insights-'));save(path.join(base,'data/.layout-v2'),'2');const dir=path.join(base,'data/user-comments',uid),other=path.join(base,'data/user-comments',peer),postDir=path.join(base,'data/post-comments','原作者_'+post),posts=path.join(base,'data/posts',uid);for(const d of [dir,other,postDir,posts])fs.mkdirSync(path.join(d,'cache'),{recursive:true});
 const row=(id,text='关键词 正文 '+id,author=uid,time='2026-10-29T12:00:00+08:00',parent=null)=>({idstr:String(id),text,created_at:time,user:{idstr:author,screen_name:author===uid?'甲':'乙'},status:{idstr:post,text:'原博文',user:{idstr:peer,screen_name:'原作者'}},...(parent?{reply_idstr:parent.idstr,reply_comment:parent}:{} )});
 const cache=(dir,kind,rows,suffix='c200_m0')=>save(path.join(dir,'cache',kind+'_'+suffix+'.json'),{comments:rows});const close=()=>fs.rmSync(base,{recursive:true,force:true});return {base,dir,other,postDir,posts,row,cache,close,save};}
module.exports={fixture,uid,peer,post,save};
