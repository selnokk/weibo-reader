'use strict';
// Read-only merge selection. Paths, staging validation and durable commits remain
// with data-exchange; this module owns typed scope grouping and version counts.
const S = require('./exchange-schema'), E = require('./exchange-records'), M=require('./exchange-merge');
function currentRows(dir, owner, kind) {
    let rows;
    if (kind === 'post-comments') {
        rows = require('./local-database').localPostComments({postId:owner.id}, dir).rows;
    } else if (kind === 'user-posts') {
        rows = require('./local-database').localPosts({uid:owner.id}, dir).rows;
    } else {
        const archive = require('./completeness').loadIndependentArchive(dir, kind, owner.id);
        rows = Array.from(archive.records.values(), entry => entry.row);
    }
    return new Map(rows.map(row => [row.recordId || row.id, S.row(row, kind)]));
}
async function plan(base, job, { staged, validateEntry, objectDirectory, signal }) {
    const checkpoint=require('./local-work').checkpoint(signal);let processed=0;
    const strings=new Map();let stringBytes=0;function intern(v){if(typeof v==='string'&&v.length>=12){const old=strings.get(v);if(old!==undefined)return old;if(stringBytes<64*1024*1024){strings.set(v,v);stringBytes+=Buffer.byteLength(v);}return v;}if(v&&typeof v==='object')for(const k of Object.keys(v))v[k]=intern(v[k]);return v;}
    // Index each incoming entry once. Unrelated local directions are not part of
    // this exchange and must not be repeatedly read while planning another scope.
    const validated=new Set(),readEntry=f=>{if(!validated.has(f.sha256))throw Error('交换内容尚未通过完整校验');return JSON.parse(staged(base,job,f));};
    const values = [], groups = new Map(), variants = new Map();
    let ignoredProgress = 0;
    for (const f of job.manifest.files) {
        await checkpoint();
        if (!['packet', 'records', 'progress'].includes(f.role)) continue;
        const v = validateEntry(f, staged(base, job, f));
        if (v.role === 'progress') {
            ignoredProgress++;
            continue;
        }
        validated.add(f.sha256);
        values.push({f,v:{role:v.role,owner:v.owner,channel:v.channel}});
        const key = S.key(v.owner) + '|' + v.channel;
        if (!groups.has(key)) groups.set(key, { owner: v.owner, kind: v.channel, items: [] });
        groups.get(key).items.push(f);
    }
    // A comment's personal reading identity is shared across these directions,
    // while content selection and continuity remain scoped to each channel.
    const localComments=new Map();
    const stats = { added: 0, duplicate: 0, conflicts: 0, contexts: 0, incomplete: 0, ignoredProgress, enriched:0 };
    const warnings = [], perObject = job.manifest.objects.map(o => ({ ...o, added: 0, conflicts: 0 })), objectStats = new Map(perObject.map(o => [S.key(o), o]));
    for (const { owner: o, kind, items } of groups.values()) {
        await checkpoint();
        const dir = objectDirectory(base, o, kind === 'user-posts' ? 'posts' : o.kind === 'post' ? 'post-comments' : 'user-comments');
        if (items.length) {
            const rows = currentRows(dir, o, kind), all = new Map([...E.versions(dir, kind, o.id)].map(([id,versions])=>[id,new Set(versions.keys())]));for(const [id,row]of rows)rows.set(id,intern(row));
            if(o.kind==='user'&&['sent','received','mentions-comments'].includes(kind)){
                const known=localComments.get(o.id)||{ids:new Set(),kinds:new Set()};known.kinds.add(kind);
                for(const [id,row]of rows)if(!row.isContext&&require('./record-body').completeBody(row))known.ids.add(id);
                localComments.set(o.id,known);
            }
            for (const f of items){const v=readEntry(f);
                for (const original of E.rowsOf(v)) {
                if(++processed%128===0)await checkpoint();
                    const row = intern(S.row(original, kind)), record = row.recordId, h = M.version(row,kind), key = S.key(o) + '|' + kind + '|' + record+(row.isContext?'|context':'');
                    if (!variants.has(key))
                        variants.set(key, { row, hash: h, versions: new Set(), existing:row.isContext?null:rows.get(record), existingVersions: all.get(record), incoming:new Map(),carriedInPacket:false, savedAt:v.savedAt, dir, owner: o, kind });
                    const entry = variants.get(key);
                    if(Date.parse(v.savedAt)<Date.parse(entry.savedAt))entry.savedAt=v.savedAt;entry.versions.add(h);entry.incoming.set(h,row);if(v.role==='packet')entry.carriedInPacket=true;
                    entry.row=M.merge(entry.row,row,kind);
                }}
        }

    }
    for (const entry of variants.values()) {
        const { row, existing, versions, existingVersions, owner,kind }=entry;entry.merged=M.merge(existing,row,kind);entry.changed=!M.persistedSame(existing,row,kind);
        if(++processed%128===0)await checkpoint();
        if (row.isContext) {
            stats.contexts++;
            continue;
        }
        if (!require('./record-body').completeBody(row) || row.truncated) {
            stats.incomplete++;
            continue;
        }
        if (!existing) {
            stats.added++;
            objectStats.get(S.key(owner)).added++;
        }
        else if (![...entry.incoming].some(([h,r])=>M.conflict(existing,r,kind)&&!existingVersions?.has(h))){stats.duplicate++;if(entry.changed)stats.enriched++;}
        else {
            stats.conflicts++;
            objectStats.get(S.key(owner)).conflicts++;
        }
    }
    const estimatedBytes=stringBytes+variants.size*3000+values.length*1024+[...localComments.values()].reduce((n,v)=>n+v.ids.size*48,0);
    return { values, variants, localComments, readEntry, estimatedBytes,summary: { objects: perObject, ...stats, warnings, credits: 0, compatible: true, damaged: false } };
}
module.exports = { plan };
