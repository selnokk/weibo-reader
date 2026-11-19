'use strict';
// Offline read-only distribution audit. Never reads any personal workspace.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const payload=require('./desktop-payload');
const app=fs.realpathSync(path.resolve(process.argv[2]||'')),root=fs.realpathSync(path.resolve(__dirname,'..')),resources=path.join(app,'Contents/Resources'),engine=path.join(resources,'engine'),pkg=require('../package.json');
assert.ok(app.endsWith('.app')&&fs.existsSync(engine)&&fs.realpathSync(engine)===engine&&fs.lstatSync(engine).isDirectory(),'provide an extracted release .app');
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function walk(dir,include){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const f=path.join(dir,e.name);if(!include(f))return [];if(e.isSymbolicLink()){assert.ok(fs.realpathSync(f).startsWith(app+path.sep),'external bundle symlink');return [f];}return e.isDirectory()?walk(f,include):[f];});}
const files=walk(app,file=>{
 const relative=path.relative(engine,file);
 assert.ok(!payload.privateName(path.basename(file)),'private/temporary entry included '+path.relative(app,file));
 if(file.startsWith(engine+path.sep))assert.ok(payload.includes(relative),'unexpected engine entry '+relative);
 return true;
});
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');let checked=0;
for(const dir of ['lib','desktop'])for(const f of walk(path.join(root,dir),file=>payload.includes(path.relative(root,file)))){const rel=path.relative(root,f);assert.equal(hash(path.join(engine,rel)),hash(f),'stale bundle code '+rel);checked++;}
assert.equal(hash(path.join(resources,'LICENSE.txt')),hash(path.join(root,'LICENSE')),'wrong project license');
assert.equal(pkg.license,'MIT');
const sourceNames = new Set();
for (const item of ['lib', 'desktop', 'node_modules', 'package.json', 'weibo_cli.js', 'weibo_reader_user_guide.md']) {
 const input = path.join(root, item);
 if (!fs.statSync(input).isDirectory()) { sourceNames.add(item); continue; }
 // Dependencies have relative executable symlinks; compare their link text as shipped.
 function visit(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
   const file = path.join(dir, entry.name), relative = path.relative(root,file);
   if (!payload.includes(relative)) continue;
   if (entry.isDirectory()) visit(file); else sourceNames.add(relative);
  }
 }
 visit(input);
}
const actualNames = new Set(files.filter(f=>f.startsWith(engine+path.sep)).map(f=>path.relative(engine,f)));
assert.deepEqual(actualNames,sourceNames,'engine contains missing or unexpected files');
for (const rel of sourceNames) {
 const src=path.join(root,rel), dst=path.join(engine,rel);
 if(fs.lstatSync(src).isSymbolicLink()) assert.equal(fs.readlinkSync(dst),fs.readlinkSync(src),rel);
 else assert.equal(hash(dst),hash(src),'source mismatch '+rel);
}
const nodeVersion=/^Bundled Node\.js (v\d+\.\d+\.\d+(?:-[\w.-]+)?): see Node-LICENSE\.txt\./.exec(fs.readFileSync(path.join(resources,'THIRD_PARTY_NOTICES.txt'),'utf8'))?.[1];
assert.ok(nodeVersion,'missing bundled Node version notice');
assert.equal(hash(path.join(resources,'Node-LICENSE.txt')),hash(path.join(root,'desktop/licenses',nodeVersion+'-Node-LICENSE.txt')),'wrong bundled Node license');
for(const f of ['weibo_cli.js','package.json','weibo_reader_user_guide.md'])assert.equal(hash(path.join(engine,f)),hash(path.join(root,f)),f);
const plist=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')]));assert.equal(plist.WeiboAppVersion,pkg.version);assert.equal(plist.CFBundleVersion,String(pkg.buildNumber));assert.equal(plist.CFBundleShortVersionString,require('./app-version').appVersion(pkg).release);assert.equal(plist.WeiboDefaultWorkspace,undefined);assert.equal(plist.CFBundleIdentifier,'selnokk.weibo.reader');
const appArch=run('/usr/bin/lipo',['-archs',path.join(app,'Contents/MacOS/WeiboReader')]),nodeArch=run('/usr/bin/lipo',['-archs',path.join(app,'Contents/Resources/runtime/bin/node')]);assert.equal(appArch,'arm64');assert.equal(nodeArch,'arm64');run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const privacy=require('./privacy-audit').auditFiles(app,files);
assert.deepEqual(privacy,[],'bundle privacy scan flagged files');
console.log(JSON.stringify({passed:true,version:pkg.version,build:pkg.buildNumber,arch:appArch,files:files.length,sourceFilesCompared:checked,personalDataFiles:0,privacyFilesScanned:files.length,developerWorkspaceDefault:false,signature:'ad-hoc verified; not notarized'}));
