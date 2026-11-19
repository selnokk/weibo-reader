'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'),uid='1234567890';
// Execute the real UI scripts with a small in-memory DOM. No bridge/API process is created.
function ui({smoke=true,acceptLibrary=true}={}){
 const fields=new Map(),sent=[],timers=[];
 function element(tag='div'){
  const attrs=new Map(),tokens=new Set(),e={tagName:tag.toUpperCase(),value:'',checked:false,disabled:false,hidden:false,textContent:'',children:[],dataset:{},style:{},open:false};
  e.classList={add:(...xs)=>xs.forEach(x=>tokens.add(x)),remove:(...xs)=>xs.forEach(x=>tokens.delete(x)),contains:x=>tokens.has(x),toggle:(x,on)=>{on=on===undefined?!tokens.has(x):!!on;on?tokens.add(x):tokens.delete(x);return on;}};
  Object.defineProperty(e,'className',{get:()=>[...tokens].join(' '),set:v=>{tokens.clear();String(v).split(/\s+/).filter(Boolean).forEach(x=>tokens.add(x));}});
  Object.defineProperty(e,'firstElementChild',{get:()=>e.children[0]||(e.children[0]=element())});
  Object.defineProperty(e,'parentElement',{get:()=>e.parent||(e.parent=element())});
  e.append=(...xs)=>e.children.push(...xs);e.prepend=(...xs)=>e.children.unshift(...xs);e.replaceChildren=(...xs)=>{e.children=[...xs];};
  e.setAttribute=(k,v)=>attrs.set(k,String(v));e.getAttribute=k=>attrs.get(k)??null;e.removeAttribute=k=>attrs.delete(k);
  const clickListeners=[];
  e.addEventListener=(name, handler)=>{if(name==='click')clickListeners.push(handler);};
  e.click=()=>{if(!e.disabled)for(const listener of clickListeners)listener({target:e,currentTarget:e,preventDefault(){},stopPropagation(){}});};
  e.focus=()=>{};e.scrollIntoView=()=>{};e.closest=()=>null;e.querySelector=()=>element();e.querySelectorAll=()=>[];e.remove=()=>{};
  e.getBoundingClientRect=()=>({x:0,y:80,width:800,height:500,bottom:580,top:80});return e;
 }
 const $=id=>{if(!fields.has(id))fields.set(id,element());return fields.get(id);};
 $('mode').value='comments-both';$('limit').value='50';$('seek-limit').value='80';$('empty-limit').value='20';$('progress-track').hidden=true;
 const ctx={console,Intl,Date,Set,Map,JSON,Number,String,Object,Math,ReaderHistoryCost:require('../desktop/ui/history-cost'),ReaderDates:require('../lib/date-range'),ReaderUX:require('../desktop/ui/form-utils'),ReaderIdentity:require('../desktop/ui/user-identity'),ReaderDataQuery:require('../desktop/ui/data-query'),weiboSmoke:smoke,innerWidth:1300,innerHeight:1000,crypto:{randomUUID:()=>String(sent.length+1)},localStorage:{getItem:()=>null,setItem:()=>{}},setTimeout:f=>{timers.push(f);return timers.length;},clearTimeout:()=>{},setInterval:()=>0,queueMicrotask:f=>timers.push(f),requestAnimationFrame:()=>{},addEventListener:()=>{},scrollTo:()=>{},ResizeObserver:class{observe(){}},document:{getElementById:$,querySelectorAll:()=>[],createElement:element,addEventListener:()=>{},documentElement:{scrollWidth:1300},body:element('body')},weiboBrowserHarness:v=>sent.push(JSON.parse(JSON.stringify(v)))};
 ctx.window=ctx;vm.createContext(ctx);
 for(const name of ['task-events.js','acquisition-feedback.js','task-activity.js','entity-status.js','report-actions.js','home-assets.js','workspace-channel.js','app.js'])vm.runInContext(fs.readFileSync(path.join(ROOT,'desktop/ui',name),'utf8'),ctx,{filename:name});
 const run=code=>vm.runInContext(code,ctx),event=e=>ctx.weiboReceive(e);
 if(acceptLibrary)event({type:'library',workspace:'/tmp/mock',accounts:[],reports:[],database:[],favorites:[],postFavorites:[]});
 run(`ReaderIdentity.selectUser(state,'${uid}');state.view='create';updateForm();renderTaskActivity()`);
 return {$,sent,timers,ctx,run,event,jobs:new Map(),state:run('state')};
}
module.exports={ui};
