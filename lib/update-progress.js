'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function token(file){
 if(!fs.existsSync(file))return 'absent';const fd=require('./regular-file').open(file),hash=crypto.createHash('sha256');
 try{const before=fs.fstatSync(fd,{bigint:true}),buffer=Buffer.allocUnsafe(65536);for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;hash.update(buffer.subarray(0,n));}const after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});if(!current.isFile()||current.isSymbolicLink()||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]||after[key]!==current[key]))throw Object.assign(Error('本地进度来源在读取期间变化'),{code:'LOCAL_SOURCE_INVALID'});return hash.digest('hex');}finally{fs.closeSync(fd);}
}
function atomicBytes(file, bytes) {
 fs.mkdirSync(path.dirname(file), { recursive: true });
 const temp = file + '.' + crypto.randomUUID() + '.tmp';
 try {
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
 } catch (error) {
  fs.rmSync(temp, { force: true });
  throw error;
 }
}
function atomic(file, value) {
 atomicBytes(file, JSON.stringify(value));
}
function commit(file,expected,value){
 const currentToken=token(file),current=fs.existsSync(file)?JSON.parse(require('./regular-file').read(file,{maxBytes:16*1024*1024})):null;
 if(currentToken!==expected||current?.anchor&&value.anchor&&BigInt(value.anchor)<BigInt(current.anchor))return {ok:false,token:currentToken,state:current,reason:'成功进度或待完成区间已被另一轮更新；旧任务只保存数据，不覆盖较新的进度'};
 let connection=current?.connection||null;if(value.connectedProof){const root=path.dirname(path.dirname(file)),proof={schema:1,uid:value.uid,kind:value.kind,...value.connectedProof,previous:connection},name=crypto.randomUUID()+'.json',target=path.join(root,'update-connections',name);atomic(target,proof);connection={file:'update-connections/'+name,hash:token(target)};}
 const state={...value,...(connection?{connection}:{}),revision:(current?.revision||0)+1};delete state.connectedProof;atomic(file,state);return {ok:true,token:token(file),state};
}
function connectedScope(file,scope){let state;try{state=JSON.parse(require('./regular-file').read(file,{maxBytes:16*1024*1024}));}catch(error){if(error.code==='LOCAL_SOURCE_INVALID')throw error;return false;}let ref=state.connection;const root=path.dirname(path.dirname(file)),seen=new Set();while(ref){if(!/^update-connections\/[a-f0-9-]+\.json$/.test(ref.file||'')||seen.has(ref.hash))return false;seen.add(ref.hash);const target=path.join(root,ref.file);if(token(target)!==ref.hash)return false;const proof=JSON.parse(require('./regular-file').read(target,{maxBytes:16*1024*1024}));if(proof.uid!==state.uid||proof.kind!==state.kind)return false;if((proof.scopes||[]).includes(scope)){try{if(!Array.isArray(proof.packets)||!proof.packets.length)return false;for(const packet of proof.packets)require('./incremental').restorePacket(packet,path.dirname(root));return true;}catch(error){if(error.code==='LOCAL_SOURCE_INVALID')throw error;return false;}}ref=proof.previous;}return false;}
module.exports={connectedScope,token,commit,atomic,atomicBytes};
