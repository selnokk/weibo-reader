'use strict';
// Disposable projections for offline search. Every part belongs to one exact
// owner and raw source. No search index supplies collection or continuity proof.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const corpus = require('./local-corpus');
const views = require('./file-view-cache');
const regular = require('./regular-file');
const progressStore = require('./update-progress');

const VERSION = 5;
const META_LIMIT = 4 * 1024 * 1024;
const PART_LIMIT = 8 * 1024 * 1024;
const CHUNK_TARGET = 2 * 1024 * 1024;
const COMPRESS_AT = 8192;
const PART_NAME = /^[a-f0-9]{64}\.\d+\.json(?:\.gz)?$/;
const SOURCE_META_NAME = /^[a-f0-9]{64}\.index\.json$/;
const sourceKey = (owner, entry) => corpus.hash([VERSION, owner.key, entry.relative, entry.signature]);

function file(base, owner) {
 return path.join(require('./data-layout').readerRoot(base), 'indexes/search-v1', corpus.hash(owner.key) + '.json');
}

function safeParents(base, name, create = false) {
 const root = require('./data-layout').readerRoot(base);
 const relative = path.relative(root, path.dirname(name));
 if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('搜索索引目录越界');
 let dir = root;
 for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
  if (part) dir = path.join(dir, part);
  if (create && !fs.existsSync(dir)) {
   try { fs.mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!fs.lstatSync(dir).isDirectory()) throw Error('搜索索引目录不是普通目录');
 }
}

function read(base, name, limit, namespace, validate, metrics) {
 safeParents(base, name);
 const stamp = views.regularStamp(name);
 if (!stamp || stamp.size > limit) throw Error('搜索索引需要分批重建');
 const value = views.memo(namespace + '\0' + name, stamp.signature, () => {
  const bytes = regular.read(name, {maxBytes:limit, verifyParent:() => safeParents(base, name)});
  const json = name.endsWith('.gz') ? zlib.gunzipSync(bytes, {maxOutputLength:limit}) : bytes;
  const box = JSON.parse(json);
  metrics.indexReads++;
  if (!validate(box)) throw Error('搜索索引校验失败');
  return box;
 });
 safeParents(base, name);
 if (views.regularStamp(name)?.signature !== stamp.signature) throw Error('搜索索引在读取时变化');
 return value;
}

function write(base, name, value) {
 safeParents(base, name, true);
 progressStore.atomic(name, value);
}

function readManifest(base, name, owner, metrics) {
 return read(base, name, META_LIMIT, 'search-manifest-v5', box =>
  box.schema === 2 && box.version === VERSION && box.owner === owner.key &&
  box.files && box.hash === corpus.hash(box.files), metrics);
}

function validMeta(meta, entry, key) {
 return meta?.signature === entry.signature && Array.isArray(meta.parts) && meta.parts.length <= 65536 &&
  meta.parts.every(p => p && PART_NAME.test(p.name) && p.name.startsWith(key + '.') && /^[a-f0-9]{64}$/.test(p.hash));
}

function validRow(row) {
 return row && typeof row.content === 'string' && typeof row.version === 'string' &&
  typeof row.postText === 'string' && typeof row.channel === 'string';
}

function readPart(base, folder, owner, entry, part, metrics) {
 return read(base, path.join(folder, part.name), PART_LIMIT, 'search-part-v5:' + part.hash, box =>
  box.schema === 1 && box.version === VERSION && box.owner === owner.key && box.source === entry.relative &&
  box.signature === entry.signature && Array.isArray(box.rows) && box.rows.every(validRow) &&
  box.hash === part.hash && box.hash === corpus.hash(box.rows), metrics);
}

function writePart(base, folder, name, bytes, hash) {
 if (bytes.length > PART_LIMIT) throw Error('单条搜索内容过大，未缓存');
 let stored = bytes;
 if (bytes.length >= COMPRESS_AT) {
  const compressed = zlib.gzipSync(bytes, {level:1});
  if (compressed.length < bytes.length) {
   stored = compressed;
   name += '.gz';
  }
 }
 const target = path.join(folder, name);
 safeParents(base, target, true);
 progressStore.atomicBytes(target, stored);
 return {name, hash};
}

function* chunksOf(rows) {
 let chunk = [], json = [], size = 0;
 for (const row of rows) {
  const encoded = JSON.stringify(row);
  const bytes = Buffer.byteLength(encoded) + 1;
  if (chunk.length && size + bytes > CHUNK_TARGET) {
   yield {rows:chunk, json:'[' + json.join(',') + ']'};
   chunk = [];
   json = [];
   size = 0;
  }
  chunk.push(row);
  json.push(encoded);
  size += bytes;
 }
 if (chunk.length) yield {rows:chunk, json:'[' + json.join(',') + ']'};

}

async function scanSource(base, owner, entry, folder, previous, {metrics, tick, onSource, upgrade}) {
 const key = sourceKey(owner, entry);
 const metaFile = path.join(folder, key + '.index.json');
 const saveMeta = value => write(base, metaFile, {
  schema:1, version:VERSION, owner:owner.key, source:entry.relative, value, hash:corpus.hash(value),
 });
 let meta = previous;
 if (!validMeta(meta, entry, key)) {
  try {
   meta = read(base, metaFile, 256 * 1024, 'search-source-meta-v5', box =>
    box.schema === 1 && box.version === VERSION && box.owner === owner.key && box.source === entry.relative &&
    validMeta(box.value, entry, key) && box.hash === corpus.hash(box.value), metrics).value;
  } catch { meta = null; }
 }
 if (meta) {
  // Validate before delivery so a corrupt final part cannot cause duplicate callbacks.
  // Most sources fit in one part. Keep that one result rather than reopening it.
  let singlePart;
  for (const part of meta.parts) {
   await tick();
   try {
    const box = readPart(base, folder, owner, entry, part, metrics);
    if (meta.parts.length === 1) singlePart = box;
   } catch {
    meta = null;
    break;
   }
  }
  if (meta) {
   metrics.reusedSources++;
   let offset = 0;
   // A legacy index stays usable during migration. Limit optional compression
   // per owner so opening a search never rewrites a whole large library.
   let packing = !meta.compact && upgrade.bytes > 0 && upgrade.parts > 0;
   const parts = packing ? [] : null;
   for (const part of meta.parts) {
    await tick();
    const box = singlePart || readPart(base, folder, owner, entry, part, metrics);
    let stored = part;
    if (packing && !part.name.endsWith('.gz')) {
     try {
      const size = views.regularStamp(path.join(folder, part.name)).size;
      if (size >= COMPRESS_AT) {
       if (upgrade.bytes <= 0 || upgrade.parts <= 0) packing = false;
       else {
        upgrade.bytes -= size;
        upgrade.parts--;
        stored = writePart(base, folder, part.name, Buffer.from(JSON.stringify(box)), part.hash);
       }
      }
     } catch { packing = false; }
    }
    parts?.push(stored);
    await onSource(entry.relative, box.rows, offset);
    offset += box.rows.length;
   }
   if (parts?.some((part, i) => part !== meta.parts[i])) {
    const updated = {...meta, parts, compact:packing};
    try {
     saveMeta(updated);
     return updated;
    } catch { return meta; }
   }
   return packing ? {...meta, compact:true} : meta;
  }
 }

 metrics.sourceReads++;
 metrics.updatedSources++;
 let rows = [], warning = '';
 try { rows = corpus.project(entry, owner); }
 catch (error) { warning = path.basename(entry.file) + '：' + error.message; }
 if (views.stamp(entry.file)?.signature !== (entry.sourceSignature || entry.signature)) {
  throw Error('本地数据正在变化，请重新搜索');
 }
 meta = {signature:entry.signature, parts:[], warning, compact:true};
 let offset = 0;
 for (const chunk of chunksOf(rows)) {
  await tick();
  if (meta.parts) {
   // Chunking, hashing and writing use the same serialized rows.
   const hash = corpus.hash(chunk.json);
   const header = {schema:1, version:VERSION, owner:owner.key, source:entry.relative, signature:entry.signature, hash};
   const bytes = Buffer.from(JSON.stringify(header).slice(0, -1) + ',"rows":' + chunk.json + '}');
   try { meta.parts.push(writePart(base, folder, key + '.' + meta.parts.length + '.json', bytes, hash)); }
   catch { meta.parts = null; }
  }
  await onSource(entry.relative, chunk.rows, offset);
  offset += chunk.rows.length;
 }
 if (meta.parts) {
  try { saveMeta(meta); }
  catch { meta.parts = null; }
 }
 return meta;
}

async function retireObsolete(base, folder, owner, entries, saved, tick) {
 const keep = new Set();
 for (const entry of entries) {
  keep.add(sourceKey(owner, entry) + '.index.json');
  for (const part of saved.files[entry.relative].parts) keep.add(part.name);
 }
 if (!fs.existsSync(folder)) return;
 safeParents(base, path.join(folder, 'placeholder'));
 for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
  await tick();
  if (!entry.isFile() || keep.has(entry.name) || !(PART_NAME.test(entry.name) || SOURCE_META_NAME.test(entry.name))) continue;
  const name = path.join(folder, entry.name);
  if (fs.lstatSync(name).isFile()) fs.unlinkSync(name);
 }
}

async function scanLocked(base, owner, {signal, progress = () => {}, onSource = () => {}, metrics}) {
 const tick = require('./local-work').checkpoint(signal, 6);
 const manifest = corpus.manifest(owner);
 const checkSources = () => {
  signal?.throwIfAborted();
  if (corpus.manifest(owner).token !== manifest.token) throw Error('本地数据正在变化，请重新搜索');
 };
 const name = file(base, owner);
 const folder = path.join(path.dirname(name), 'parts', corpus.hash(owner.key));
 let previous;
 try { previous = readManifest(base, name, owner, metrics); } catch { /* Rebuild locally. */ }
 const files = {}, warnings = [];
 const upgrade = {bytes:1024 * 1024, parts:8};
 let done = 0;
 for (const entry of manifest.files) {
  await tick();
  const meta = await scanSource(base, owner, entry, folder, previous?.files[entry.relative], {metrics, tick, onSource, upgrade});
  files[entry.relative] = meta;
  if (meta.warning) warnings.push(meta.warning);
  if (++done % 16 === 0) progress({object:owner.key, done, total:manifest.files.length});
 }
 checkSources();
 const hash = corpus.hash(files);
 let committed = previous?.hash === hash && fs.existsSync(name);
 if (!committed) {
  try {
   const value = {schema:2, version:VERSION, owner:owner.key, files, hash};
   if (Buffer.byteLength(JSON.stringify(value)) > META_LIMIT) throw Error('索引清单过大');
   write(base, name, value);
   committed = true;
  } catch (error) { warnings.push('搜索索引清单未能保存：' + error.message); }
 }
 if (committed && !warnings.length && Object.values(files).every(meta => Array.isArray(meta.parts))) {
  checkSources();
  try {
   const saved = readManifest(base, name, owner, metrics);
   if (saved.hash !== hash) throw Error('搜索索引清单已变化');
   await retireObsolete(base, folder, owner, manifest.files, saved, tick);
  } catch (error) {
   if (signal?.aborted) throw error;
   warnings.push('搜索旧索引清理未完成：' + error.message);
  }
 }
 return {owner, token:manifest.token, files, warnings};
}

async function scan(base, owner, options = {}) {
 const name = file(base, owner);
 safeParents(base, name, true);
 const lease = require('./process-lease').acquire(name + '.lock', '此对象的搜索索引正在整理，请稍后重试');
 try { return await scanLocked(base, owner, options); }
 finally { lease.release(); }
}
module.exports = {scan, file, VERSION, META_LIMIT, PART_LIMIT};
