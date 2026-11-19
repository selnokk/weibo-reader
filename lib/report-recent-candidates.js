'use strict';

// Reports normally select the latest records. Keep the complete native source
// list for a bounded set of those IDs so an overlapping export snapshot can
// replay the original merge order without opening the full archive.
const path = require('node:path');
const v8 = require('node:v8');

function latest(channels, data) {
 const ids = new Map();
 for (const kind of channels) {
  const rows = [...data[kind].records.values()].map(entry => entry.row);
  for (const row of require('./core').sortRecords(rows).slice(0, 256)) {
   const previous = ids.get(row.recordId);
   if (!previous || row.ms > previous.ms) ids.set(row.recordId, row);
  }
 }
 return ids;
}

function bounded(history, priorities) {
 const retained = new Map();
 let bytes = 0, count = 0;
 for (const {recordId:id} of require('./core').sortRecords(priorities.values())) {
  const entries = history.get(id);
  if (!entries || entries.length > 128 || count + entries.length > 20000) continue;
  let size;
  try { size = v8.serialize(entries).length; } catch { continue; }
  if (bytes + size > 16 * 1024 * 1024) continue;
  retained.set(id, entries);
  count += entries.length;
  bytes += size;
 }
 return retained;
}

function capture(channels, data, sources, dir, resolve) {
 const priorities = latest(channels, data);
 const history = new Map([...priorities.keys()].map(id => [id, []]));
 for (const [relative, source] of Object.entries(sources)) {
  const filename = path.join(dir, relative);
  for (const kind of channels) {
   for (const ref of source.part[kind].records) {
    const list = history.get(ref[0]);
    if (!list) continue;
    if (list.length === 128) history.delete(ref[0]);
    else list.push([filename, kind, resolve(ref)]);
   }
  }
 }
 return bounded(history, priorities);
}

function extend(channels, previous, additions, oldData, data) {
 if (!(previous instanceof Map)) return;
 const history = new Map(previous), changed = new Set();
 for (const [file, part] of additions) {
  for (const kind of channels) {
   for (const [id, entry] of part[kind].records) {
    if (!changed.has(id)) {
     // A previously untracked existing body may have other native candidates.
     if (!history.has(id) && channels.some(k => oldData[k].records.has(id))) continue;
     history.set(id, [...(history.get(id) || [])]);
     changed.add(id);
    }
    const list = history.get(id);
    if (list && list.length < 128) list.push([file, kind, entry]);
    else history.delete(id);
   }
  }
 }
 return changed.size ? bounded(history, latest(channels, data)) : previous;
}

function sourcesFor(channels, history, ids) {
 if (!(history instanceof Map)) return null;
 const files = new Map();
 for (const id of ids) {
  const entries = history.get(id);
  if (!Array.isArray(entries)) return null;
  for (const item of entries) {
   if (!Array.isArray(item)) return null;
   const [file, kind, entry] = item;
   if (typeof file !== 'string' || !channels.includes(kind) || entry?.row?.recordId !== id) return null;
   if (!files.has(file)) {
    files.set(file, Object.fromEntries(channels.map(k => [k, {records:new Map(), knownIds:[], warnings:[]}])));
   }
   files.get(file)[kind].records.set(id, entry);
  }
 }
 return files;
}

module.exports = {capture, extend, sourcesFor};
