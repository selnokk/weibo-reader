"use strict";
// Prevent a replaced FIFO/device/symlink from blocking the single-threaded engine.
// A descriptor is checked again after open; O_NONBLOCK also closes the stat/open race.
const fs=require('node:fs');
function list(folder,pattern){
 if(!fs.existsSync(folder))return [];
 const stat=fs.lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw Object.assign(Error('本地来源目录不是可核实的普通目录'),{code:'LOCAL_SOURCE_INVALID'});
 return fs.readdirSync(folder,{withFileTypes:true}).filter(e=>pattern.test(e.name)).map(e=>{if(!e.isFile()||e.isSymbolicLink())throw Object.assign(Error('本地来源不是可读取的普通文件：'+e.name),{code:'LOCAL_SOURCE_INVALID'});return require('node:path').join(folder,e.name);});
}
function openRegular(file, maxBytes){
 const fail=()=>Object.assign(Error('本地来源不是可读取的普通文件'),{code:'LOCAL_SOURCE_INVALID'});
 const before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||Number(before.size)>maxBytes)throw fail();
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const opened=fs.fstatSync(fd,{bigint:true});
  if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||Number(opened.size)>maxBytes)throw fail();
  return { fd, size: Number(opened.size) };
 }catch(error){if(fd!=null)fs.closeSync(fd);if(error.code==='ELOOP')throw fail();throw error;}
}
function open(file, { maxBytes = Infinity } = {}) {
 return openRegular(file, maxBytes).fd;
}
function read(file, { maxBytes = Infinity, verifyParent } = {}) {
 const { fd, size } = openRegular(file, maxBytes);
 try {
  verifyParent?.();
  if (!Number.isFinite(maxBytes)) return fs.readFileSync(fd);
  // Most sources are small. One spare byte checks EOF (or growth) without
  // allocating another 64 KiB buffer for each short file.
  const chunks = [];
  let total = 0;
  let buffer = Buffer.allocUnsafe(Math.min(size + 1, 65536));
  let offset = 0;
  for (;;) {
   const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
   if (!count) {
    if (!chunks.length) return buffer.subarray(0, offset);
    if (offset) chunks.push(buffer.subarray(0, offset));
    return Buffer.concat(chunks, total);
   }
   total += count;
   if (total > maxBytes) throw Object.assign(Error('本地来源超过读取上限'), { code: 'LOCAL_SOURCE_INVALID' });
   offset += count;
   if (offset === buffer.length) {
    chunks.push(buffer);
    buffer = Buffer.allocUnsafe(Math.min(65536, maxBytes - total + 1));
    offset = 0;
   }
  }
 } finally {
  fs.closeSync(fd);
 }
}
module.exports={read,list,open};
