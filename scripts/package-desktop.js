#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),info=require('./app-version').appVersion(require('../package.json')),version=info.version,source=process.env.WEIBO_PACKAGE_APP||path.join(root,'dist/Weibo Reader.app');
function run(cmd,args,cwd){const p=spawnSync(cmd,args,{cwd,env:{...process.env,TZ:'UTC'},encoding:'utf8',maxBuffer:1024*1024});if(p.status!==0||p.error)throw Error(p.stderr||p.error?.message||'打包失败');return p.stdout;}
function normalizeTimes(file,stamp){
 const stat=fs.lstatSync(file);
 if(stat.isSymbolicLink()){fs.lutimesSync(file,stamp,stamp);return;}
 if(stat.isDirectory())for(const entry of fs.readdirSync(file))normalizeTimes(path.join(file,entry),stamp);
 fs.utimesSync(file,stamp,stamp);
}
// HFS+ also stores file creation dates. Apply them to the temporary mounted
// image only. SetFile -P updates a link itself, including the Applications link.
function normalizeImageBirthTimes(mount, stamp) {
 const iso = new Date(stamp * 1000).toISOString();
 const date = iso.slice(5, 7) + '/' + iso.slice(8, 10) + '/' + iso.slice(0, 4) + ' ' + iso.slice(11, 19);
 const paths = [];
 function visit(file) {
  if (fs.lstatSync(file).isDirectory()) {
   for (const entry of fs.readdirSync(file)) visit(path.join(file, entry));
  }
  paths.push(file);
 }
 visit(mount);
 for (let offset = 0; offset < paths.length; offset += 60) {
  run('/usr/bin/SetFile', ['-P', '-d', date, ...paths.slice(offset, offset + 60)]);
 }
}
// ZIP stores modification times to the nearest two seconds. Use the same UTC
// instant for the disk image contents, the source tree and all release files.
const inputEpoch = process.env.SOURCE_DATE_EPOCH ?? String(Math.floor(Date.now() / 1000));
if (!/^\d+$/.test(inputEpoch) || Number(inputEpoch) < 315532800 || Number(inputEpoch) > 4354819199) {
 throw Error('打包时间戳不在 ZIP 支持范围内');
}
const stamp = Math.floor(Number(inputEpoch) / 2) * 2;

function makeSourceArchive(temp, stem) {
 const sourceFolder = stem + '-source';
 const tree = path.join(temp, sourceFolder);
 const files = [];
 const entries = ['.gitignore', 'LICENSE', 'README.md', 'package.json', 'package-lock.json',
  'weibo_cli.js', 'weibo_reader_user_guide.md', 'lib', 'desktop', 'scripts', 'test'];
 fs.mkdirSync(tree);
 for (const name of entries) {
  fs.cpSync(path.join(root, name), path.join(tree, name), {recursive:true, filter(input) {
   const relative = path.relative(root, input);
   const parts = relative.split(path.sep);
   if (parts.some(part => part === '.DS_Store')) return false;
   if (parts.some(part => (part.startsWith('.') && part !== '.gitignore') ||
        require('./desktop-payload').privateName(part))) throw Error('源码包含意外的文件：' + relative);
   const st = fs.lstatSync(input);
   if (!st.isDirectory() && !st.isFile()) throw Error('源码归档只接受普通文件和目录：' + relative);
   if (st.isFile()) files.push(path.join(tree, relative));
   return true;
  }});
 }
 const findings = require('./privacy-audit').auditFiles(tree, files);
 if (findings.length) throw Error('源码隐私检查未通过：' + findings.map(item=>item.file).join(', '));
 normalizeTimes(tree, stamp);
 const zip = path.join(temp, sourceFolder + '.zip');
 run('/usr/bin/zip', ['-X', '-q', '-r', zip, sourceFolder], temp);
 return zip;
}

if(process.platform!=='darwin')throw Error('需要 macOS 打包');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-package-'));
const dist = path.join(root, 'dist'), stem = 'Weibo-Reader-' + version;
const appStem = stem + '-macos-arm64';
fs.mkdirSync(dist, {recursive:true});
try{
 const volume=path.join(temp,'volume');fs.mkdirSync(volume);
 const app=path.join(volume,'Weibo Reader.app');run('/usr/bin/ditto',['--norsrc','--noextattr','--noacl',source,app]);
 const plist=path.join(app,'Contents/Info.plist'),properties=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',plist]));if(Object.hasOwn(properties,'WeiboDefaultWorkspace'))run('/usr/libexec/PlistBuddy',['-c','Delete :WeiboDefaultWorkspace',plist]);
 for(const [key,wanted]of [['WeiboAppVersion',version],['CFBundleShortVersionString',info.release],['CFBundleVersion',info.build]]){const installed=run('/usr/libexec/PlistBuddy',['-c','Print :'+key,plist]).trim();if(installed!==wanted)throw Error('程序与包版本不一致，请重新构建');}
 for(const name of ['data','output','.reader','.env'])if(fs.existsSync(path.join(app,'Contents/Resources/engine',name)))throw Error('发现个人数据，停止打包');
 run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);run('/usr/bin/codesign',['--verify','--deep','--strict',app]);run(process.execPath,[path.join(__dirname,'audit-release.js'),app]);
 fs.symlinkSync('/Applications',path.join(volume,'Applications'));fs.writeFileSync(path.join(volume,'安装说明.txt'),'Weibo Reader\n\n将 Weibo Reader.app 拖入 Applications 后打开。\nApple Silicon Mac，macOS 13.5 或更新。\n首次运行使用个人资料目录并自行登录服务账户。替换应用不会删除资料库。\n安装包采用 ad hoc 签名，尚未经过 Apple 公证。\n若首次打开时提示无法验证开发者或无法检查 App，请确认来自本仓库并核对 SHA-256。尝试打开后，进入「系统设置 → 隐私与安全性」，在「安全性」下点「仍要打开」，然后确认「打开」。\n');
 normalizeTimes(volume, stamp);
 const dmg=path.join(temp,appStem+'.dmg'),zip=path.join(temp,appStem+'.zip');
 const image=path.join(temp,'volume.dmg'),writable=path.join(temp,'writable.dmg'),mount=path.join(temp,'mount');
 // HFS+ reconstruction drops host provenance but generates Finder attributes.
 // Clear those in the private image before compressing and verifying the signed bundle.
 run('/usr/bin/hdiutil',['makehybrid','-hfs','-hfs-volume-name','Weibo Reader','-o',image,volume]);
 run('/usr/bin/hdiutil',['convert',image,'-format','UDRW','-o',writable]);fs.mkdirSync(mount);
 run('/usr/bin/hdiutil',['attach','-quiet','-readwrite','-nobrowse','-noautoopen','-owners','on','-mountpoint',mount,writable]);
 try{
  run('/usr/bin/xattr',['-rcs',mount]);
  normalizeImageBirthTimes(mount, stamp);
  normalizeTimes(mount, stamp);
  run('/usr/bin/codesign',['--verify','--deep','--strict',path.join(mount,path.basename(app))]);
 }finally{run('/usr/bin/hdiutil',['detach','-quiet',mount]);}
 run('/usr/bin/hdiutil',['convert',writable,'-format','UDZO','-ov','-o',dmg]);
 // Retain executable modes and internal symlinks without AppleDouble or host-specific ZIP fields.
 run('/usr/bin/zip',['-X','-q','-r','-y',zip,path.basename(app)],volume);
 const archives = [dmg, zip, makeSourceArchive(temp, stem)].map(staged => {
  const file = path.join(dist, path.basename(staged));
  fs.copyFileSync(staged, file);
  fs.utimesSync(file, stamp, stamp);
  return file;
 });
 const manifest = path.join(dist, stem + '-SHA256SUMS.txt');
 const hashes = archives.map(file => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return hash + '  ' + path.basename(file);
 });
 fs.writeFileSync(manifest, hashes.join('\n') + '\n');
 fs.utimesSync(manifest, stamp, stamp);
 console.log(JSON.stringify({version, files:[...archives,manifest].map(f=>path.basename(f)), buildTime:new Date(stamp*1000).toISOString()}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
