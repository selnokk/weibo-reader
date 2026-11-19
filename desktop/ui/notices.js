"use strict";
// Gap choices and subscription counter acknowledgments await their offline
// save before hiding. Other generic notices remain presentation only.
(()=>{
 const dismissed=new Set(),durable=new Set(),active=new WeakMap();let context=()=>'';
 const storageKey='weibo-reader-notices-v1',persistedKey=/^list-v1:[a-f0-9]{64}$/,limit=10000,sessionLimit=512;
 try{const raw=localStorage.getItem(storageKey);if(raw&&raw.length<=1048576){const saved=JSON.parse(raw);if(saved?.schema===1&&Array.isArray(saved.keys)&&saved.keys.length<=limit&&saved.keys.every(key=>typeof key==='string'&&persistedKey.test(key)))for(const key of saved.keys)if(typeof key==='string'&&persistedKey.test(key)){dismissed.add(key);durable.add(key);}}}catch{}
 function persist(values){const keys=new Set([...durable,...values]);if(keys.size>limit)throw Error('Notice preference capacity reached');localStorage.setItem(storageKey,JSON.stringify({schema:1,keys:[...keys]}));for(const key of values)durable.add(key);}
 async function fingerprint(key){if(key.length>131072||!globalThis.crypto?.subtle)throw Error('Notice preference unavailable');const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));return 'list-v1:'+Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');}

 const bounded=value=>String(value??'').slice(0,16000);
 const sharedKey=(scope,key)=>JSON.stringify([bounded(scope),bounded(key)]);
 const durableKey=(scope,key)=>JSON.stringify(['list-v1',String(scope),String(key)]);
 async function keysFor(options){const key=durableKey(options.scope,options.sharedKey);try{return {key:await fingerprint(key),persistent:true};}catch{return {key,persistent:false};}}
 function remember(keys){for(const key of keys)dismissed.add(key);while(dismissed.size>sessionLimit+durable.size){const oldest=[...dismissed].find(value=>!durable.has(value));if(!oldest)break;dismissed.delete(oldest);}}
 function syncDismissed(){for(const el of document.querySelectorAll('[data-notice-key]')){const value=active.get(el);if(value&&dismissed.has(value.key)&&!el.hidden){el.hidden=true;value.onVisibilityChange?.();}}}
 async function isAcknowledged(options){
  const keys=await Promise.all([options,...(options.aliases||[]).map(sharedKey=>({...options,sharedKey}))].map(keysFor));
  return keys.some(({key})=>dismissed.has(key));
 }
 async function acknowledge(options,owns){
  const candidates=await Promise.all(options.map(keysFor));if(!owns())return;
  const changed=candidates.filter(({key})=>!dismissed.has(key));if(!changed.length)return 0;
  for(let i=0;i<candidates.length;i++)if(!dismissed.has(candidates[i].key)){if(!owns())return;await options[i].beforeDismiss?.();}
  if(!owns())return;
  const keys=[...new Set(changed.filter(value=>value.persistent).map(value=>value.key))];
  let saved=changed.every(value=>value.persistent);
  try{if(keys.length)persist(keys);}catch{saved=false;}
  remember(changed.map(value=>value.key));syncDismissed();
  if(!saved)window.toast?.('通知已在本次会话隐藏，关闭记录暂未能保存。',true);
  return saved?changed.length:-1;
 }
 function reset(el){if(!el)return;const old=active.get(el);if(old?.copy?.parentNode===el)el.replaceChildren(...old.copy.childNodes);old?.close.remove();active.delete(el);el.classList.remove('dismissible-notice');delete el.dataset.noticeKey;}
 function decorate(el,options={}){
  if(!el)return;reset(el);if(!el.textContent.trim())return;const scope=bounded(options.scope??context()),key=options.persistent===true?durableKey(options.scope??context(),options.sharedKey??options.key??''):options.sharedKey!=null?sharedKey(scope,options.sharedKey):JSON.stringify([scope,bounded(options.key??el.id),bounded(el.textContent)]);
  const isDetails=el.tagName==='DETAILS',copy=isDetails?null:document.createElement('span'),close=document.createElement('button');if(copy){copy.className='notice-copy';copy.append(...el.childNodes);}close.type='button';close.className='notice-dismiss';close.textContent='×';close.setAttribute('aria-label',options.label||'关闭此提示');close.title=options.title||'仅隐藏提示，不修改已保存数据、费用或续读状态';
  const current={key,scope,copy,close,onVisibilityChange:options.onVisibilityChange,ready:Promise.resolve(),persistent:options.persistent===true,unavailable:false};active.set(el,current);el.dataset.noticeKey=key;el.classList.add('dismissible-notice');if(isDetails){if(!options.externalDismiss)el.append(close);}else el.replaceChildren(copy,...(options.externalDismiss?[]:[close]));el.hidden=dismissed.has(key);options.onVisibilityChange?.();
  if(current.persistent){el.hidden=true;options.onVisibilityChange?.();current.ready=Promise.all([fingerprint(key),...(options.aliases||[]).map(alias=>fingerprint(JSON.stringify(['list-v1',String(options.scope??context()),String(alias)])))]).then(values=>{if(active.get(el)!==current)return;current.key=values[0];el.dataset.noticeKey=current.key;if(values.some(value=>dismissed.has(value)))dismissed.add(current.key);el.hidden=dismissed.has(current.key);options.onVisibilityChange?.();}).catch(()=>{current.unavailable=true;if(active.get(el)===current){el.hidden=dismissed.has(key);options.onVisibilityChange?.();}});}
  current.dismiss=async()=>{if(active.get(el)!==current||close.disabled)return;close.disabled=true;try{await current.ready;if(active.get(el)!==current)return;if(options.beforeDismiss)await options.beforeDismiss();if(active.get(el)!==current)return;if(current.persistent&&!current.unavailable){try{persist([current.key]);}catch{current.unavailable=true;}}remember([current.key]);el.hidden=true;options.onVisibilityChange?.();syncDismissed();options.onDismiss?.();if(current.unavailable)window.toast?.('提示已在本次会话隐藏；关闭记录暂未能保存，重开后可能再次显示。',true);}catch(error){close.disabled=false;options.onError?.(error);}};
  close.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();current.dismiss();});
 }
 function setText(el,text){const value=active.get(el),target=value?.copy||el;if(target.textContent!==text)target.textContent=text;el.title=text;}
 function syncContext(el){const value=active.get(el);if(value&&value.scope!==bounded(context()))el.hidden=true;}
 window.ReaderNotices={configure:provider=>{context=provider;},decorate,reset,setText,syncContext,acknowledge,isAcknowledged,dismiss:el=>active.get(el)?.dismiss(),isDismissed:(scope,key)=>dismissed.has(sharedKey(scope,key))};
})();
