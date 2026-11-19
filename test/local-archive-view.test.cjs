'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const archive=require('../lib/completeness'),cache=require('../lib/cache-session'),view=require('../lib/local-archive-view'),{createLocalView}=require('../desktop/local-view');
const uid='1234567890',peer='9876543210';
function fixture(fn){const base=fs.mkdtempSync(path.join(os.tmpdir(),'weibo-local-archive-')),dir=path.join(base,'data/user-comments',uid);fs.mkdirSync(path.join(dir,'cache'),{recursive:true});fs.writeFileSync(path.join(base,'data/.layout-v2'),'2');const save=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));},row=(id,author=uid,text='正文 '+id)=>({idstr:id,text,created_at:'2026-10-31T10:00:00+08:00',user:{idstr:author,screen_name:author===uid?'目标':'对方'},status:{idstr:'8888888888',text:'原微博',user:{idstr:peer}}});try{fn({base,dir,save,row});}finally{fs.rmSync(base,{recursive:true,force:true});}}
const values=data=>[...data.records].map(([id,e])=>[id,e.row,e.provenance]);
test('one-pass direction loading matches separate authoritative archives, including snapshot fallback and missing bodies',()=>fixture(({dir,save,row})=>{
 save(path.join(dir,'cache/sent_c2_m0.json'),{comments:[row('101'),row('102',uid,'')],miss_ids:['103']});save(path.join(dir,'cache/received_c1_m0.json'),{comments:[row('201',peer)]});const rows=[require('../lib/core').normalize(row('99'),'sent',uid),require('../lib/core').normalize(row('199',peer),'received',uid)];const box={schema:1,uid,rows},bytes=JSON.stringify(box),hash=crypto.createHash('sha256').update(bytes).digest('hex');save(path.join(dir,'cache/report-snapshots',hash+'.json'),box);
 const single=Object.fromEntries(['sent','received'].map(k=>[k,archive.loadIndependentArchive(dir,k,uid)]));const session=cache.createCacheSession({maxBytes:1024}),multi=archive.loadIndependentArchives(dir,['sent','received'],uid,session);for(const k of ['sent','received'])assert.deepEqual(values(multi[k]),values(single[k]));assert.ok(multi.sent.knownIds.has('102'));assert.ok(multi.sent.knownIds.has('103'));assert.equal(multi.sent.records.has('102'),false);assert.equal(multi.sent.records.has('199'),false);assert.equal(multi.received.records.has('99'),false);assert.ok(session.memory().retainedBytes<=1024);
}));
test('persistent local body index reuses on restart, rebuilds corrupt/changed/deleted inputs and never changes progress or read state',()=>fixture(({base,dir,save,row})=>{
 const file=path.join(dir,'cache/sent_c1_m0.json');save(file,{comments:[row('101')]});const progress=path.join(dir,'cache/updates/sent.json');save(progress,{schema:1,uid,kind:'sent',anchor:'100',pending:{head:'105',cursor:'103'}});const before=fs.readFileSync(progress),a=view.create(base,dir,uid),session=cache.createCacheSession({maxBytes:1024});assert.equal(a.load(dir,'sent',uid,session).records.size,1);assert.equal(a.stats.builds,1);const b=view.create(base,dir,uid);assert.equal(b.load(dir,'sent',uid,cache.createCacheSession()).records.size,1);assert.equal(b.stats.sourceReads,0);assert.equal(b.stats.reuses,1);
 const folder=path.join(dir,'cache/view-indexes'),index=path.join(folder,'local-archive-v1.json');fs.writeFileSync(index,'corrupt');const c=view.create(base,dir,uid);assert.equal(c.load(dir,'sent',uid,cache.createCacheSession()).records.size,1);assert.equal(c.stats.builds,1);save(file,{comments:[row('102')]});assert.deepEqual([...c.load(dir,'sent',uid,cache.createCacheSession()).records.keys()],['102']);fs.unlinkSync(file);assert.equal(c.load(dir,'sent',uid,cache.createCacheSession()).records.size,0);assert.deepEqual(fs.readFileSync(progress),before);assert.equal(fs.existsSync(path.join(dir,'cache/follow-inbox.json')),false);
}));
test('indexed export remains exact and local for large duplicates, quotes, date and direction selection after restart',()=>fixture(({base,dir,save,row})=>{
 const records=Array.from({length:400},(_,i)=>row(String(1000+i),i%2?peer:uid));save(path.join(dir,'cache/sent_c200_m0.json'),{comments:records.filter((_,i)=>i%2===0)});save(path.join(dir,'cache/received_c200_m0.json'),{comments:records.filter((_,i)=>i%2===1)});const q={target:uid,mode:'comments-both',limit:'200',markUnread:true},a=createLocalView(base),first=a.prepare(q),ids=first.jobs.flatMap(j=>j.rows.map(r=>r.recordId));assert.equal(new Set(ids).size,200);assert.equal(first.summary.matched,400);const out=a.exportCurrent(q),b=createLocalView(base),second=b.prepare(q);assert.deepEqual(second.jobs.flatMap(j=>j.rows.map(r=>r.recordId)),ids);assert.equal(b.exportCurrent(q).reused,true);assert.equal(require('../lib/report-records').formalIds(fs.readFileSync(path.join(base,'output',out.files[0]),'utf8'),uid).length,200);assert.equal(b.prepare({...q,from:'2026-11-01'}).summary.selected,0);
}));

test('an archive support symlink rebuilds from raw evidence without opening or modifying its target', t => fixture(({base, dir, save, row}) => {
 const packet = path.join(dir, 'cache/sent_c1_m0.json');
 save(packet, {comments:[row('101')], miss_ids_str:['102']});
 const snapshot = instance => instance.snapshot(cache.createCacheSession()).sent;
 const expected = archive.loadIndependentArchive(dir, 'sent', uid);
 snapshot(view.create(base, dir, uid));
 const support = path.join(dir, 'cache/view-indexes/local-archive-sources-v1.bin.gz');
 const target = path.join(base, 'external-support.bin.gz');
 fs.renameSync(support, target);
 const bytes = fs.readFileSync(target);
 fs.symlinkSync(target, support);
 const open = fs.openSync;
 let linkedOpens = 0;
 t.mock.method(fs, 'openSync', (file, ...args) => {
  if (file === target || file === support && fs.lstatSync(support).isSymbolicLink()) linkedOpens++;
  return open(file, ...args);
 });

 const instance = view.create(base, dir, uid);
 const result = snapshot(instance);
 assert.deepEqual(result.records, expected.records);
 assert.deepEqual(result.knownIds, expected.knownIds);
 assert.deepEqual(result.warnings, expected.warnings);
 assert(instance.stats.sourceReads > 0, 'the raw packet must be read even though the link points to the original valid pack');
 assert.equal(linkedOpens, 0);
 assert.deepEqual(fs.readFileSync(target), bytes);
}));

test('cold additions to a large archive skip the candidate pack and preserve the authoritative body, provenance and missing IDs', () => fixture(({base,dir,save,row}) => {
 const cacheDir = path.join(dir, 'cache');
 const packet = path.join(cacheDir, 'sent_c100_m0.json');
 const records = Array.from({length:100}, (_, i) => row(String(1000 + i), uid, crypto.randomBytes(112 * 1024).toString('base64')));
 save(packet, {comments:records, miss_ids_str:['1100']});
 const schema = require('../lib/exchange-schema');
 const importedRow = require('../lib/core').normalize(row('1200',peer,'导入正文'), 'received', uid);
 const imported = {schema:1, role:'records', owner:{kind:'user',id:uid}, channel:'received',
  savedAt:'2026-10-25T05:00:00Z', rows:[schema.row(importedRow, 'received')]};
 const exchangeDir = path.join(cacheDir, 'exchange-v1'), content = schema.stable(imported);
 fs.mkdirSync(exchangeDir);
 fs.writeFileSync(path.join(exchangeDir, schema.hash(content) + '.json'), content);
 const receipt = (n, comments, kind = 'sent') => {
  const file = path.join(cacheDir, 'request-journal', n + '.response.json');
  save(file, {schema:1, query:{uid, kind}, response:{comments}});
  return file;
 };
 const channels = ['sent','received','mentions-comments','mentions-posts'];
 const snapshot = () => view.create(base,dir,uid).snapshot(cache.createCacheSession({maxBytes:1024}));
 snapshot();
 const support = path.join(cacheDir, 'view-indexes/local-archive-sources-v1.bin.gz');
 const index = path.join(cacheDir, 'view-indexes/local-archive-v1.json');
 assert(fs.statSync(support).size > 8 * 1024 * 1024);
 const originalIndex = fs.readFileSync(index);

 function checkCold({expectFast = false} = {}) {
  const regular = require('../lib/regular-file'), read = regular.read;
  let candidateReads = 0;
  regular.read = (file, options) => {
   if (file === support) candidateReads++;
   return read(file, options);
  };
  let projected;
  try { projected = snapshot(); } finally { regular.read = read; }
  const authoritative = archive.loadIndependentArchives(dir, channels, uid, cache.createCacheSession({maxBytes:1024}));
  for (const kind of channels) {
   assert.deepEqual(projected[kind].records, authoritative[kind].records, kind + ' bodies and provenance');
   assert.deepEqual(projected[kind].knownIds, authoritative[kind].knownIds, kind + ' known IDs');
   assert.deepEqual(projected[kind].warnings, authoritative[kind].warnings, kind + ' warnings');
  }
  if (expectFast) {
   assert.equal(candidateReads, 0, 'the first cold load after an addition should not open the historical candidates');
   assert.deepEqual(fs.readFileSync(index), originalIndex, 'the original durable base is retained');
  }
  return projected;
 }

 receipt('0001', []);
 assert(!checkCold({expectFast:true}).sent.records.has('1100'), 'an empty receipt cannot promote a known ID');
 const newest = receipt('0002', [row('1100'), row('1101')]);
 const afterAddition = checkCold({expectFast:true});
 assert.equal(afterAddition.sent.records.size, 102);
 assert.equal(afterAddition.sent.records.get('1100').row.content, '正文 1100');
 assert.equal(afterAddition.sent.records.get('1101').provenance.file, path.relative(dir, newest));
 checkCold({expectFast:true});

 // An imported copy and a native observation of the same ID need the
 // authoritative precedence rules, even when every native source is new.
 assert.equal(afterAddition.received.records.get('1200').row.content, '导入正文');
 const overlap = receipt('0004', [row('1200', peer, '本机正文')], 'received');
 const merged = checkCold().received.records.get('1200');
 assert.equal(merged.provenance.file, path.relative(dir, overlap));
 fs.unlinkSync(overlap);
 assert.equal(checkCold().received.records.get('1200').row.content, '导入正文');

 // A later receipt with the same ID, replacing its source, and then removing
 // it must reveal the winning retained version at each step.
 const duplicate = receipt('0003', [row('1100', uid, '第二份正文')]);
 fs.utimesSync(duplicate, new Date('2030-01-01'), new Date('2030-01-01'));
 assert.equal(checkCold().sent.records.get('1100').row.content, '第二份正文');
 save(duplicate, {schema:1, query:{uid,kind:'sent'}, response:{comments:[row('1102')]}});
 const afterReplacement = checkCold();
 assert.equal(afterReplacement.sent.records.get('1100').row.content, '正文 1100');
 assert(afterReplacement.sent.records.has('1102'));
 fs.unlinkSync(newest);
 const afterRemoval = checkCold();
 assert(afterRemoval.sent.knownIds.has('1100'));
 assert(!afterRemoval.sent.records.has('1100'));
 assert(!afterRemoval.sent.knownIds.has('1101'));

 // A damaged support file or unparseable journal cannot certify an empty,
 // warning-free archive. The original packets still reconstruct the result.
 fs.writeFileSync(support, 'damaged');
 fs.writeFileSync(duplicate, '{broken');
 const repaired = checkCold();
 assert(repaired.sent.warnings.some(message => message.includes(path.basename(duplicate))));
 assert.equal(repaired.sent.records.size, 100);
}));

test('recent snapshot overlaps preserve source order without the large pack and fall back beyond the history limit', t => fixture(({base, dir, save, row}) => {
 const {normalize} = require('../lib/core');
 const schema = require('../lib/exchange-schema');
 const cacheDir = path.join(dir, 'cache');
 const oldPacket = path.join(cacheDir, 'sent_page1.json');
 save(oldPacket, {comments:[row('101', uid, crypto.randomBytes(9 * 1024 * 1024).toString('base64'))]});
 fs.utimesSync(oldPacket, new Date('2020-01-01'), new Date('2020-01-01'));
 const native = row('101', uid, '本机正文');
 save(path.join(cacheDir, 'sent_c1_m0.json'), {comments:[native]});

 const imported = normalize(row('201', peer, '导入正文'), 'received', uid);
 const content = schema.stable({schema:1, role:'records', owner:{kind:'user',id:uid}, channel:'received',
  savedAt:'2026-10-25T05:00:00Z', rows:[schema.row(imported, 'received')]});
 const exchange = path.join(cacheDir, 'exchange-v1', schema.hash(content) + '.json');
 fs.mkdirSync(path.dirname(exchange));
 fs.writeFileSync(exchange, content);

 // Start one ID above the retained-history bound and another exactly at it.
 // Each receipt is an independent contribution with an identifiable winner.
 const receipt = (n, ids) => {
  const file = path.join(cacheDir, 'request-journal', n.toString(16).padStart(4, '0') + '.response.json');
  const comments = ids.map(id => row(id, uid, '第 ' + n + ' 次保存'));
  save(file, {schema:1, query:{uid,kind:'sent'}, response:{comments}});
  const stamp = new Date(Date.UTC(2026, 10, 1, 0, 0, n));
  fs.utimesSync(file, stamp, stamp);
 };
 for (let n = 1; n <= 129; n++) receipt(n, n <= 128 ? ['501', '502'] : ['501']);

 // Names are content hashes. Write the later-sorting file first so a new
 // snapshot can change the winner even for IDs that were already complete.
 const snapshots = ['301', '302'].map(replyId => {
  const rows = [
   {...normalize(native, 'sent', uid), replyId},
   {...imported, replyId},
   normalize(row('102', uid, '快照正文 ' + replyId), 'sent', uid)
  ];
  const box = {schema:1, uid, rows};
  const hash = crypto.createHash('sha256').update(JSON.stringify(box)).digest('hex');
  return {file:path.join(cacheDir, 'report-snapshots', hash + '.json'), box, replyId};
 }).sort((a, b) => a.file < b.file ? -1 : 1);
 const [added, original] = snapshots;
 save(original.file, original.box);
 const support = path.join(cacheDir, 'view-indexes/local-archive-sources-v1.bin.gz');
 const regular = require('../lib/regular-file'), read = regular.read;
 let candidateReads = 0;
 t.mock.method(regular, 'read', (file, options) => {
  if (file === support) candidateReads++;
  return read(file, options);
 });
 const open = () => view.create(base, dir, uid);
 const session = () => cache.createCacheSession({maxBytes:1024});
 const initial = open();
 const first = initial.snapshot(session());
 assert.equal(first.sent.records.get('101').row.replyId, original.replyId);
 assert.equal(first.received.records.get('201').row.replyId, original.replyId);
 assert.equal(first.sent.records.get('102').provenance.file, path.relative(dir, original.file));
 assert(fs.statSync(support).size > 8 * 1024 * 1024);
 const reopened = open();
 reopened.snapshot(session());

 save(added.file, added.box);
 const kinds = ['sent', 'received', 'mentions-comments', 'mentions-posts'];
 const expected = archive.loadIndependentArchives(dir, kinds, uid, session());
 assert.equal(expected.sent.records.get('101').row.replyId, added.replyId);
 assert.equal(expected.sent.records.get('101').row.content, '本机正文');
 assert.equal(expected.sent.records.get('101').provenance.file, 'cache/sent_c1_m0.json');
 assert.equal(expected.received.records.get('201').row.replyId, added.replyId);
 assert.equal(expected.received.records.get('201').row.content, '导入正文');
 assert.equal(expected.received.records.get('201').provenance.file, path.relative(dir, exchange));
 assert.equal(expected.sent.records.get('102').row.content, '快照正文 ' + added.replyId);
 assert.equal(expected.sent.records.get('102').provenance.file, path.relative(dir, added.file));

 // The cold run starts without a resolved result for this addition. The two
 // live instances retain their original candidate and resolved views.
 function matches(instance, expected) {
  const actual = instance.snapshot(session());
  for (const kind of kinds) {
   assert.deepEqual(actual[kind].records, expected[kind].records);
   assert.deepEqual(actual[kind].knownIds, expected[kind].knownIds);
   assert.deepEqual(actual[kind].warnings, expected[kind].warnings);
  }
 }
 for (const instance of [open(), reopened]) {
  candidateReads = 0;
  matches(instance, expected);
  assert.equal(candidateReads, 0, 'recent overlap must use the whole retained history without opening the candidate pack');
 }
 matches(initial, expected);

 function checkReceipt(n, id, expectFullLoad) {
  receipt(n, [id]);
  const expected = archive.loadIndependentArchives(dir, kinds, uid, session());
  assert.equal(expected.sent.records.get(id).row.content, '第 ' + n + ' 次保存');
  candidateReads = 0;
  matches(open(), expected);
  assert.equal(candidateReads > 0, expectFullLoad, 'all previous contributions are needed to replay ID ' + id);
 }
 checkReceipt(130, '502', false); // all 128 previous contributions are available
 checkReceipt(131, '502', true);  // the incremental view now has 129
 checkReceipt(132, '501', true);  // the original view already had 129
}));
