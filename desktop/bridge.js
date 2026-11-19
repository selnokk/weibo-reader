'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ENGINE = path.resolve(__dirname, '..');
const { options } = require('../lib/options');
const { conciseError } = require('../lib/terminal-report');
const { clean } = require('../lib/diagnostic-text');
const { buildArguments, targetUid, validateSubject } = require('./acquisition-arguments');
const library = require('./library');
const { listAccounts, listReports, containedReport } = library;
const {readLines:lineStream}=require('./line-channel');
function runBridge(configuration = {}) {
    let workspace = path.resolve(configuration.workspace || process.cwd()), active = null, accountTask = null, accountState = null, preparing = null, terminating = false, follow = null, manualQueue = null, profiles = null, deletions = null, bulk = null, priceReference = null, profileBatch = false;
    let booting=false, preparingWorkspace=false, workspaceReady=false, gapChoiceIssues=[], bootstrapGeneration=0, stagedHome=null;
    let nativeLibraryExpected=null, nativeLibraryAccepted=null, frontendEpoch=0;
    const nativeWorkspaceReady=()=>!configuration.requireNativeWorkspaceAck||nativeLibraryExpected?.workspace===workspace&&nativeLibraryAccepted?.workspace===workspace&&nativeLibraryAccepted.bootstrapId===nativeLibraryExpected.bootstrapId;
    let foregroundDispatching=false;const queuedDispatch=Symbol('queued foreground'),queuedRequests=new Map();
    const pendingForeground=()=>!!manualQueue&&!foregroundDispatching;
    function needsForeground(message){return ['workspace','userDeletePlan','userDeleteConfirm','manageDeletePlan','manageDeleteConfirm','profilesRefresh','userProfileRetry','postAuthorAvatar','userAdd','run','resumeTask','cleanup','merge','login','logout','recoveryRetry','taskGapIgnore','taskFuturePreview','taskFutureChoose','exchangeExport','exchangeInspect','exchangeCommit'].includes(message.action)||message.action==='manageBatch'&&message.operation==='subscribe';}
    function queueForeground(message){
        if(terminating)throw Error('正在保存并退出，未安排新的操作');
        const captured=structuredClone({...message,workspace:typeof message.workspace==='string'?message.workspace:workspace}),requestId=captured.requestId||crypto.randomUUID();captured.requestId=requestId;
        if(typeof requestId!=='string'||requestId.length>256)throw Error('排队请求身份无效');
        const signature=crypto.createHash('sha256').update(JSON.stringify(captured)).digest('hex'),previous=queuedRequests.get(requestId);
        if(previous){if(previous.signature!==signature)throw Error('排队请求身份与原操作不一致');return !previous.completed;}
        if(captured.action==='resumeTask')captured.query=require('./user-workspace').resume(workspace,captured.id,{budget:captured.returnBudget});
        const bytes=Buffer.byteLength(JSON.stringify(captured));
        if((manualQueue?.length||0)>=16||(manualQueue||[]).reduce((n,q)=>n+q.bytes,0)+bytes>4*1024*1024)throw Error('前台操作队列已满，请先完成或取消已有操作');
        const item={id:crypto.randomUUID(),requestId,message:captured,signature,bytes};
        (manualQueue??=[]).push(item);queuedRequests.set(requestId,item);
        const job=active||preparing;
        if(job?.automatic){
            if(preparing===job&&!active){job.cancelled=true;preparing=null;getFollow().finish(job.id,{code:0,cancelled:true,yielded:true,reason:'前台操作优先，尚未发起请求'});}
            else getFollow().interrupt('前台操作优先，保存当前响应后让出',{code:'AUTO_YIELD'});
        }
        scopedPublish(captured.workspace)(['run','resumeTask'].includes(captured.action)?'manualQueued':'foregroundQueued',{id:item.id,requestId,action:captured.action,...(captured.query?{query:captured.query}:{}),message:'正在等待后台响应保存，完成后自动执行。'});
        drainForeground();return true;
    }
    function drainForeground(){
        if(!manualQueue||foregroundDispatching||active||preparing||profileBatch||exchangeActive||terminating)return;
        const item=manualQueue.shift();if(!manualQueue.length)manualQueue=null;foregroundDispatching=true;
        Promise.resolve(handle(item.message,queuedDispatch)).finally(()=>{foregroundDispatching=false;queuedRequests.set(item.requestId,{signature:item.signature,completed:true});scopedPublish(item.message.workspace)('foregroundDequeued',{id:item.id,requestId:item.requestId,action:item.message.action});while(queuedRequests.size>512){const old=[...queuedRequests].find(([,value])=>value.completed);if(!old)break;queuedRequests.delete(old[0]);}drainForeground();});
    }
    function cancelForeground(requestId,all=false){
        if(!manualQueue)return false;
        const selected=all?manualQueue:requestId?manualQueue.filter(item=>item.requestId===requestId):manualQueue.slice(0,1);if(!selected.length)return false;
        manualQueue=manualQueue.filter(item=>!selected.includes(item));if(!manualQueue.length)manualQueue=null;
        for(const item of selected){queuedRequests.set(item.requestId,{signature:item.signature,completed:true});scopedPublish(item.message.workspace)('foregroundDequeued',{id:item.id,requestId:item.requestId,action:item.message.action,cancelled:true});scopedPublish(item.message.workspace)('localWriteState',{requestId:item.requestId,busy:false});if(['run','resumeTask'].includes(item.message.action)){recordPreparation({id:item.id,requestId:item.requestId,query:item.message.query,startedAt:new Date().toISOString()},'前台排队期间取消，尚未取数');scopedPublish(item.message.workspace)('finished',{id:item.id,taskId:item.id,requestId:item.requestId,kind:'collect',code:null,cancelled:true,preparation:true,reports:[]});}}
        drainForeground();return true;
    }
    let inventoryRepairs=null,inventoryBase=null,inventoryRecovered=false;const getInventoryRepairs=()=>{if(inventoryBase!==workspace){inventoryRepairs?.close();inventoryBase=workspace;inventoryRepairs=null;}return inventoryRepairs??=require('./inventory-repair').create(workspace,{publish:scopedPublish(workspace)});};
    let insights=null,insightsBase=null;const getInsights=()=>{if(insightsBase!==workspace){insights?.close();insightsBase=workspace;insights=null;}return insights??=require('./local-insights').create(workspace);};
    let reportAccess = null, finalizer = null, recoveredFinalization = false, exchangePromise = null, exchangeActive = false, exchangeController = null;
    const localActions = require('./local-actions').createLocalActions({ workspace: () => workspace, publish: base => scopedPublish(base), validateSubject, targetUid, inventoryRepairs: getInventoryRepairs, reportAccess: () => getReportAccess(), pendingReports:base=>reportAccesses.get(base)?.pendingReports()||[], terminating: () => terminating, isBusy:()=>!!active||!!preparing||!!manualQueue||!!exchangeActive||!!profileBatch, library, listReports, clean });
    const spawnChild = configuration.spawn || spawn;
    const reportAccesses=new Map();
    const getReportAccess = () => {let value=reportAccesses.get(workspace);if(!value){value=require('./report-access').createReportAccess(workspace);reportAccesses.set(workspace,value);while(reportAccesses.size>8)reportAccesses.delete(reportAccesses.keys().next().value);}return reportAccess=value;};
    const {wireJSON,sendNativeSnapshot}=require('./wire-format');
    const writeEvent=configuration.send||((message,json)=>process.stdout.write((json??wireJSON(message))+'\n'));
    const readingEvents=new Set(['homeUsers','postsHome','followState','reportMarkedRead']);
    let readingRevision=0;
    const send=message=>{
        if(readingEvents.has(message.type))message={...message,readingRevision:++readingRevision};
        if(configuration.requireNativeWorkspaceAck)sendNativeSnapshot(writeEvent,message,message.bootstrapId||String(bootstrapGeneration),frontendEpoch);
        else writeEvent(message);
    };
    const cli = path.join(ENGINE, 'node_modules', '@weibo-ai', 'weibo-cli', 'dist', 'index.js');
    const homeAvatars=require('./home-avatars').create({send,currentWorkspace:()=>workspace,isClosing:()=>terminating,schedule:run=>{
        const home=stagedHome;
        if(home?.avatarJobs)home.avatarJobs.push(run);
        else setImmediate(run);
    }});
    const publish = (type, data = {}) => {
        if(type==='library'&&configuration.requireNativeWorkspaceAck){
            const bootstrapId=data.bootstrapId||String(bootstrapGeneration);
            if(nativeLibraryExpected?.workspace!==workspace)nativeLibraryExpected={workspace,bootstrapId};
            data={...data,bootstrapId,nativeWorkspaceId:nativeLibraryExpected.bootstrapId};
        }
        send({ type, workspace, ...homeAvatars.prepare(type,data,workspace) });
    };
    const scopedPublish = base => (type, data = {}) => send({ type, workspace: base, ...data });
    const env = () => ({ ...process.env, WEIBO_DESKTOP_PROJECT: workspace, WEIBO_DESKTOP_CLI: cli, WEIBO_DESKTOP_EVENTS: '1', TERM: 'dumb', NO_COLOR: '1', PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '/usr/bin:/bin') });
    function deleting() { return ['deletion-jobs', 'bulk-deletion-jobs'].some(name => { const dir = path.join(require('../lib/data-layout').readerRoot(workspace), name); return fs.existsSync(dir) && fs.readdirSync(dir).some(n => n.endsWith('.json')); }); }
    function removeSubscriptions(t) { const service = getFollow(), ids = t.paths?.filter(p => p.includes('/post-comments/')).map(p => require('../lib/storage').postIdFromFolder(p.split('/').at(-1))) || []; for (const e of service.snapshot().entries)
        if (t.targetKind === 'post' ? e.targetKind === 'post' && (e.postId || e.uid) === t.id : e.targetKind !== 'post' && e.uid === t.id || e.targetKind === 'post' && ids.includes(e.postId || e.uid))
            service.remove(require('../lib/subscription-key').key(e)); if (t.targetKind !== 'post')
        getProfiles().cancel(t.id); }
    function getBulk() { return bulk ??= require('./bulk-management').create(workspace, { isBusy: () => !!active || !!preparing || pendingForeground() || profileBatch, beforeCommit: removeSubscriptions }); }
    function getDeletions() { return deletions ??= require('./user-deletion').createDeletion(workspace, { isBusy: () => !!active || !!preparing || pendingForeground() || profileBatch, beforeCommit: (uid, details) => removeSubscriptions({ targetKind: 'user', id: uid, paths: details.paths }) }); }
    function getProfiles() { return profiles ??= require('./user-profiles').createProfiles(workspace, { cli, publish: scopedPublish(workspace), ...(configuration.profileOptions || {}) }); }
    function recoverGapChoices(base,hasExclusive=false){
        if(base!==workspace)return false;
        const G=require('./gap-choice'),before=gapChoiceIssues;
        let issues=before.length?before:G.issues(base);
        if(issues.length)try{issues=hasExclusive?G.recover(base):require('../lib/workspace-access').withAccess(base,'exclusive',()=>G.recover(base));}
        catch(error){issues=issues.map(issue=>({...issue,message:clean(error.message)}));}
        gapChoiceIssues=issues;
        const changed=JSON.stringify(issues)!==JSON.stringify(before);
        if(changed)localActions.invalidate();
        return changed;
    }
    function getFollow() { const ownerBase=workspace;if (configuration.followService)
        return follow = configuration.followService; if (!follow)
        follow = require('./auto-follow').createAutoFollow(workspace, { recoverLocal:()=>{if(workspace!==ownerBase)return;if(gapChoiceIssues.length&&recoverGapChoices(ownerBase))scopedPublish(ownerBase)('recoveryState',recoveryState());if(getFinalizer().recoveryBlocked())getFinalizer().recover();},blockedDirections:e=>require('./gap-choice').blockedKinds(gapChoiceIssues,e),canDispatch:e=>workspace===ownerBase&&!getFinalizer().blockedFor({mode:e.targetKind==='post'?'post-comments':'comments-both',target:e.postId||e.uid}).length,isBusy: () => workspace!==ownerBase || !workspaceReady || !nativeWorkspaceReady() || exchangeActive || !!active || !!preparing || !!manualQueue || foregroundDispatching || terminating || profileBatch || deleting(), publish: scopedPublish(workspace), launch: round => launch('collect', [path.join(ENGINE, 'desktop/auto-runner.js'), round.id], { target: round.uid, mode: round.targetKind === 'post' ? 'post-comments' : { sent: 'comments-sent', received: 'comments-received', both: 'comments-both' }[round.mode], policy: 'update', syncOnly: true, limit: String(round.roundLimit) }, { id: round.id, automatic: true }) }); return follow; }
    function prepareWorkspace(){
        if(preparingWorkspace)return;preparingWorkspace=true;
        try{
            if (!recoveredFinalization) {
                getFinalizer().recover();
                recoveredFinalization = true;
            }
            const layout=require('../lib/data-layout');
            if(!layout.separated(workspace))require('../lib/workspace-access').withAccess(workspace,'exclusive',()=>layout.migrate(workspace));
            if (!active && !preparing&&deleting())require('../lib/workspace-access').withAccess(workspace,'exclusive',()=>{
                require('./user-deletion').recover(workspace);
                require('./bulk-management').recover(workspace);
            });
            if(!active&&!preparing)recoverGapChoices(workspace);
            if(gapChoiceIssues.length)publish('refreshWarning',{stage:'gap-choice-recovery',message:gapChoiceIssues.map(e=>e.file+'：'+e.message).join('；')});
            workspaceReady=true;
            if(!inventoryRecovered){inventoryRecovered=true;const base=workspace;setTimeout(()=>{if(terminating||workspace!==base)return;try{const service=getInventoryRepairs();service.recover();const folder=path.join(require('../lib/data-layout').readerRoot(base),'task-finalization');for(const name of require('./finalization-index').inventoryFailures(folder)){const job=JSON.parse(fs.readFileSync(path.join(folder,name)));if(job.schema===1&&job.id+'.json'===name)service.schedule(job);}}catch(error){publish('refreshWarning',{stage:'inventory-index',message:clean(error.message)});}},25).unref();}
        }finally{preparingWorkspace=false;}
    }
    function bootstrap({ strict = false, presentationOnly = false, nativeStartup = false } = {}) {
        if (booting||preparingWorkspace||terminating)return;
        if (exchangeActive)
            return;
        if (require('../lib/data-exchange').pending(workspace)){
            workspaceReady=false;stagedHome=null;const bootstrapId=String(++bootstrapGeneration);
            // Accept a trusted directory identity even when the old transaction
            // blocks normal data reads. Settings can then inspect its original pack.
            publish('library',{version:require('../package.json').version,workspace,accounts:[],favorites:[],postFavorites:[],reportKeep:1,bootstrapId,partial:true,homeBlocked:true});
            return exchangeOperation({ action: 'exchangeRecover', requestId: 'recovery' });
        }
        booting=true;
        try {
            if(!presentationOnly||!workspaceReady)prepareWorkspace();
            // Native must accept the workspace before optional local home reads.
            // Strict finalizer refresh and direct callers retain the synchronous contract.
            if(configuration.deferBootstrap && !strict){
                const base=workspace,generation=++bootstrapGeneration,bootstrapId=String(generation);
                const recoverScheduler=(detached=false)=>{
                    if((detached||nativeStartup)&&!follow)try{getFollow();}catch(error){publish('refreshWarning',{stage:'subscription-recovery',message:clean(conciseError(error))});}
                };
                if(configuration.requireNativeWorkspaceAck&&!frontendEpoch){
                    // Native owns the accepted workspace and required recovery,
                    // even while there is no WebKit document to consume a list.
                    // Attach will read current metadata once; it must not replay
                    // a large snapshot which was discarded before ready.
                    stagedHome=null;
                    publish('library',{version:require('../package.json').version,workspace:base,accounts:[],favorites:[],postFavorites:[],reportKeep:1,bootstrapId,partial:true});
                    recoverScheduler(true);
                    localActions.resumeMaintenance(base);
                    return;
                }
                const home=stagedHome={base,generation,subscriptionsPending:true,followRequests:new Map(),avatarJobs:[]};
                const readers=configuration.bootstrapReaders||{},readUsers=readers.users||((b,a,f=[],options)=>require('./user-workspace').home(b,a,f,{...options,avatars:false}));
                const accounts=(readers.accounts||listAccounts)(base,{identityOnly:true}),prefs=library.preferences(base);
                publish('library',{version:require('../package.json').version,workspace:base,accounts,favorites:prefs.favorites,postFavorites:prefs.postFavorites||[],reportKeep:1,bootstrapId,partial:true});
                // Recover the one scheduler inside the native startup writer
                // boundary, independent of slower home reads and the WK page.
                recoverScheduler();
                publish('recoveryState',recoveryState());localActions.resumeMaintenance(base);
                const current=()=>!terminating&&!exchangeActive&&workspace===base&&bootstrapGeneration===generation;
                const notify=(type,data={})=>{if(current())publish(type,{...data,bootstrapId});};
                const section=(name,run)=>()=>{
                    if(!current())return;
                    try{run();notify('libraryState',{section:name,status:'ready'});}
                    catch(error){notify('libraryState',{section:name,status:'error',message:clean(conciseError(error))});notify('refreshWarning',{stage:'home-'+name,message:clean(conciseError(error))});
                        if(name==='subscriptions')for(const requestId of home.followRequests.keys())notify('followError',{requestId,message:clean(conciseError(error))});
                    }finally{
                        if(name==='posts'){
                            const jobs=home.avatarJobs;home.avatarJobs=null;
                            if(current())for(const job of jobs)setImmediate(job);
                        }
                        if(name==='subscriptions'){home.subscriptionsPending=false;home.followRequests.clear();}
                    }
                };
                let users=[];
                const phases=[
                    section('users',()=>{
                        const revision=readingRevision+1;
                        users=readUsers(base,accounts,[]).map(user=>({...user,readingRevision:revision}));
                        notify('homeUsers',{users});
                    }),
                    section('posts',()=>{const posts=(readers.posts||require('./post-workspace').list)(base);notify('postsHome',{posts,authors:require('./post-workspace').authors(base,posts,{avatars:false})});}),
                    section('reports',()=>{const database=(readers.database||require('../lib/database-sync').statuses)(base),reports=(readers.reports||listReports)(base,{database});notify('libraryData',{database,reports});}),
                    section('subscriptions',()=>{const following=(readers.following||(()=>getFollow().snapshot()))();notify('followState',following);
                        // Initial frontend followList and repeated refreshes share this one
                        // snapshot. Reading it synchronously here would undo staged startup.
                        for(const requestId of home.followRequests.keys())notify('followState',{...following,requestId});
                        // Enrich already usable local cards without rescanning their histories.
                        const entries=following.entries.filter(e=>e.targetKind!=='post');
                        if(entries.length){
                            // Rare legacy subscriptions can precede the local user registry.
                            // Only missing owners need their local history projected here.
                            const known=new Set(users.map(u=>u.uid)),byUid=new Map(entries.map(e=>[e.uid,e]));
                            const missing=new Set(entries.filter(f=>!known.has(f.uid)).map(f=>f.uid));
                            const added=missing.size?readUsers(base,accounts,entries,{onlyUids:missing}).filter(u=>missing.has(u.uid)):[];
                            let changed=added.length>0;
                            users=[...users,...added].map(u=>{
                                const f=byUid.get(u.uid);if(!f)return u;
                                const i=f.inbox,notice=require('./task-status').pendingNotice(u.pendingTasks||[],u.directions||[],f);
                                const previousCheck=u.lastCheckAt||u.lastSuccessAt||null;
                                const lastCheckAt=require('./user-workspace').latestCheckAt(previousCheck,f);
                                const visible={hasPending:notice.pending,pendingMessage:notice.message,pendingDetail:notice.detail,...(i?{unread:i.unavailable?null:i.unread||0,unreadUnavailable:!!i.unavailable}:{}),latestInteractionMs:Math.max(u.latestInteractionMs||0,i?.lastSent?.ms||0,i?.lastReceived?.ms||0)||null};
                                if(lastCheckAt!==previousCheck)visible.lastCheckAt=lastCheckAt;
                                changed||=Object.entries(visible).some(([key,value])=>u[key]!==value);
                                return {...u,followEnabled:!!f.enabled,followStatus:f.status||'off',...visible,readingRevision:i?readingRevision+1:u.readingRevision};
                            });
                            if(changed)notify('homeUsers',{users});
                        }
                    })
                ];
                const schedule=configuration.scheduleBootstrap||setImmediate;
                const next=()=>{if(!current())return;const phase=phases.shift();if(!phase)return;phase();if(current()&&phases.length)schedule(next);};
                // Let the native document paint the already clickable identity
                // list before the first synchronous optional data phase.
                if(configuration.requireNativeWorkspaceAck&&!configuration.scheduleBootstrap)setTimeout(next,32).unref();
                else schedule(next);
                return;
            }
            ++bootstrapGeneration;stagedHome=null;
            let following={entries:[]};
            try{following=getFollow().snapshot();}catch(error){publish('refreshWarning',{stage:'subscription-recovery',message:clean(error.message)});}
            const accounts=listAccounts(workspace),prefs=library.preferences(workspace),database=require('../lib/database-sync').statuses(workspace);
            localActions.resumeMaintenance(workspace);
            publish('library', { version: require('../package.json').version, workspace, accounts, reports: listReports(workspace,{database}), favorites:prefs.favorites, reportKeep: 1, postFavorites:prefs.postFavorites || [], database });
            publish('recoveryState', recoveryState());
            publish('followState', following);
            publish('homeUsers', { users: require('./user-workspace').home(workspace, accounts, following.entries.filter(e => e.targetKind !== 'post'),{avatars:false}) });
            const posts = require('./post-workspace').list(workspace);
            publish('postsHome', { posts, authors: require('./post-workspace').authors(workspace, posts,{avatars:false}) });
        }
        catch (error) {
            if (strict)
                throw error;
            publish('libraryState',{section:'all',status:'error',message:clean(error.message)});
            publish('refreshWarning', { message: clean(error.message), stage: 'home-refresh' });
        }finally{booting=false;}
    }
    function recoveryState() {
        const saved=getFinalizer().recoveryState();
        return {...saved,blocked:saved.blocked||gapChoiceIssues.length>0,issues:[...(saved.issues||[]),...gapChoiceIssues.map(e=>({file:e.file,target:e.uid||'',targetKind:'user',failures:[{stage:'忽略区间的本地恢复',message:e.message,critical:true}]}))]};
    }
    function requireRecovered(query) {
        const mode=typeof query?.mode==='string'?/^comments-(sent|received|both)$/.exec(query.mode)?.[1]:null;
        const gapBlocked=!query?gapChoiceIssues.length>0:mode&&require('./gap-choice').blockedKinds(gapChoiceIssues,{uid:require('./ui/form-utils').uid(query.target),mode,source:query.source}).length;
        if(gapBlocked){publish('recoveryState',recoveryState());throw Error('忽略区间的本地操作尚待恢复；请重试本地恢复。未发起取数。');}
        const issues=getFinalizer().blockedFor(query);
        if(!issues.length)return;
        publish('recoveryState',recoveryState());
        const first=issues[0],reason=first.failures.filter(f=>f.critical).map(f=>f.stage+'：'+f.message).join('；');
        throw Object.assign(Error('此范围的上次收尾尚待恢复，未发起取数。本地查看和导出仍可用。'+first.file+' · '+reason),{code:'LOCAL_RECOVERY_PENDING'});
    }
    function followRecoveryQuery(settings){
        return settings?.targetKind==='post'?{mode:'post-comments',target:settings.postId||settings.uid,source:settings.source}:{mode:'comments-'+(settings?.mode||'both'),target:settings?.uid};
    }
    let accountGeneration = 0;
    function accountFailure(base,requestId,error,generation=accountGeneration) {
        const authenticationNeeded = /缺少登录令牌|MISSING_TOKEN|AUTH_REQUIRED|UNAUTHORIZED|invalid_grant/i.test(error.message);
        const result = { ok: false, code:require('../lib/diagnostic-codes').safe(error.code), authenticationNeeded, message: authenticationNeeded ? '请先在应用内登录 / 授权' : clean(conciseError(error)), checkedAt: Date.now() };
        if (workspace === base && generation === accountGeneration) accountState = result;
        scopedPublish(base)('accountError', { ...result, ...(requestId ? { requestId } : {}) });
        return result;
    }
    function lookupAccount(requestId) {
        const base = workspace, generation = accountGeneration, notify = scopedPublish(base), context = requestId ? { requestId } : {};
        if (accountTask) {
            if (accountTask.workspace === base && accountTask.generation === generation && (!requestId || accountTask.requestId === requestId)) return accountTask.promise;
            // A new directory/request waits for the old free query; its response
            // keeps its original owner and is never relabeled as the new query.
            return accountTask.promise.then(() => workspace === base && generation === accountGeneration && !terminating ? lookupAccount(requestId) : { ok: false, cancelled: true });
        }
        let resolve;
        const promise = new Promise(done => resolve = done);
        const child = spawnChild(process.execPath, [cli, 'me', '--output', 'json'], { cwd: ENGINE, env: env(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const request = { child, promise, workspace: base, generation, requestId };
        accountTask = request;
        notify('accountLoading', { ...context, pid: child.pid });
        let output = '', errors = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', d => { if (output.length < 1024 * 1024)
            output += d; });
        child.stderr.on('data', d => { if (errors.length < 8192)
            errors += d; });
        child.on('error', error => { errors = error.message; });
        const timer = setTimeout(() => { try {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch { } }, 12000);
        child.on('close', code => {
            clearTimeout(timer);
            if (accountTask === request)
                accountTask = null;
            let result;
            try {
                if (code !== 0)
                    throw Error(errors || '余额查询超时或失败');
                const data = JSON.parse(output), value = data.user?.balance;
                result = { ok: true, username: data.user?.username || data.user?.name || '', balance: value != null && Number.isFinite(Number(value)) ? Number(value) : null, service: data.service_status?.kind || '', checkedAt: Date.now() };
                if (workspace === base && generation === accountGeneration) accountState = result;
                notify('account', { ...result, ...context });
            }
            catch (error) {
                result = accountFailure(base,requestId,error,generation);
            }
            notify('accountLoading', { ...context, loading: false });
            notify('finished', { ...context, kind: 'account', code, background: true });
            resolve(result);
            if (terminating && !active && !exchangePromise)
                process.exit(0);
        });
        return promise;
    }
    function recordPreparation(job, reason) { if (!job.query?.syncOnly || job.query.preview)
        return; try {
        const {o,dir} = require('./task-data').taskData(workspace,job.query), ledger = require('../lib/database-sync');
        ledger.writeHistory(dir, { schema: 1, id: job.id, target: o.postId || o.uid, uid: o.uid, mode: o.mode, startedAt: job.startedAt, finishedAt: new Date().toISOString(), status: reason.startsWith('登录') ? 'failed' : 'cancelled', records: 0, addedRecords: 0, apiCalls: 0, cachedCalls: 0, billing: ledger.billingRecord(null, 0), reason });
    }
    catch { } }
    function stop() {
        if (preparing && !active) {
            const job = preparing;
            job.cancelled = true;
            preparing = null;
            recordPreparation(job, '准备阶段已取消；未发起内容取数请求。');
            publish('finished', { id: job.id, taskId: job.id, requestId: job.requestId, kind: job.kind || 'collect', cancelled: true, preparation: true, code: null, reports: [] });
            return;
        }
        if (!active)
            return;
        if (active.cancelled)
            return;
        if (active.cancelFile) {
            fs.mkdirSync(path.dirname(active.cancelFile), { recursive: true });
            require('../lib/update-progress').atomic(active.cancelFile, { reason: '由用户停止，保存当前响应后结束' });
            active.cancelled = true;
            if(active.manualIdentity)active.child.stdin.end();
            publish('stopping', { taskId: active.id, requestId: active.requestId });
            // The wire has its own finite timeout. A returned response and its
            // durable progress must finish even when disk saving takes longer.
            // Repeated Stop / Quit must never signal a cooperating writer.
            return;
        }
        active.cancelled = true;
        publish('stopping', { taskId: active.id, requestId: active.requestId });
        try {
            process.kill(-active.child.pid, 'SIGINT');
        }
        catch { }
        const pid = active.child.pid;
        active.timers.push(setTimeout(() => { if (active?.child.pid === pid)
            try {
                process.kill(-pid, 'SIGTERM');
            }
            catch { } }, 2000), setTimeout(() => { if (active?.child.pid === pid)
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch { } }, 5000));
    }
    function launch(kind, args, query, preparation = null) {
        if (active)
            throw Error('请先等待或停止当前任务');
        if (!fs.existsSync(workspace))
            fs.mkdirSync(workspace, { recursive: true });
        const cancelFile = query?.syncOnly ? (preparation?.automatic ? require('../lib/auto-follow-budget').roundFile(workspace, preparation.id) + '.stop' : path.join(require('../lib/data-layout').readerRoot(workspace), 'task-control', (preparation?.id || crypto.randomUUID()) + '.stop')) : null;
        const job = { workspace, cancelFile, id: preparation?.id || crypto.randomUUID(), kind, automatic: !!preparation?.automatic, cancelled: false, timers: [], reports: [], result: null, credits: null, startedAt: new Date().toISOString(), query: query ? Object.freeze(JSON.parse(JSON.stringify(query))) : null, requestId: preparation?.requestId, preview: !!query?.preview };
        require('./user-workspace').begin(workspace, job);
        let child;
        try {
            if(job.automatic)getFollow().prepareWorker?.(job.id);
            child = spawnChild(process.execPath, args, { cwd: workspace, env: { ...env(), WEIBO_AUTO_ROUND_ID:preparation?.automatic?preparation.id:'', ...(cancelFile ? { WEIBO_CANCEL_FILE: cancelFile, WEIBO_DATA_SCOPE: query._scopeId || '', WEIBO_RESUME_SCOPE: query._resumeTaskId || '',
                WEIBO_GAP_BUDGET: query._gapBudget ? JSON.stringify({limit:query._gapBudget,kinds:query._gapKinds}) : '' } : {}) }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        }
        catch (error) {
            job.safety = { message: clean(error.message) };
            getFinalizer().finalize(job, { code: 1 });
            return;
        }
        job.child = child;
        active = job;
        if(job.automatic&&getFollow().bindWorker)try{job.workerBinding=getFollow().bindWorker(job.id,{schema:1,pid:child.pid,pgid:child.pid,birth:require('../lib/process-lease').processBirth(child.pid),startedAt:job.startedAt});}catch(error){job.safety={code:error.code||'AUTO_WORKER_BINDING',message:clean(error.message)};job.workerBindingFailed=true;try{child.kill('SIGTERM');}catch{}job.timers.push(setTimeout(()=>{if(active===job&&!job.finalized)try{child.kill('SIGKILL');}catch{}},3000));}
        publish('started', { id: job.id, pid: child.pid, kind, query: job.query, taskId: job.id, requestId: job.requestId, automatic: job.automatic });
        lineStream(child.stdout, line => { if(kind==='logout')return; const message = clean(line); if (message.trim())
            publish('log', { message, level: 'info', automatic: job.automatic, taskId: job.id, requestId: job.requestId }); });
        lineStream(child.stderr, line => { if(kind==='logout'){if(line.includes('Cleared local credentials, but remote session revocation could not be confirmed.'))job.logoutLocalCleared=true;return;} const message = clean(line); if (message.trim())
            publish('log', { message, level: 'error', automatic: job.automatic, taskId: job.id, requestId: job.requestId }); });
        lineStream(child.stdio[3], line => {
            try {
                if (job.finalized)
                    return;
                const event = JSON.parse(line);
                if (!['progress', 'collection', 'phase', 'plan', 'credits', 'report', 'summary', 'target', 'source', 'autoSafety'].includes(event.type))
                    return;
                if (event.type === 'report') {
                    const root = path.resolve(workspace, 'output'), file = path.resolve(event.file || '');
                    if (!file.startsWith(root + path.sep))
                        return;
                    event.id = path.relative(root, file);
                    delete event.file;
                    job.reports.push(event.id);
                }
                if (event.type === 'source')
                    event.dataStatus = require('../lib/collection-result').collectionResult(event);
                if (event.type === 'summary')
                    job.result = event;
                if (event.type === 'credits')
                    job.credits = event;
                if (event.type === 'autoSafety')
                    job.safety = event;
                if (job.finalized)
                    return;
                send({ ...event, workspace, taskId: job.id, requestId: job.requestId, automatic: job.automatic });
            }
            catch(error) {
                job.safety={code:'ENGINE_EVENT_INVALID',message:'任务事件格式异常；已停止后续请求，原始数据与恢复证据保留'};
                publish('error',{...job.safety,taskId:job.id,requestId:job.requestId,automatic:job.automatic});stop();
            }
        },{limit:4*1024*1024,onOverflow:()=>{
            job.safety={code:'ENGINE_EVENT_LIMIT',message:'任务事件超过安全长度；已停止后续请求，原始数据与恢复证据保留'};
            publish('error',{...job.safety,taskId:job.id,requestId:job.requestId,automatic:job.automatic});stop();
        }});
        child.on('error', error => { job.safety = { message: clean(error.message) }; publish('error', { message: clean(error.message), automatic: job.automatic, taskId: job.id, requestId: job.requestId }); });
        child.on('close', (code, signal) => {
            if (job.finalized)
                return;
            if(kind==='logout'){
                const localCleared=code===0&&!signal||job.logoutLocalCleared===true;
                if(localCleared){accountGeneration+=1;accountState={ok:false,authenticationNeeded:true,message:'已退出登录',checkedAt:Date.now()};}
                scopedPublish(job.workspace)('serviceLogoutResult',{taskId:job.id,requestId:job.requestId,localCleared,remoteConfirmed:code===0&&!signal});
            }
            if(job.workerBinding)try{getFollow().workerClosed(job.id,job.workerBinding);}catch(error){job.safety={code:error.code||'AUTO_WORKER_BINDING',message:clean(error.message)};code=1;}
            if(job.workerBindingFailed)code=1;
            job.exitSignal = signal;
            getFinalizer().finalize(job, { code, signal });
            publish('recoveryState', recoveryState());
            if (terminating) {
                try {
                    follow?.release();
                }
                finally {
                    process.exit(0);
                }
            }
            drainForeground();
        });
    }
    function getFinalizer() {
        return finalizer ??= require('./task-finalizer').createFinalizer(workspace, {
            recoveryWarning: warning => publish('recoveryDiagnostic',{...warning,message:clean(warning.message)}),
            taskRecord: (job, code) => (configuration.taskRecord || require('./user-workspace').finish)(workspace, job, code),
            billingHistory: job => require('./task-derived-repair').recordIncompleteHistory(job.workspace || workspace, job),
            settle: (job, code, { recovery = false } = {}) => (recovery ? getFollow().recoverSettlement.bind(getFollow()) : getFollow().finish.bind(getFollow()))(job.id, { summary: job.result, code, cancelled: job.cancelled, reason: job.safety?.message || '', failureCode:job.safety?.code||'', failureRetryAt:job.safety?.retryAt, startedAt: job.startedAt }),
            repairDerived: job => require('./task-derived-repair').repairDerived(workspace, job,{scheduleInventory:j=>getInventoryRepairs().schedule(j)}),
            criticalFailure: (job, failures) => job.query?.target ? getFollow().holdFinalization(job.id, failures.map(e => e.stage + '：' + e.message).join('；'), { uid: job.query.mode === 'post-comments' ? require('./ui/form-utils').postId(job.query.target) : targetUid(job.query.target), targetKind: job.query.mode === 'post-comments' ? 'post' : 'user' }) : (() => { getFollow().close(); return { held: true, coreFailed: true, message: '任务身份无法核实，已停止自动请求；原始证据保留' }; })(),
            release(job) { for (const timer of job.timers || [])
                clearTimeout(timer); job.timers = []; if (active === job)
                active = null; if (job.cancelFile && fs.existsSync(job.cancelFile))
                fs.unlinkSync(job.cancelFile); },
            observe(job) { if (job.kind === 'collect' && job.result?.syncOnly)
                if(job.workspace===workspace)return getFollow().observe(job.result,{workspace:job.workspace,id:job.id,requestId:job.requestId,query:job.query,automatic:job.automatic,preview:job.preview,startedAt:job.startedAt}); },
            cleanup(job) { if (job.kind === 'collect' && job.reports?.length && !job.preview) {
                const value = (configuration.cleanup || library.cleanupOwnerReports)(workspace, job.reports);
                publish('cleanup', { ...value, taskId: job.id });
            } },
            // Runtime home reads already have a staged, generation-bound owner.
            // Critical task/body/fee commits stay synchronous; rebuilding every
            // home section must not delay the actual completion acknowledgment.
            refresh: () => configuration.refresh ? configuration.refresh() : bootstrap({ strict: !configuration.deferBootstrap }),
            finished: value => publish('finished', value)
        });
    }
    async function exchangeOperation(message) {
        if (exchangeActive)
            throw Error('数据包正在处理，请等待完成');
        const base = workspace, requestId = message.requestId;
        const notify = scopedPublish(base), operation = message.action;
        const progress = phase => notify('exchangeProgress', { requestId, phase });
        exchangeController=new AbortController();const signal=exchangeController.signal;
        exchangeActive = true;
        notify('exchangeBusy', { busy: true, requestId });
        if (active || preparing || profileBatch) progress('waiting');
        const task = (async () => {
            while (active || preparing || profileBatch) {
                if (terminating)
                    throw Error('已取消等待，原有数据保持不变');
                if (active?.automatic)
                    getFollow().interrupt('数据交换等待当前响应保存',{code:'AUTO_YIELD'});
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (terminating)
                return;
            const service = require('../lib/data-exchange');
            const presentation = require('./exchange-presentation');
            let type, result;
            if (operation === 'exchangeRecover') {
                const recovered = await service.recover(base, { signal });
                type = 'exchangeRecovered';
                result = { recovered: recovered.length, credits: 0 };
            } else if (operation === 'exchangeExport') {
                progress('exporting');
                const exported = await service.exportPackage(base, message.selection, message.path, { signal });
                type = 'exchangeExported';
                result = { file: exported.file, warningCount: exported.warnings.length, credits: 0 };
            } else if (operation === 'exchangeInspect') {
                progress('checking');
                type = 'exchangeInspected';
                result = presentation.preview(await service.inspect(base, message.path, { signal, onPhase: progress }));
            } else {
                progress('preparingMerge');
                type = 'exchangeImported';
                result = presentation.imported(await service.commit(base, message.id, { signal, onPhase: progress }));
            }
            localActions.invalidate();
            notify(type, { ...result, requestId });
        })();
        exchangePromise = task;
        try {
            await task;
        }
        catch (error) {
            if(message.action==='exchangeRecover'){publish('libraryState',{section:'all',status:'error',message:'旧数据合并尚待本地恢复；可在设置中重新检查原数据包。'});publish('refreshWarning',{stage:'exchange-recovery',message:clean(error.message)});}
            notify('exchangeError', { operation, code:require('../lib/diagnostic-codes').safe(error.code), message: clean(error.message), requestId, recoveryNeeded: require('../lib/data-exchange').pending(base) });
        }
        finally {
            exchangeActive = false;
            exchangePromise = null;exchangeController=null;
            notify('exchangeBusy', { busy: false, requestId });
            if (terminating) {
                if (!active) {
                    follow?.release();
                    process.exit(0);
                }
            }
            else if (!require('../lib/data-exchange').pending(base))
                bootstrap();
        }
    }
    async function handle(message, dispatch = null, approvedResume = false) {
        let release, deferred=false;
        if(!message||typeof message!=='object'||Array.isArray(message)||typeof message.action!=='string'){publish('error',{message:'请求格式无效'});return;}
        const requestWorkspace = typeof message.workspace === 'string' ? message.workspace : workspace;
        const startupRequest=configuration.requireNativeWorkspaceAck&&message.action==='bootstrap'&&typeof message.requestId==='string'&&/^native-startup:[a-f0-9-]{36}$/i.test(message.requestId);
        if(message.action==='nativeWorkspaceAccepted'){
            if(configuration.requireNativeWorkspaceAck&&nativeLibraryExpected?.workspace===workspace&&message.workspace===workspace&&message.bootstrapId===nativeLibraryExpected.bootstrapId)nativeLibraryAccepted={...nativeLibraryExpected};
            return;
        }
        try {
            if(['reportOpened','reportHandoff'].includes(message.action)){const access=reportAccesses.get(requestWorkspace);if(!access)return;const unlock=require('../lib/workspace-access').enter(requestWorkspace,'writer');try{if(message.action==='reportHandoff'){const settled=access.handedOff(message.token,message.success===true);if(settled){if(settled.result)scopedPublish(requestWorkspace)('reportMarkedRead',settled.result);localActions.deferMaintenance(requestWorkspace,[settled.id]);}}else{const result=access.opened(message.token);if(result)scopedPublish(requestWorkspace)('reportMarkedRead',result);}}finally{unlock();}return;}
            if (message.workspace && require('../lib/data-layout').canonical(message.workspace) !== require('../lib/data-layout').canonical(workspace))
                throw Error('资料目录已改变，请在当前目录重新执行操作');
            if(message.action==='frontendAttach'){
                const epoch=message.documentEpoch;
                if(!configuration.requireNativeWorkspaceAck||!Number.isSafeInteger(epoch)||epoch<=frontendEpoch||terminating)return;
                frontendEpoch=epoch;
                // The native-owned engine has already recovered and scheduled
                // this workspace. Refresh only presentation for its one late UI.
                bootstrap({presentationOnly:true});
                const task=active?.workspace===workspace?active:null;
                publish('frontendState',{
                    documentEpoch:epoch,
                    active:task?{type:'started',workspace,id:task.id,pid:task.child.pid,kind:task.kind,query:task.query,taskId:task.id,requestId:task.requestId,automatic:task.automatic}:null,
                    preparing:!task&&preparing?.query?{type:'preparing',workspace,id:preparing.id,taskId:preparing.id,requestId:preparing.requestId,query:preparing.query,automatic:!!preparing.automatic}:null,
                    credits:task?.credits?{...task.credits,type:'credits',workspace,taskId:task.id,requestId:task.requestId,automatic:task.automatic}:null
                });return;
            }
            if(message.action==='run')buildArguments(message.query||{});
            if(dispatch!==queuedDispatch&&needsForeground(message)&&((active||preparing)?.automatic||manualQueue||foregroundDispatching||queuedRequests.has(message.requestId))){deferred=queueForeground(message);return;}
            if(['globalSearch','searchPage','searchOpen','coverageTimeline','insightsCancel','searchObjects'].includes(message.action)){
                const base=workspace,notify=scopedPublish(base),requestId=message.requestId;
                if(message.action==='insightsCancel'){if(message.scope===undefined||['search','timeline'].includes(message.scope))insights?.cancel(message.scope);return;}
                if(require('../lib/data-exchange').pending(base)||exchangeActive)throw Error('数据包正在合并，请完成后重试本地查询');
                release=require('../lib/workspace-access').enter(base,'writer');
                if(message.action==='searchObjects'){const objects=require('../lib/local-corpus').objects(base).objects.map(({key,id,category,label,note})=>({key,id,category,label:String(label).slice(0,100),note:String(note).slice(0,200)}));if(Buffer.byteLength(JSON.stringify(objects))>2*1024*1024)throw Error('所属对象列表过大；仍可使用关键词、日期和作者搜索全部内容');notify('searchObjects',{requestId,objects});return;}
                const service=getInsights(),action={globalSearch:'search',searchPage:'page',searchOpen:'resolve',coverageTimeline:'timeline'}[message.action];
                const value=await service.request(action,message.query||{}, {snapshot:message.snapshot,page:message.page,key:message.key,owner:message.owner,progress:p=>notify('insightsProgress',{requestId,action:message.action,...p})});
                if(base!==workspace||terminating)return;
                if(message.action==='searchOpen'){
                    const unlock=require('../lib/workspace-access').enter(base,'writer');try{
                        let result,opening;require('../lib/report-lifecycle').locked(base,()=>{const local=localActions.service();result=local.exportConversation(value.input,value.selection);if(result.files[0])opening=getReportAccess().open(result.files[0],'report');});
                        notify('searchOpened',{requestId,...result,warning:''});
                        if(opening)notify('open',opening);
                        localActions.deferMaintenance(base,result.files);
                    }finally{unlock();}
                }else notify(message.action==='coverageTimeline'?'coverageTimeline':'globalSearch',{requestId,...value});
                return;
            }
            if (message.action?.startsWith('exchange')) {
                if (message.action === 'exchangeDiscard') {
                    if (exchangeActive)
                        throw Error('数据包正在处理，请完成后重试');
                    require('../lib/data-exchange').discard(workspace, message.id);
                    scopedPublish(workspace)('exchangeDiscarded', { requestId: message.requestId });
                    return;
                }
                if (message.action === 'exchangeObjects') {
                    if (exchangeActive)
                        throw Error('数据包正在处理');
                    publish('exchangeObjects', { objects: require('../lib/data-exchange').objects(workspace), requestId: message.requestId, workspace });
                    return;
                }
                if (!['exchangeExport', 'exchangeInspect', 'exchangeCommit'].includes(message.action))
                    throw Error('不支持的数据包操作');
                return await exchangeOperation(message);
            }
            if (exchangeActive && !['stop', 'shutdown'].includes(message.action))
                throw Error('数据包正在安全处理，请完成后再操作');
            if(message.action==='run')buildArguments(message.query||{});
            if(!workspaceReady&&!['bootstrap','library','workspace','stop','shutdown'].includes(message.action))prepareWorkspace();
            if (!['bootstrap', 'library', 'workspace', 'stop', 'shutdown', 'account', 'pricingReference', 'resumeTaskPreview', 'output', 'open'].includes(message.action))
                release = require('../lib/workspace-access').enter(workspace,['userDeleteConfirm','manageDeleteConfirm','taskGapIgnore','taskFuturePreview','taskFutureChoose','recoveryRetry'].includes(message.action)?'exclusive':'writer');
            if (require('../lib/data-exchange').pending(workspace) && !['stop', 'shutdown', 'bootstrap', 'library'].includes(message.action))
                throw Error('数据合并尚未恢复，请重新打开软件完成恢复');
            switch (message.action) {
                case 'recoveryRetry':
                    if(active||preparing||pendingForeground()||profileBatch)throw Error('请等待当前数据安全保存后重试本地恢复');
                    workspaceReady=false;
                    try{getFinalizer().recover();recoveredFinalization=true;recoverGapChoices(workspace,true);}finally{workspaceReady=true;}
                    release?.();release=null;bootstrap();
                    publish('recoveryState',{...recoveryState(),requestId:message.requestId});
                    break;
                case 'bootstrap':
                    await bootstrap({nativeStartup:startupRequest});
                    break;
                case 'library':
                    bootstrap();
                    break;
                case 'workspace':
                    localActions.close();
                    if (active || preparing || pendingForeground() || profileBatch)
                        throw Error('采集期间不能更换资料目录');
                    if (typeof message.path !== 'string' || !path.isAbsolute(message.path))
                        throw Error('资料目录必须是绝对路径');
                    insights?.close();insights=null;insightsBase=null;inventoryRepairs?.close();inventoryRepairs=null;inventoryBase=null;inventoryRecovered=false;
                    follow?.close();
                    follow?.release();
                    follow = null;
                    localActions.invalidate();
                    profiles?.close();
                    profiles = null;
                    deletions = null;
                    bulk = null;
                    priceReference?.close();
                    priceReference = null;
                    workspace = path.resolve(message.path);
                    accountGeneration += 1; accountState = null;
                    reportAccess = null;
                    finalizer = null;
                    recoveredFinalization = false;workspaceReady=false;gapChoiceIssues=[];nativeLibraryExpected=null;nativeLibraryAccepted=null;
                    bootstrap();
                    break;
                case 'manageDeletePlan':
                    publish('manageDeletePlan', { ...getBulk().plan(message.targets), requestId: message.requestId });
                    break;
                case 'manageDeleteConfirm': {
                    const result = getBulk().confirm(message.token);
                    localActions.invalidate();
                    for (const t of result.targets)
                        publish(t.targetKind === 'post' ? 'postDeleted' : 'userDeleted', { uid: t.id, postId: t.id, records: result.records });
                    publish('manageDone', { ...result, operation: 'delete' });
                    bootstrap();
                    break;
                }
                case 'manageBatch': {
                    const list = require('./bulk-management').targets(message.targets), op = message.operation;
                    if (!['favorite', 'unfavorite', 'pause', 'subscribe'].includes(op))
                        throw Error('批量操作无效');
                    const settings = list.map(t => ({ ...message.settings, targetKind: t.targetKind, uid: t.id, ...(t.targetKind === 'post' ? { postId: t.id, mode: 'post-comments' } : {}), enabled: true }));
                    if (op === 'subscribe') {
                        for(const value of settings)requireRecovered(followRecoveryQuery(value));
                        for (const value of settings)
                            require('./auto-follow').validate(value);
                        if (active || preparing)
                            throw Error('请先等待当前数据任务结束再开启订阅');
                    }
                    for (let i = 0; i < list.length; i++) {
                        const t = list[i];
                        if (op === 'favorite' || op === 'unfavorite') {
                            if (t.targetKind === 'post')
                                require('./post-workspace').favorite(workspace, t.id, op === 'favorite');
                            else
                                library.favorite(workspace, t.id, op === 'favorite');
                        }
                        else if (op === 'pause') {
                            const e = getFollow().snapshot().entries.find(e => require('../lib/subscription-key').matches(e, t.targetKind + ':' + t.id));
                            if (e)
                                getFollow().pause(t.targetKind + ':' + t.id);
                        }
                        else
                            getFollow().save(settings[i], 'enable');
                    }
                    publish('manageDone', { operation: op, targets: list, message: '已处理 ' + list.length + ' 个对象', requestId: message.requestId });
                    bootstrap();
                    break;
                }
                case 'profilesRefresh': {
                    if (profileBatch)
                        throw Error('已有资料更新正在进行');
                    if (active || preparing || deleting())
                        throw Error('请先等待当前任务结束再更新资料');
                    for(const uid of message.uids||[])requireRecovered({mode:'comments-both',target:uid});
                    const uids = [...new Set((message.uids || []).map(targetUid))], known = new Set(listAccounts(workspace).map(u => u.uid));
                    if (!uids.length || uids.some(uid => !known.has(uid)))
                        throw Error('请选择已保存的用户');
                    profileBatch = true;
                    let completed = 0, failed = 0, stopped = false;
                    publish('profilesProgress', { requestId: message.requestId, completed, total: uids.length, failed, finished: false });
                    try {
                        for (const uid of uids) {
                            if (terminating) {
                                stopped = true;
                                break;
                            }
                            const p = await getProfiles().ensure(uid, { refresh: true });
                            completed++;
                            if (p?.status === 'error' || ['error','unavailable'].includes(p?.avatarStatus))
                                failed++;
                            publish('profilesProgress', { requestId: message.requestId, completed, total: uids.length, failed, finished: false });
                            if (!p || p.billing?.status === 'unknown' || p.status === 'error') {
                                stopped = true;
                                break;
                            }
                        }
                    }
                    finally {
                        profileBatch = false;
                        publish('profilesProgress', { requestId: message.requestId, completed, total: uids.length, failed, stopped, finished: true });
                        bootstrap();
                    }
                    break;
                }
                case 'userNoteSave': {
                    if (deleting())
                        throw Error('删除尚未完成，暂不能修改备注');
                    const value = require('./notes').save(workspace, 'user', message.uid, message.note);
                    publish('userNoteSaved', { ...value, requestId: message.requestId });
                    publish('homeUsers', { users: require('./user-workspace').home(workspace, listAccounts(workspace), follow?.snapshot().entries.filter(e => e.targetKind !== 'post') || []) });
                    break;
                }
                case 'postNoteSave': {
                    if (deleting())
                        throw Error('删除尚未完成，暂不能修改备注');
                    const value = require('./notes').save(workspace, 'post', message.postId, message.note);
                    publish('postNoteSaved', { ...value, requestId: message.requestId });
                    const posts = require('./post-workspace').list(workspace);
                    publish('postsHome', { posts, authors: require('./post-workspace').authors(workspace, posts,{avatars:false}) });
                    break;
                }
                case 'postAdd': {
                    const postId = require('./post-workspace').add(workspace, message.target);
                    bootstrap();
                    publish('postAdded', { postId });
                    break;
                }
                case 'postFavorite':
                    require('./post-workspace').favorite(workspace, String(message.postId), message.on === true);
                    bootstrap();
                    break;
                case 'userAdd': {
                    if (deleting())
                        throw Error('删除尚未完成，暂不能添加用户');
                    const uid = targetUid(message.uid);
                    require('./user-workspace').add(workspace, uid, message.nickname);
                    bootstrap();
                    publish('userAdded', { uid, requestId: message.requestId });
                    requireRecovered({mode:'comments-both',target:uid});
                    await getProfiles().ensure(uid);
                    break;
                }
                case 'userDeletePlan':
                    publish('userDeletePlan', { ...getDeletions().plan(targetUid(message.uid)), requestId: message.requestId });
                    break;
                case 'userDeleteConfirm': {
                    const result = getDeletions().confirm(targetUid(message.uid), message.token);
                    localActions.invalidate();
                    publish('userDeleted', { ...result, operation: 'userDeleteConfirm', requestId: message.requestId });
                    bootstrap();
                    break;
                }
                case 'userProfileRetry':
                    requireRecovered({mode:'comments-both',target:message.uid});
                    await getProfiles().ensure(targetUid(message.uid), { retry: true });
                    break;
                case 'postAuthorAvatar': {
                    const postId=message.postId,uid=message.authorUid,requestId=message.requestId;
                    if(typeof postId!=='string'||!/^[0-9]{5,20}$/.test(postId)||typeof uid!=='string'||!/^[0-9]{5,20}$/.test(uid)||typeof requestId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId))throw Error('博文头像请求缺少可核对的身份');
                    if(profileBatch||active||preparing||terminating||deleting())throw Error('请等待当前任务安全保存后再更新头像');
                    requireRecovered({mode:'post-comments',target:postId});
                    profileBatch=true;
                    try{
                        const result=await getProfiles().ensurePostAuthor(postId,{expectedUid:uid,allowPaidLookup:message.allowPaidLookup===true});
                        if(result?.uid!==uid)throw Error('博文作者身份已变化，未更新头像');
                        const {view}=require('./user-profiles'),avatar=view(requestWorkspace,uid);
                        const updated=!!avatar.avatarData;
                        scopedPublish(requestWorkspace)('postAuthorAvatarResult',{requestId,postId,authorUid:uid,updated,code:updated?'NONE':avatar.code,message:updated?'作者头像已载入':avatar.profileMessage||'暂未取得作者头像'});
                    }finally{profileBatch=false;}
                    break;
                }
                case 'taskGapIgnore': {
                    if(active||preparing||pendingForeground()||profileBatch)throw Error('请等待当前任务安全保存后再关闭这段提示');
                    const uid=targetUid(message.uid);requireRecovered({mode:'comments-both',target:uid});
                    let result;try{result=require('./gap-choice').choose(workspace,{uid,id:message.id,expected:message.expected});}catch(error){gapChoiceIssues=require('./gap-choice').issues(workspace,clean(error.message));throw error;}
                    localActions.invalidate();publish('taskGapIgnored',{...result,taskId:message.id,requestId:message.requestId});
                    // Release the exclusive lease before bootstrap reads/recovery.
                    release?.();release=null;bootstrap();break;
                }
                case 'taskFuturePreview':
                case 'taskFutureChoose': {
                    if(active||preparing||pendingForeground()||profileBatch||terminating||deleting())throw Error('请等待当前任务安全保存后再核对后续检查起点');
                    const uid=targetUid(message.uid),kind=message.kind,base=workspace,notify=scopedPublish(base);
                    if(!['sent','received'].includes(kind))throw Error('请选择发出评论或收到评论方向');
                    requireRecovered({mode:'comments-'+kind,target:uid});
                    const G=require('./gap-choice');
                    if(message.action==='taskFuturePreview'){
                        if(!message.taskId)notify('taskFutureCandidates',{...G.futureCandidates(base,{uid,kind,limit:20}),source:'cli',targetKind:'user',requestId:message.requestId});
                        else notify('taskFuturePreview',{...G.previewFuture(base,{uid,kind,taskId:message.taskId,...(message.responseHash?{responseHash:message.responseHash}:{})}),requestId:message.requestId});
                    }else{
                        let result;try{result=G.chooseFuture(base,{uid,kind,taskId:message.taskId,expected:message.expected,confirmation:message.confirmation});}catch(error){gapChoiceIssues=G.issues(base,clean(error.message));throw error;}
                        localActions.invalidate();notify('taskFutureChosen',{...result,source:'cli',targetKind:'user',taskId:message.taskId,requestId:message.requestId});
                        release?.();release=null;bootstrap();
                    }
                    break;
                }
                case 'taskNoticeDismiss':
                    publish('taskNoticeDismissed',{...require('./user-workspace').dismissNotice(workspace,{uid:targetUid(message.uid),id:message.id,expected:message.expected}),requestId:message.requestId});
                    break;
                case 'userProfileDismiss':
                    getProfiles().dismiss(targetUid(message.uid), message.noticeId);
                    break;
                case 'userViewed':
                    if (listAccounts(workspace).some(u => u.uid === targetUid(message.uid)))
                        require('./user-workspace').viewed(workspace, targetUid(message.uid), message.metadata || {});
                    break;
                case 'resumeTaskPreview': {
                    publish('resumeTaskPreview',{...require('./user-workspace').resume(workspace,message.id,{inspect:true}),id:message.id,requestId:message.requestId});
                    break;
                }
                case 'resumeTask': {
                    const query = require('./user-workspace').resume(workspace,message.id,{budget:message.returnBudget});
                    if (query.syncOperation === 'quick' && require('./user-workspace').alreadyConnected(workspace, message.id)) {
                        publish('taskAlreadyConnected', { id: message.id, requestId: message.requestId, uid: targetUid(query.target) });
                        bootstrap();
                        break;
                    }
                    return handle({ action: 'run', query, requestId: message.requestId, workspace: requestWorkspace }, dispatch, true);
                }
                case 'localInventory':
                case 'localData':
                case 'localExport':
                    await localActions.handle(message);
                    break;
                case 'updateHistory': {
                    const o = options(buildArguments({ mode: message.mode, target: message.target, policy: 'database', unlimited: true })), paths = require('../lib/storage').storagePaths(workspace), root = o.mode === 'user-posts' ? paths.posts : o.mode === 'post-comments' ? paths.postComments : paths.users, dir = o.postId ? require('../lib/storage').findPostFolder(root, o.postId) : require('../lib/storage').mappedFolder(root, o.uid, require('../lib/storage').indexRead(root));
                    const rounds=new Map(),budget=require('../lib/auto-follow-budget');
                    function historyRequests(id){
                        if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))return [];
                        if(!rounds.has(id)){
                            let requests=[];
                            try{
                                const round=budget.read(budget.roundFile(workspace,id)),sameOwner=o.postId?round?.targetKind==='post'&&(round.postId||round.uid)===o.postId:round?.targetKind!=='post'&&round?.uid===o.uid;
                                if(round?.id===id&&sameOwner&&Array.isArray(round.requests))requests=round.requests.map(q=>({id:q.id,kind:q.kind,at:q.at,count:q.count,returned:q.returned??null,unitPrice:q.unitPrice,estimatedCredits:q.estimatedCredits??null,reservedCredits:q.reservedCredits,actualCredits:q.actualCredits??null,verifiedLedger:q.verifiedLedger===true,status:q.status}));
                            }catch{}
                            rounds.set(id,requests);
                        }
                        return rounds.get(id);
                    }
                    const records=require('../lib/database-sync').history(dir).map(row=>({...row,autoRequests:historyRequests(row.autoRoundId),reason:clean(conciseError(row.reason))}));
                    publish('updateHistory',{requestId:message.requestId,mode:message.mode,targetKind:o.postId?'post':'user',target:o.postId||o.uid,records});
                    break;
                }
                case 'followList':
                    if(stagedHome?.base===workspace&&stagedHome.generation===bootstrapGeneration&&stagedHome.subscriptionsPending){
                        if(message.requestId)stagedHome.followRequests.set(message.requestId,true);
                        break;
                    }
                    publish('followState', {...getFollow().snapshot(),...(message.requestId?{requestId:message.requestId}:{})});
                    break;
                case 'followSave':
                    if(message.settings?.enabled)requireRecovered(followRecoveryQuery(message.settings));
                    getFollow().save({ ...message.settings, uid: targetUid(message.settings?.targetKind === 'post' ? message.settings.postId || message.settings.uid : message.settings?.uid) });
                    break;
                case 'followConfigure': {
                    if(message.intent==='enable')requireRecovered(followRecoveryQuery(message.settings));
                    const settings=message.settings;
                    const entry = getFollow().save({ ...settings, uid: targetUid(message.settings?.targetKind === 'post' ? message.settings.postId || message.settings.uid : message.settings?.uid) }, message.intent || 'save');
                    publish('followConfigured', { uid: entry.uid, targetKind: entry.targetKind, subscriptionKey: entry.subscriptionKey, requestId: message.requestId });
                    break;
                }
                case 'followBudgetReset': {
                    if(!['user','post'].includes(message.targetKind))throw Error('订阅对象类型无效');
                    const uid=targetUid(message.uid);
                    const result=getFollow().resetBudget(message.targetKind+':'+uid);
                    publish('followBudgetResetDone',{...result,requestId:message.requestId});
                    break;
                }
                case 'followMissingDismiss': {
                    if(!['user','post'].includes(message.targetKind))throw Error('订阅对象类型无效');
                    const result=getFollow().dismissMissing(message.targetKind+':'+targetUid(message.uid),message.notice);
                    publish('followMissingDismissed',{...result,requestId:message.requestId});
                    break;
                }
                case 'followResume': {
                    const id=message.targetKind==='post'?'post:'+targetUid(message.postId||message.uid):targetUid(message.uid),service=getFollow(),entry=service.snapshot().entries.find(e=>require('../lib/subscription-key').matches(e,id));
                    requireRecovered(followRecoveryQuery(entry||message));
                    service.resume(id);
                    break;
                }
                case 'followPause':
                    getFollow().pause(message.targetKind === 'post' ? 'post:' + targetUid(message.postId || message.uid) : targetUid(message.uid));
                    break;
                case 'followRemove': {
                    const id = targetUid(message.targetKind === 'post' ? message.postId || message.uid : message.uid), result = getFollow().unsubscribe((message.targetKind === 'post' ? 'post:' : 'user:') + id);
                    publish('followRemoved', { uid: id, targetKind: message.targetKind === 'post' ? 'post' : 'user', ...result });
                    break;
                }
                case 'followWake':
                    getFollow().wake();
                    break;
                case 'retention':
                    library.reportRetention(workspace, message.keep);
                    bootstrap();
                    publish('retentionSaved');
                    break;
                case 'cleanup':
                    if (active || preparing)
                        throw Error('请等待当前任务结束再清理报告');
                    publish('cleanup', library.cleanupOwnerReports(workspace));
                    bootstrap();
                    break;
                case 'favorite':
                    library.favorite(workspace, targetUid(message.uid), message.on === true);
                    bootstrap();
                    break;
                case 'merge': {
                    if (active || preparing)
                        throw Error('请先等待当前任务结束');
                    publish('merging');
                    const result = library.mergeReports(workspace, targetUid(message.uid));
                    publish('merged', result);
                    bootstrap();
                    break;
                }
                case 'reportOpened': {
                    const result = getReportAccess().opened(message.token);
                    if (result) {
                        publish('reportMarkedRead', result);

                    }
                    break;
                }

                case 'run': {
                    if(!message.query.preview&&!['offline','database'].includes(message.query.policy))requireRecovered(message.query);
                    if (deleting())
                        throw Error('已确认的删除尚未完成，请重新打开应用完成删除后再获取数据');
                    const query = structuredClone(message.query);
                    if(!approvedResume)for(const key of ['_scopeId','_resumeTaskId','_gapBudget','_gapKinds'])delete query[key];
                    if(query.syncOnly)query._scopeId ||= crypto.randomUUID();
                    message = { ...message, query: Object.freeze(query) };
                    const args = buildArguments(message.query);
                    if (active || preparing || pendingForeground())
                        throw Error('请先等待或停止当前任务');
                    const preparation = { id: crypto.randomUUID(), requestId: message.requestId, cancelled: false, query: message.query, startedAt: new Date().toISOString() };
                    if (!message.query.preview && ['update', 'refresh'].includes(message.query.policy)) {
                        preparing = preparation;
                        publish('preparing', { id: preparation.id, taskId: preparation.id, requestId: message.requestId });
                        const account = accountState && Date.now() - accountState.checkedAt < 30000 ? accountState : await lookupAccount(preparation.requestId);
                        if (preparing !== preparation || preparation.cancelled || terminating)
                            return;
                        preparing = null;
                        if (account.authenticationNeeded) {
                            recordPreparation(preparation, '登录授权未取得，未发起内容取数请求。');
                            publish('error', { message: '尚未取得登录授权，本次未读取微博，也未改写报告。请先点击顶部“登录”。', needsLogin: true, taskId: preparation.id, requestId: preparation.requestId });
                            return;
                        }
                    }
                    launch('collect', [path.join(ENGINE, 'weibo_cli.js'), ...args], message.query, preparation);
                    break;
                }
                case 'stop':
                    if(exchangeActive){exchangeController?.abort(Error('已停止数据包处理，已保存的恢复证据保留'));break;}
                    if (!cancelForeground(message.requestId)&&(!message.requestId||active?.requestId===message.requestId||preparing?.requestId===message.requestId))stop();
                    break;
                case 'login':
                    if (active || preparing)
                        throw Error('请先等待或停止当前任务');
                    accountGeneration += 1; accountState = null;
                    launch('login', [cli, 'auth', 'login', '--browser'], null, { requestId: message.requestId });
                    break;
                case 'loginCancel': {
                    const job = active || preparing;
                    if (job?.kind === 'login' && typeof message.requestId === 'string' && message.requestId && job.requestId === message.requestId) stop();
                    break;
                }
                case 'logout': {
                    if(active||preparing||profileBatch)throw Error('请先等待当前任务结束');
                    accountGeneration+=1;accountState=null;
                    const auth={id:crypto.randomUUID(),kind:'logout',requestId:message.requestId,workspace:requestWorkspace,cancelled:false};
                    preparing=auth;
                    publish('preparing',{id:auth.id,taskId:auth.id,requestId:auth.requestId,kind:'logout',query:null});
                    try{
                        // A previous free account query may refresh credentials;
                        // let it end before the official CLI clears this session.
                        if(accountTask)await accountTask.promise;
                        if(preparing!==auth||auth.cancelled||terminating||workspace!==auth.workspace)break;
                        preparing=null;
                        launch('logout',[cli,'auth','logout','--output','json'],null,auth);
                    }finally{if(preparing===auth)preparing=null;}
                    break;
                }
                case 'pricingReference':
                    publish('pricingReference', { ...require('./price-reference').snapshot(workspace), requestId: message.requestId });
                    break;
                case 'pricingRefresh': {
                    const base = workspace;
                    priceReference ??= require('./price-reference').create(base, { cli, query: configuration.priceQuery });
                    try {
                        const result = await priceReference.refresh();
                        if (base === workspace && !terminating)
                            publish('pricingReference', { ...result, requestId: message.requestId });
                    }
                    catch (error) {
                        if (base === workspace && !terminating)
                            publish('pricingError', { requestId: message.requestId, message: '价格查询未完成；已保存价格保留，请稍后重试。' });
                    }
                    break;
                }
                case 'account':
                    if((active||preparing)?.kind==='logout')throw Error('正在退出登录，请稍后再查询');
                    lookupAccount(message.requestId).catch(error=>{accountFailure(requestWorkspace,message.requestId,error);scopedPublish(requestWorkspace)('accountLoading',{requestId:message.requestId,loading:false});});
                    break;
                case 'open':
                    publish('open', getReportAccess().open(message.id, message.kind));
                    break;
                case 'output': {
                    const dir = path.join(workspace, 'output');
                    fs.mkdirSync(dir, { recursive: true });
                    publish('open', { kind: 'folder', path: dir });
                    break;
                }
                case 'shutdown':
                    if (terminating) break;
                    terminating = true;
                    publish('quitting', { message: '正在保存当前响应和续取位置，完成后退出。不会再发起下一次请求。' });
                    localActions.close();
                    insights?.close();inventoryRepairs?.close();
                    if (exchangePromise) {
                        exchangeController?.abort(Error('应用退出，数据包恢复证据保留'));
                        profiles?.close();
                        priceReference?.close();
                        follow?.close();
                        if (active || preparing)
                            stop();
                        await exchangePromise.catch(() => { });
                        return;
                    }
                    priceReference?.close();
                    profiles?.close();
                    follow?.close();
                    cancelForeground(null,true);
                    if (preparing)
                        recordPreparation(preparing, '应用退出，准备阶段取消；未发起内容取数请求。');
                    if (accountTask)
                        try {
                            process.kill(-accountTask.child.pid, 'SIGTERM');
                        }
                        catch { }
                    if (active)
                        stop();
                    else {
                        follow?.release();
                        process.exit(0);
                    }
                    break;
                default: throw Error('不支持的操作');
            }
        }
        catch (error) {
            const queued=queuedRequests.get(message.requestId);
            if(dispatch!==queuedDispatch&&queued&&!queued.completed){scopedPublish(queued.message.workspace)('foregroundRejected',{id:queued.id,requestId:message.requestId,action:message.action,message:clean(conciseError(error))});return;}
            if(dispatch!==queuedDispatch&&['localExport','searchOpen'].includes(message.action)&&error.code==='LOCAL_SNAPSHOT_BUSY'&&(active||preparing)?.automatic){deferred=queueForeground(message);return;}
            if(['taskFuturePreview','taskFutureChoose'].includes(message.action)){scopedPublish(requestWorkspace)('taskFutureError',{uid:message.uid,kind:message.kind,taskId:message.taskId,requestId:message.requestId,operation:message.action,message:clean(conciseError(error)),code:require('../lib/diagnostic-codes').safe(error.code)});return;}
            if(message.action==='postAuthorAvatar'){const code=['POST_AUTHOR_UNKNOWN','POST_AUTHOR_AVATAR_PROOF_UNAVAILABLE','POST_AUTHOR_CHANGED'].includes(error.code)?error.code:require('../lib/diagnostic-codes').safe(error.code);scopedPublish(requestWorkspace)('postAuthorAvatarResult',{postId:message.postId,authorUid:message.authorUid,requestId:message.requestId,updated:false,message:clean(conciseError(error)),code});return;}
            if(message.action==='account'){accountFailure(requestWorkspace,message.requestId,error);scopedPublish(requestWorkspace)('accountLoading',{requestId:message.requestId,loading:false});return;}
            if(['reportOpened','reportHandoff'].includes(message.action)){scopedPublish(requestWorkspace)('reportReadFailed',{requestId:message.requestId,message:'报告交接后的阅读状态未能保存；原状态保留，可稍后重新打开报告重试。',code:require('../lib/diagnostic-codes').safe(error.code)});return;}
            if(['globalSearch','searchPage','searchOpen','coverageTimeline','searchObjects'].includes(message.action)){publish('insightsError',{requestId:message.requestId,action:message.action,message:clean(conciseError(error)),code:require('../lib/diagnostic-codes').safe(error.code),cancelled:!!error.cancelled,workspace:requestWorkspace});return;}
            if (['localData','localExport'].includes(message.action)) {
                publish('localError', {requestId:message.requestId,action:message.action,message:clean(conciseError(error)),code:require('../lib/diagnostic-codes').safe(error.code),workspace:requestWorkspace});
                return;
            }
            if (message.action === 'localInventory') {
                publish('localInventoryError', {requestId: message.requestId, query: message.query, message: clean(conciseError(error)), code:require('../lib/diagnostic-codes').safe(error.code), workspace: requestWorkspace});
                return;
            }
            if (message.action === 'userNoteSave' || message.action === 'postNoteSave') {
                publish(message.action === 'userNoteSave' ? 'userNoteError' : 'postNoteError', { message: clean(conciseError(error)), code:require('../lib/diagnostic-codes').safe(error.code), workspace: requestWorkspace, requestId: message.requestId, ...(message.action === 'userNoteSave' ? { uid: message.uid } : { postId: message.postId }) });
                return;
            }
            if (message.action.startsWith('exchange')) {
                scopedPublish(requestWorkspace)('exchangeError', { operation: message.action, message: clean(conciseError(error)), code: require('../lib/diagnostic-codes').safe(error.code), requestId: message.requestId });
                return;
            }
            publish(message.action?.startsWith('manage') || message.action === 'profilesRefresh' ? 'manageError' : message.action?.startsWith('userDelete') ? 'userDeleteError' : message.action?.startsWith('local') ? 'localError' : message.action?.startsWith('follow') ? 'followError' : 'error', { message: clean(conciseError(error)), code:require('../lib/diagnostic-codes').safe(error.code), workspace: requestWorkspace, requestId: message.requestId, ...(message.action === 'run' ? { taskId: preparing?.id } : {}) });
        }
        finally {
            release?.();
            if(dispatch!==queuedDispatch)drainForeground();
            if(startupRequest)scopedPublish(requestWorkspace)('localWriteState',{requestId:message.requestId,busy:false});
            if(!deferred&&(dispatch===queuedDispatch||!queuedRequests.has(message.requestId)||queuedRequests.get(message.requestId).completed)&&['localExport','searchOpen','taskGapIgnore','taskFutureChoose','taskNoticeDismiss','followMissingDismiss','recoveryRetry','reportHandoff','postAuthorAvatar'].includes(message.action)&&message.requestId)scopedPublish(requestWorkspace)('localWriteState',{requestId:message.requestId,busy:false});
        }
    }
    return { handle, bootstrap, stop };
}
if (require.main === module) {
    const pos = process.argv.indexOf('--workspace'), bridge = runBridge({ workspace: pos >= 0 ? process.argv[pos + 1] : process.cwd(), deferBootstrap: true, requireNativeWorkspaceAck:process.argv.includes('--native-startup') });
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', line => { try {
        bridge.handle(JSON.parse(line));
    }
    catch {
        process.stdout.write(JSON.stringify({ type: 'error', message: '请求格式无效' }) + '\n');
    } });
    input.on('close', () => bridge.handle({ action: 'shutdown' }));
    if(!process.argv.includes('--wait-for-ready'))bridge.bootstrap();
    process.on('SIGTERM', () => bridge.handle({ action: 'shutdown' }));
    process.on('SIGINT', () => bridge.handle({ action: 'shutdown' }));
}
module.exports = { buildArguments, targetUid, listAccounts, listReports, containedReport, runBridge, clean };
