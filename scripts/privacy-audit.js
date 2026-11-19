'use strict';

const fs = require('node:fs');
const path = require('node:path');

const safeExampleDomains = /(?:^|\.)(?:example\.(?:com|net|org|test|invalid)|invalid|localhost)$/i;
const sampleHomes = new Set(['Test_Person', 'example-user']);
const homePath = /\/(?:Users|home)\/([A-Za-z][\w.-]{0,63})\//g;
const email = /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})\b/g;
const secret = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const thirdParty = /(?:^|\/)(?:node_modules\/|desktop\/licenses\/|Node-LICENSE\.txt$|runtime\/bin\/node$)/;

function findings(bytes, { dependency = false, denied = [] } = {}) {
    const ascii = bytes.toString('latin1'), issues = [];
    const folded = denied.length ? ascii.toLowerCase() : '';
    if (denied.some(value => folded.includes(Buffer.from(value, 'utf8').toString('latin1').toLowerCase()) ||
        bytes.includes(Buffer.from(value, 'utf16le')))) issues.push('excluded identity or link');
    if (secret.test(ascii)) issues.push('credential material');
    // Bundled dependencies can legitimately contain upstream build locations
    // and attribution. The explicit exclusion list still checks every byte.
    if (!dependency) {
        if ([...ascii.matchAll(homePath)].some(match => !sampleHomes.has(match[1]))) issues.push('absolute home path');
        if ([...ascii.matchAll(email)].some(match => match[0].toLowerCase() !== 'weiboreader@proton.me' && !safeExampleDomains.test(match[1]))) issues.push('non-example email');
    }
    return issues;
}

function readDenyList(file) {
    if (!file) return [];
    const values = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length < 5)) {
        throw Error('Invalid local exclusion list');
    }
    return values;
}

function auditFiles(root, files, denied = readDenyList(process.env.WEIBO_RELEASE_DENY_FILE)) {
    const results = [];
    for (const file of files) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        const stat = fs.lstatSync(file);
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
        const issues = findings(bytes, { dependency: thirdParty.test(relative), denied });
        if (issues.length) results.push({ file: relative, issues });
    }
    return results;
}

module.exports = { auditFiles, findings, readDenyList };
