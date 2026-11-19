'use strict';
const $ = id => document.getElementById(id), all = s => [...document.querySelectorAll(s)];
if (typeof window.weiboAppInfo?.version === 'string') $('app-version').textContent = window.weiboAppInfo.version;
const modes = { 'comments-both': '发出和收到的评论', 'comments-sent': '发出的评论', 'comments-received': '收到的评论', 'mentions-in-comments': '被 @ 的评论', 'mentions-in-posts': '被 @ 的微博', 'comments-and-mentions': '评论与 @', 'post-comments': '微博下的评论', 'user-posts': '用户微博' };
const internal = { sent: 'comments-sent', received: 'comments-received', both: 'comments-both', 'mentions-comments': 'mentions-in-comments', 'mentions-posts': 'mentions-in-posts', 'post-comments': 'post-comments', 'user-posts': 'user-posts' };
const policies = { update: '更新新记录', cache: '读取历史记录', refresh: '读取记录 · 重新核查', offline: '用本地数据生成', database: '用本地数据生成' }, categories = { 'user-comments': '用户互动', 'post-comments': '微博评论', posts: '用户微博' };
const state = { task: 'sync', database: [], taskDrafts: { sync: { limit: '50', unlimited: false }, report: { limit: '200', unlimited: false } }, view: 'home', category: 'users', policy: 'cache', updateOperation: 'regular', busy: false, starting: false, activeId: null, jobKind: '', logs: [], reports: [], accounts: [], drafts: {}, favorites: [], workspace: '', account: null, credits: null, currentReports: [], userFilter: '', pickerFavorites: false, summary: null, sources: new Map(), plan: [], gapWarnings: [], availability: new Map(), continuation: false, returnLimited: false, lastQuery: null, toastTimer: null };
state.homeLoading={users:{status:'loading'},posts:{status:'loading'},reports:{status:'loading'},subscriptions:{status:'loading'}};
function renderHomeLoadStatus(section,id,retry=()=>send({action:'library'})){
 const value=state.homeLoading[section]||{status:'ready'},box=$(id);if(!box)return value.status;
 box.hidden=value.status==='ready';box.replaceChildren();box.setAttribute('role',value.status==='error'?'alert':'status');
 const subject={users:'用户',posts:'博文',subscriptions:'订阅'}[section]||'资料';
 if(!box.hidden){box.append(node('span','',value.status==='error'?'本地列表未能读取：'+(value.message||'请重试'):'正在读取本地'+subject+'数据…'));if(value.status==='error')box.append(button('重试读取','button secondary',retry));}
 return value.status;
}
const homeSections=['users','posts','reports','subscriptions'];
const homePayload={homeUsers:'users',postsHome:'posts',libraryData:'reports',followState:'subscriptions'};
const homeSnapshots=ReaderHomeAssets.createSnapshotReader(event=>window.weiboReceive(event));
const historySnapshots=ReaderHomeAssets.createSnapshotReader(event=>window.weiboReceive(event));
const ownerUnread=new Map();
let startupPaintQueued=false;
function noteStartupList(){
 if(startupPaintQueued||!window.webkit?.messageHandlers?.weibo)return;
 const workspace=state.workspace;
 startupPaintQueued=true;
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  if(workspace!==state.workspace){startupPaintQueued=false;noteStartupList();return;}
  const home=$('view-home');
  const empty=!state.accounts.length&&state.homeLoading.users.status==='ready';
  if(!home.hidden&&($('home-users').querySelector('.user-open:not([disabled])')||empty))send({action:'startupListReady'});
  else startupPaintQueued=false;
 }));
}
function syncOwnerUnread(event){
 const changed=new Set(),revision=Number.isSafeInteger(event.readingRevision)?event.readingRevision:0;
 function storeUnread(kind,id,count,unavailable,write,rowRevision=revision){
  if(typeof id!=='string'||!/^[1-9]\d{4,19}$/.test(id)||!Number.isSafeInteger(count)&&count!==null&&!unavailable)return;
  const key=kind+':'+id,previous=ownerUnread.get(key);
  if(previous&&rowRevision<previous.revision){write(previous);return;}
  const value={count,unavailable:!!unavailable,revision:rowRevision};
  ownerUnread.set(key,value);
  if(!previous||previous.count!==value.count||previous.unavailable!==value.unavailable)changed.add(key);
 }
 const home=(kind,row)=>storeUnread(kind,kind==='post'?row.postId:row.uid,row.unread,row.unreadUnavailable,value=>{
  row.unread=value.count;row.unreadUnavailable=value.unavailable;
 },Number.isSafeInteger(row.readingRevision)?row.readingRevision:revision);
 const follow=row=>storeUnread(row.targetKind||'user',row.postId||row.uid,row.inbox?.unread,row.inbox?.unavailable,value=>{
  row.inbox={...row.inbox,unread:value.count,unavailable:value.unavailable};
 });
 if(event.type==='homeUsers')for(const row of event.users||[])home('user',row);
 if(event.type==='postsHome')for(const row of event.posts||[])home('post',row);
 if(event.type==='followState')for(const row of event.entries||[])follow(row);
 if(event.type==='reportMarkedRead'){
  const kind=event.targetKind==='post'?'post':'user',id=kind==='post'?event.postId:event.uid;
  if(Number.isSafeInteger(event.unread)&&event.unread>=0)storeUnread(kind,id,event.unread,false,()=>{});
 }
 if(!changed.size)return changed;
 for(const [kind,rows] of [['user',state.homeUsers],['post',state.posts]])for(const row of rows||[]){
  const key=kind+':'+(kind==='post'?row.postId:row.uid),value=ownerUnread.get(key);
  if(changed.has(key)){row.unread=value.count;row.unreadUnavailable=value.unavailable;}
 }
 for(const row of state.subscriptions||[]){
  const key=(row.targetKind||'user')+':'+(row.postId||row.uid),value=ownerUnread.get(key);
  if(changed.has(key))row.inbox={...row.inbox,unread:value.count,unavailable:value.unavailable};
 }
 return changed;
}
function retainsHomeSnapshot(event){return !!(event.partial&&state.workspace&&state.workspace===event.workspace&&!event.homeBlocked&&!state.homeBlocked);}
function homeLoadEvent(event,retain){
 if(event.type==='library'){
  const clear=state.workspace!==event.workspace||event.homeBlocked;
  if(clear||state.bootstrapId!==(event.bootstrapId)){homeSnapshots.reset();historySnapshots.reset();}
  if(clear){ownerUnread.clear();state.homeUsers=[];state.posts=[];state.postAuthors={};state.database=[];state.reports=[];state.homeAssetSnapshots={};}
  state.bootstrapId=event.bootstrapId;
  state.homeBlocked=!!event.homeBlocked;
  state.homeLoading=Object.fromEntries(homeSections.map(name=>[name,retain&&state.homeLoading[name]?.snapshot?state.homeLoading[name]:{
   status:event.partial?'loading':'ready',snapshot:!event.partial&&name==='reports'&&Object.hasOwn(event,'reports')
  }]));
 }else if(event.bootstrapId&&event.bootstrapId!==state.bootstrapId||state.homeBlocked&&homePayload[event.type])return false;
 if(event.type==='libraryState'){
  const renders={users:window.renderUserHome,posts:window.renderPostHome,reports:window.renderContextReports};
  for(const name of event.section==='all'?homeSections:[event.section]){
   if(!homeSections.includes(name))continue;
   const previous=state.homeLoading[name],snapshot=!!previous?.snapshot;
   if(snapshot&&event.status==='loading'||previous?.snapshotFailed&&event.status==='ready')continue;
   const next={status:event.status,message:event.message||'',snapshot,...(event.snapshotFailed?{snapshotFailed:true}:{})};
   if(previous?.status===next.status&&(previous?.message||'')===next.message&&previous?.snapshotFailed===next.snapshotFailed)continue;
   state.homeLoading[name]=next;renders[name]?.();
  }
 }
 else if(homePayload[event.type])state.homeLoading[homePayload[event.type]]={status:'ready',snapshot:true};
 return true;
}
const workspaceChannel = ReaderWorkspaceChannel.create({current: () => state.workspace, assign: value => { state.workspace = value; }});
const taskEvents = ReaderTaskEvents.create(), taskActivity = ReaderTaskActivity.create(), entityStatus = ReaderEntityStatus.create();
const serviceScope = ReaderWorkspaceChannel.createScope(() => state.workspace);
window.ReaderNotices?.configure(() => state.workspace + '|' + filterKey() + '|' + state.task + '|' + mode());
function node(tag, cls, text) { const el = document.createElement(tag); if (cls)
    el.className = cls; if (text != null)
    el.textContent = text; return el; }
function markCommentDirection(element, kind) {
    if (kind === 'sent' || kind === 'comments-sent') element.dataset.commentDirection = 'sent';
    else if (kind === 'received' || kind === 'comments-received') element.dataset.commentDirection = 'received';
    else delete element.dataset.commentDirection;
    return element;
}
function button(text, cls, handler) { const el = node('button', cls, text); el.type = 'button'; el.addEventListener('click', handler); return el; }
function serviceLoginBusy() { return !!state.serviceLogin && serviceScope.owns(state.serviceLogin) && taskEvents.snapshot().requestId === state.serviceLogin.requestId; }
function contentTaskBusy() { return (state.busy || state.starting) && !serviceLoginBusy(); }
function serviceAccountText(account) { return (account.username ? '账户：' + account.username + '\n' : '') + '余额：' + (account.balance == null ? '暂不可用' : numeric(account.balance) + ' credits') + (account.service ? '\n服务状态：' + ({ formal_active: '正式服务', trial_active: '体验服务' }[account.service] || account.service) : ''); }
function renderServiceLogin() {
    const login = state.serviceLogin, visible = !!login && (serviceScope.owns(login) || login.localOnly && !state.serviceWorkspaceAccepted), box = $('service-login-status');
    box.hidden = !visible;
    if (!visible) return;
    $('service-login-heading').textContent = login.heading;
    window.ReaderNotices?.reset($('service-login-message'));
    $('service-login-message').hidden = false;
    $('service-login-message').textContent = login.message;
    if (login.failed) window.ReaderNotices?.decorate($('service-login-message'), {scope: login.workspace + '|service-login', key: login.requestId || 'engine'});
    $('service-login-cancel').hidden = !serviceLoginBusy() || login.operation === 'logout';
    $('service-login-cancel').disabled = !!login.cancelling;
}
function serviceLoginEvent(event, ownership) {
    const login = state.serviceLogin;
    if (!login || !serviceScope.owns(login)) return false;
    const engineStopped = ['engineStopped', 'engineTransportError'].includes(event.type) && ownership.task?.requestId === login.requestId;
    if (!engineStopped && (ownership.route !== 'task' || ownership.task?.requestId !== login.requestId)) return false;
    if(login.operation==='logout'){
        if(event.type==='serviceLogoutResult'){
            login.localCleared=event.localCleared===true;login.remoteConfirmed=event.remoteConfirmed===true;
            if(login.localCleared){state.account=null;state.displayBalance=null;state.serviceLoggedOut=true;state.serviceAccountRequest=null;state.balanceQueryState='logged-out';topBalance(null,'','未登录');$('balance-login').hidden=false;window.ReaderNotices?.reset($('account-info'));$('account-info').hidden=false;$('account-info').textContent='已退出登录';window.ReaderSettingsStatus?.serviceAccount(null,'signed-out');}
        }else if(event.type==='finished'||engineStopped||event.type==='error'){
            login.failed=!login.localCleared;login.heading=login.localCleared?'已退出登录':'退出未完成';
            login.message=login.localCleared?(login.remoteConfirmed?'重新登录后可继续联网读取。':'已退出本机登录，服务端退出状态暂未确认。'):'请稍后重试退出登录。';
            if(engineStopped)state.engineAvailable=false;
        }else{login.heading='正在退出登录';login.message='正在结束当前服务账户会话。';}
        setBusy({accountOnly:true});renderServiceLogin();return true;
    }
    if (engineStopped) {
        state.engineAvailable = false;
        login.failed = true;
        login.heading = '登录已中断'; login.message = '运行引擎已停止，请重新打开应用后登录；未读取微博内容。';
    } else if (event.type === 'started' || event.type === 'preparing') {
        login.heading = event.type === 'started' ? '等待浏览器授权' : '准备登录';
        login.message = event.type === 'started' ? '请在服务提供方的浏览器页面完成登录授权，不会读取微博内容。' : '正在准备服务账户登录，不会读取微博内容。';
    } else if (event.type === 'stopping') {
        login.cancelling = true; login.heading = '正在取消登录'; login.message = '正在等待登录进程退出，不会开始读取微博内容。';
    } else if (event.type === 'error') {
        login.failed = true;
        login.heading = '登录未完成'; login.message = event.message || '登录未完成，请稍后重试。';
    } else if (event.type === 'finished') {
        login.cancelling = false;
        login.failed = !event.cancelled && event.code !== 0;
        login.heading = event.cancelled ? '已取消登录' : event.code === 0 ? '授权已完成' : '登录未完成';
        login.message = event.cancelled ? '本次登录已取消，未读取微博内容。' : event.code === 0 ? '浏览器授权已完成，正在核对服务账户与余额。' : '服务账户登录未完成，请重试；未读取微博内容。';
    }
    setBusy({ accountOnly: true }); renderServiceLogin();
    if (event.type === 'finished' && event.code === 0 && !event.cancelled) send({ action: 'account', loginRequestId: login.requestId });
    return true;
}
function send(value) { value = workspaceChannel.bind(value); if (['resumeTask', 'login','logout'].includes(value.action)) {
    const auth=['login','logout'].includes(value.action),logout=value.action==='logout';
    if (auth && !state.serviceWorkspaceAccepted) {
        state.serviceLogin = { localOnly: true, heading: '登录尚未开始', message: '正在准备本地资料目录，请稍后再登录；未发起登录或内容请求。' };
        view('settings'); renderServiceLogin();
        return;
    }
    if (state.engineAvailable === false) {
        if (auth) {
            state.serviceLogin = serviceScope.capture({ failed: true, heading: '登录未启动', message: '运行引擎已停止，请重新打开应用后登录；未读取微博内容。' });
            view('settings'); renderServiceLogin();
        } else toast('运行引擎已停止，请重新打开应用后重试。', true);
        return;
    }
    const requestId = crypto.randomUUID();
    if (!taskEvents.begin(requestId, null)) {
        toast('请先等待或停止当前任务。');
        return;
    }
    value = { ...value, requestId };
    if (auth) {
        rememberFilters();
        state.serviceAccountRequest = null;
        state.balanceQueryState = 'idle';
        topBalance(state.displayBalance ?? null, state.displayBalance == null ? '' : '上次查询值', '尚未查询');
        if (state.account) $('account-info').textContent = '上次查询结果（本次授权后尚未核实）：\n' + serviceAccountText(state.account);
        window.ReaderSettingsStatus?.serviceAccount(null, 'authorization');
        state.serviceLogin = serviceScope.capture({ requestId,operation:logout?'logout':'login', heading:logout?'正在退出登录':'准备登录', message:logout?'正在结束当前服务账户会话。':'正在准备服务账户登录，不会读取微博内容。' });
        view('settings'); setBusy({ accountOnly: true }); renderServiceLogin();
    } else {
        state.progressQuery = null; setBusy(); status('准备续读', 'running'); setProgress('恢复原任务', null, '');
    }
} else if (value.action === 'account') {
    if (!state.serviceWorkspaceAccepted) return;
    value = { ...value, requestId: crypto.randomUUID() };
    state.serviceAccountRequest = serviceScope.capture({ requestId: value.requestId, loginRequestId: value.loginRequestId });
    state.balanceQueryState = 'loading'; $('refresh-balance').disabled = true; $('check-account').disabled = true;
    topBalance(state.displayBalance ?? null, state.displayBalance == null ? '' : '查询中…', '查询中…');
} const handler = window.webkit?.messageHandlers?.weibo; if (handler)
    handler.postMessage(value);
else if (window.weiboBrowserHarness)
    window.weiboBrowserHarness(value);
else
    toast('请在 Weibo Reader 应用中执行此操作。'); }
function toast(text, isError = false) { const box = $('toast'); box.textContent = text; box.hidden = false; clearTimeout(state.toastTimer); if (isError) window.ReaderNotices?.decorate(box, {key: crypto.randomUUID(), onDismiss: () => clearTimeout(state.toastTimer)}); else window.ReaderNotices?.reset(box); state.toastTimer = setTimeout(() => box.hidden = true, 4000); }
function numeric(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 }); }
function view(name) { if(state.view!==name)window.ReaderEntityActions?.closeResume(); state.view = name; all('.view').forEach(el => el.hidden = el.id !== 'view-' + name); all('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === (name === 'follow' ? 'subscriptions' : ['create', 'history'].includes(name) ? (state.selection?.kind === 'post' ? 'posts-home' : 'home') : name))); window.scrollTo({ top: 0 }); renderTaskActivity(); window.ReaderInsights?.enter(); window.postCenterOnView?.(name); }
function mode() { return state.category === 'users' ? $('mode').value : state.category === 'post' ? 'post-comments' : 'user-posts'; }
const uidOf = ReaderUX.uid;
function currentTarget() { return ReaderIdentity.target(state); }
function currentUser() { return ReaderIdentity.user(state); }
function currentBatch() { const target = state.category === 'post' ? ReaderUX.postId(currentTarget()) : currentUser(), category = state.category === 'post' ? 'post-comments' : state.category === 'posts' ? 'posts' : 'user-comments'; if (state.batchOverride?.target === target && state.batchOverride.category === category && internal[state.batchOverride.mode] === mode())
    return state.batchOverride; return state.database.filter(e => e.target === target && e.category === category && (e.mode === internal[mode()] || internal[e.mode] === mode() || e.mode === 'both' && ['comments-sent', 'comments-received', 'comments-both'].includes(mode()) || e.mode === 'all')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; }
function query(preview = false) { const q = ReaderDataQuery.build(state, $, ReaderIdentity, preview); state.policy = q.policy; return q; }
function relativeTime(value) { const ms = typeof value === 'number' ? value : Date.parse(value), seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (!Number.isFinite(ms))
    return '时间未知'; if (seconds < 60)
    return '刚刚'; if (seconds < 3600)
    return Math.floor(seconds / 60) + ' 分钟前'; if (seconds < 86400)
    return Math.floor(seconds / 3600) + ' 小时前'; if (seconds < 2592000)
    return Math.floor(seconds / 86400) + ' 天前'; if (seconds < 31536000)
    return Math.floor(seconds / 2592000) + ' 个月前'; return Math.floor(seconds / 31536000) + ' 年前'; }
function timeSpan(value) { const span = node('span', 'relative-time', relativeTime(value)); span.dataset.timestamp = String(value); return span; }
function filterKey() { return state.workspace + '|' + state.category + ':' + (state.category === 'post' ? ReaderUX.postId(currentTarget()) : currentUser()); }
function rememberFilters() { if (!state.formOwner || !state.formTask)
    return; state.filtersByUser ??= {}; const user = state.filtersByUser[state.formOwner] ??= {}, previous = user[state.formTask] || {}, range = state.formTask === 'sync' ? $('date-range-enabled').checked : $('view-range-enabled').checked; user[state.formTask] = { ...previous, from: $('from').value, to: $('to').value, range, limit: $('limit').value, unlimited: $('unlimited').checked, markUnread: $('mark-unread').checked, peerUid: state.formTask === 'report' ? $('report-peer')?.value || '' : '' }; if (state.formTask === 'sync' && range && (!$('from').value || ReaderUX.validDay($('from').value)) && (!$('to').value || ReaderUX.validDay($('to').value)) && (!$('from').value || !$('to').value || $('from').value <= $('to').value))
    user.sync.lastSpecified = $('from').value || $('to').value ? { from: $('from').value, to: $('to').value } : null; }
function syncUserFilters() { const key = filterKey(); if (state.formOwner === key && state.formTask === state.task)
    return; rememberFilters(); state.filtersByUser ??= {}; const d = state.filtersByUser[key]?.[state.task] || {}; $('from').value = d.from ?? ''; $('to').value = d.to ?? ''; $('date-range-enabled').checked = state.task === 'sync' ? !!d.range : $('date-range-enabled').checked; $('view-range-enabled').checked = state.task === 'report' ? !!d.range : $('view-range-enabled').checked; $('mark-unread').checked = state.task === 'report' ? d.markUnread !== false : $('mark-unread').checked; if ($('report-peer'))
    $('report-peer').value = state.task === 'report' ? d.peerUid || '' : ''; $('limit').value = d.limit || (state.task === 'report' ? '200' : '50'); $('unlimited').checked = !!d.unlimited; state.formOwner = key; state.formTask = state.task; }
function setTask(task) { rememberFilters(); state.task = task; state.updateOperation = 'regular'; syncUserFilters(); updateForm(); }
function quickCheck() { if (state.busy || state.starting) {
    toast('当前获取任务尚未结束。');
    return;
} if (state.category !== 'users') {
    toast('该内容请使用获取数据。');
    return;
} const previous = state.task; setTask('sync'); state.updateOperation = 'quick'; updateForm(); start(false); state.updateOperation = 'regular'; setTask(previous); }
function saveForm() { rememberFilters(); try {
    localStorage.setItem('weibo-reader-query', JSON.stringify({ localViewVersion: 1, unreadDefaultVersion: 1, dateDefaultsVersion: 1, filtersByUser: state.filtersByUser, category: state.category, taskDrafts: state.taskDrafts, ...query(), localFrom: $('from').value, localTo: $('to').value }));
}
catch { } }
function updateForm() {
    window.ReaderInsights?.enter();
    syncUserFilters();
    window.ReaderNotices?.syncContext($('form-error'));
    renderTaskActivity();
    $('mode').value = ReaderIdentity.desktopMode($('mode').value);
    const q = query();
    syncTaskCard(q);
    const sync = state.task === 'sync', user = state.category === 'users', posts = state.category === 'posts', batch = currentBatch(), range = sync ? posts || user && state.updateOperation === 'regular' && $('date-range-enabled').checked : $('view-range-enabled').checked;
    const peerAllowed = !sync && user && ['comments-sent', 'comments-received', 'comments-both'].includes(mode());
    $('report-peer-field').hidden = !peerAllowed;
    if (!peerAllowed)
        $('report-peer').value = '';
    const peerChoices = state.accounts.filter(a => a.uid !== currentUser()), peerChoiceKey = JSON.stringify(peerChoices.map(a => [a.uid, a.nickname]));
    if (state.peerChoiceKey !== peerChoiceKey) {
        state.peerChoiceKey = peerChoiceKey;
        const choices = $('report-peer-options');
        choices.replaceChildren();
        for (const account of peerChoices) {
            const option = node('option');
            option.value = account.uid;
            option.label = account.nickname;
            choices.append(option);
        }
    }
    $('mode-field').hidden = !user;
    $('target-label').textContent = state.category === 'post' ? '目标微博' : '目标用户';
    $('target-kind').textContent = state.category === 'post' ? '微博 ID 或原微博链接' : 'UID 或用户主页链接';
    $('target').placeholder = state.category === 'post' ? '粘贴原微博链接，或输入微博 ID' : '例如 1000000021，或选择已保存用户';
    $('choose-user').parentElement.hidden = state.category === 'post';
    $('quick-check').hidden = !user;
    $('quick-check').disabled = state.busy || state.starting;
    $('sync-options').hidden = !sync || !user;
    $('report-options').hidden = sync;
    $('request-settings').hidden = !sync;
    $('post-range').hidden = !range;
    window.ReaderDateControls?.refresh();
    $('post-extras').hidden = !sync || !posts;
    $('recheck-field').hidden = true;
    $('history-check').hidden = true;
    $('date-range-option').hidden = state.updateOperation === 'quick';
    $('return-budget-field').hidden = !user;
    $('empty-field').querySelector('label').textContent = posts ? '连续空窗口上限' : '连续空窗口保护上限';
    $('update-operation-note').textContent = state.updateOperation === 'quick' ? '只获取上次成功位置之后的新增；该方向没有可靠起点时，自动按当前上限首次读取。日期范围不用于此操作。' : '先检查新增，再复用可信范围内的完整本地数据，不足时向前补充。中断可继续，不会额外核查历史编辑或可见性。';
    all('[data-update-operation]').forEach(el => { el.classList.toggle('active', el.dataset.updateOperation === state.updateOperation); el.setAttribute('aria-pressed', String(el.dataset.updateOperation === state.updateOperation)); });
    $('seek-field').hidden = !user || !range;
    $('empty-field').hidden = !sync || state.category === 'post';
    $('page-size').placeholder = posts ? '100' : '200';
    $('limit').disabled = $('unlimited').checked;
    $('database-time').textContent = batch ? '上次更新：' + dateText(Date.parse(batch.updatedAt)) + '（' + relativeTime(batch.updatedAt) + '）' + (batch.incomplete ? ' · 范围尚未完成' : '') : '本地尚无该功能的更新记录。';
    $('limit-label').textContent = sync ? (state.policy === 'update' ? '新增返回条数上限' : '本次覆盖条数') : '报告条数';
    if (!contentTaskBusy())
        $('summary-limit-label').textContent = sync ? (state.policy === 'update' ? '新增返回上限' : '覆盖目标') : '查看范围';
    $('unlimited-label').textContent = sync ? (state.policy === 'update' ? '全部新增（仍受预算约束）' : '全部（仅限所选范围）') : '查看全部匹配记录（按需展开）';
    const scope = ReaderUX.scope(q);
    $('quota-hint').textContent = sync ? scope.hint : (state.category === 'post' ? '按评论发生时间选取本地记录，引用上下文不计条数。' : state.category === 'posts' ? '按微博发布时间选择本地记录。' : '按互动发生时间选取本地最新记录，发出与收到合并去重；引用上下文不计条数。') + (q.batch ? '本次新增不足所填数量时按实际条数生成。' : '');
    $('cost-warning').textContent = sync ? scope.warning : '';
    $('cost-warning').hidden = !sync || !scope.warning;
    $('query-note').textContent = sync ? '只获取数据，不生成 HTML；更新完成后可单独生成报告。' : '仅使用本地数据，新增费用 0 credits。';
    if (!contentTaskBusy())
        $('billing-note').textContent = sync ? '按接口实际返回条数计费，含重复返回。\n本地复用免费。' : '仅使用本地数据，新增费用 0 credits。';
    markCommentDirection($('mode'), mode());
    const activeQuery = contentTaskBusy() ? taskEvents.snapshot().query : null;
    const activeOwner = ReaderTaskActivity.key(activeQuery, state.workspace);
    const taskTarget = $('task-target');
    taskTarget.hidden = !activeOwner || activeOwner === ReaderTaskActivity.key(q, state.workspace);
    if (taskTarget.hidden)
        taskTarget.textContent = '';
    else if (activeQuery.subject?.kind === 'post' || activeQuery.mode === 'post-comments')
        taskTarget.textContent = '博文 ' + ReaderUX.postId(activeQuery.subject?.id || activeQuery.target);
    else {
        const uid = uidOf(activeQuery.subject?.uid || activeQuery.target);
        const nickname = state.accounts.find(account => account.uid === uid)?.nickname;
        taskTarget.textContent = (nickname ? nickname + ' · ' : '') + 'UID ' + uid;
    }
    if (!contentTaskBusy()) {
        markCommentDirection($('task-title'), mode()).textContent = (sync ? '获取数据 · ' : '生成报告 · ') + modes[mode()];
        $('summary-policy').textContent = sync ? (range ? '常规获取 · 日期范围' : user && state.updateOperation === 'quick' ? '快速检查更新' : '常规获取') : '本地查看 · 0 credits';
        $('summary-limit').textContent = scope.summary;
    }
    $('continue-update').hidden = !state.continuation || !sync || !state.lastTaskId;
    all('[data-task]').forEach(el => { el.classList.toggle('active', el.dataset.task === state.task); el.setAttribute('aria-pressed', String(el.dataset.task === state.task)); el.disabled = false; });
    all('[data-category]').forEach(el => el.classList.toggle('active', el.dataset.category === state.category));
    $('preview').textContent = '检查获取设置';
    $('preview').hidden = !sync;
    $('start').disabled = !!state.localGenerating || state.busy && sync;
    $('start').hidden = state.busy && sync && !serviceLoginBusy();
    $('start').textContent = state.localGenerating ? '正在生成报告…' : sync ? (state.policy === 'update' ? '快速检查更新' : '获取数据') : '生成并打开报告';
    if (state.task === 'report')
        scheduleLocal();
    else
        clearTimeout(localTimer);
    $('local-results').hidden = state.task !== 'report';
    if (state.task === 'report' && !contentTaskBusy()) {
        $('cost').textContent = '0';
        renderReturned({}, q);
        $('query-note').textContent = '按当前条件生成并打开 HTML；数据与条件未变时直接复用已有报告，新增费用 0 credits。';
    }
    renderRecentTaskCard(q);
    const uid = currentUser(), fav = state.favorites.includes(uid);
    $('favorite-target').textContent = fav ? '★' : '☆';
    $('favorite-target').classList.toggle('selected', fav);
    $('favorite-target').disabled = !uid;
    $('favorite-target').title = fav ? '取消特别关注' : '特别关注该用户';
    saveForm();
    window.renderUserContinuation?.();
    renderReportFolderAction();
}
// Activity controls animation; saved results and form drafts never imply a running request.
function taskMatchesForm(input) { if (!input)
    return false; const current = query(), publicInput = Object.fromEntries(Object.keys(current).map(k => [k, input[k]])); return ReaderDataQuery.key(publicInput) === ReaderDataQuery.key(current); }
function progressActive() { return !!(contentTaskBusy() || state.localGenerating); }
function syncProgressMotion() { const active = progressActive(); $('progress-track').classList.toggle('is-running', active); if (!active && !$('progress-track').classList.contains('determinate'))
    $('progress-track').hidden = true; }
function renderTaskParameters(q) {
    const report = q.task === 'report', quick = q.syncOperation === 'quick' || q.policy === 'update';
    $('task-panel-heading').textContent = '本次任务';
    markCommentDirection($('task-title'), q.mode).textContent = (report ? '生成报告 · ' : quick ? '快速检查更新 · ' : '获取数据 · ') + (modes[q.mode] || q.mode);
    $('summary-policy').textContent = report ? '本地查看 · 0 credits' : quick ? '快速检查更新' : q.from || q.to ? '常规获取 · 日期范围' : '常规获取';
    $('summary-limit-label').textContent = report ? '查看范围' : quick ? '新增返回上限' : '覆盖目标';
    $('summary-limit').textContent = ReaderUX.scope(q).summary;
}
function renderLiveAdded(count) {
    if (!state.progressQuery?.syncOnly || state.progressQuery.preview || !Number.isSafeInteger(count) || count < 0)
        return;
    $('task-card').classList.add('is-acquiring');
    $('summary-limit-label').textContent = '本次新增';
    const value = numeric(count) + ' 条';
    if ($('summary-limit').textContent !== value) $('summary-limit').textContent = value;
}
function resetTaskCard(q = query()) {
    if ($('task-progress-dialog')?.open)
        $('task-progress-dialog').close();
    resetProgressPresentation();
    $('task-card').classList.remove('is-acquiring');
    $('task-panel-heading').textContent = '本次任务';
    $('continue-update').removeAttribute('data-task-id');
    state.cardFormKey = ReaderDataQuery.key(q);
    state.summary = null;
    state.credits = null;
    state.continuation = false;
    state.returnLimited = false;
    state.sources.clear();
    state.plan = [];
    state.gapWarnings = [];
    state.availability.clear();
    status('待开始');
    $('progress-stage').textContent = '等待开始';
    $('progress-ratio').textContent = '';
    $('progress-track').hidden = true;
    $('progress-track').classList.remove('is-running', 'determinate');
    $('progress-track').removeAttribute('aria-valuenow');
    $('progress-fill').style.width = '0%';
    $('cost').textContent = q.task === 'report' ? '0' : '—';
    $('cost').classList.remove('uncertain');
    renderAvailability();
    $('form-error').hidden = true;
    $('progress-message').textContent = q.task === 'report' ? '点击“生成并打开报告”后，使用本地数据生成。' : '点击“获取数据”后才会开始读取。';
    if (state.account?.balance != null) {
        $('balance-label').textContent = '上次查询余额';
        $('balance').textContent = numeric(state.account.balance) + ' credits';
    }
    else {
        $('balance-label').textContent = '剩余余额';
        $('balance').textContent = '尚未查询';
    }
    renderReturned({}, q);
}
function resultExplanationLabel(done) {
    const feedback = done.feedback;
    if (!feedback?.saved)
        return done.state === 'interrupted' ? '获取已中断' : done.state === 'failed' ? '获取未完成' : '保存结果待确认';
    const issue = feedback.issues.find(value => !value.missingBodyCount && !(feedback.middleGap && value.code === 'new'));
    return issue?.text || '结果待确认';
}
// Completed counters belong to the captured task, never to the next form draft.
function renderRecentTaskCard(q = query()) {
    renderEntityInventory();
    if (!entityStatus.allows() || contentTaskBusy() || state.localGenerating || state.finishingTask || q.task !== 'sync')
        return false;
    const result = taskActivity.result(q, state.workspace);
    if (!result)
        return false;
    renderTaskActivity();
    const done = result.outcome, summary = result.summary || {}, fee = result.credits || {}, captured = result.query;
    const quick = captured.syncOperation === 'quick' || captured.policy === 'update';
    const repair=entityStatus.snapshot().repair;if(repair&&done.feedback){done.feedback=ReaderAcquisitionFeedback.describe({...result.summary,inventoryRepair:repair},{partialFailures:done.partialFailures});}
    const localNotice = done.feedback?.saved && done.feedback.issues.length > 0 &&
        done.feedback.issues.every(issue => issue.code.startsWith('local:')) && !summary.incomplete;
    const complete = !['failed','interrupted','unverified'].includes(done.state) &&
        (done.state === 'complete' || done.feedback?.goalComplete === true || localNotice || repair?.state === 'complete' && done.feedback?.complete);
    const coveredGap = complete && done.feedback?.middleGap;
    const issues = done.feedback?.issues || [];
    const showExplanation = !done.feedback?.saved || issues.some(issue => !issue.missingBodyCount && !(coveredGap && issue.code === 'new')) || !complete;
    $('task-panel-heading').textContent = '上次获取结果';
    markCommentDirection($('task-title'), captured.mode).textContent = modes[captured.mode] || captured.mode;
    $('summary-policy').textContent = quick ? '快速检查更新' : captured.from || captured.to ? '常规获取 · 日期范围' : '常规获取';
    $('summary-limit-label').textContent = '本次新增';
    const added = summary.addedRecords;
    $('summary-limit').textContent = done.feedback?.saved && Number.isSafeInteger(added) && added >= 0 ? numeric(added) + ' 条' : '—';
    $('cost').textContent = fee.estimatedCredits == null ? (fee.unknownRequests ? '待核对' : '—') : numeric(fee.estimatedCredits) + (fee.unknownRequests ? ' + 待核对' : '');
    $('cost').classList.toggle('uncertain', fee.estimatedCredits == null || fee.unknownRequests > 0);
    if (fee.finalBalance != null) {
        $('balance-label').textContent = '本次结束时余额';
        $('balance').textContent = numeric(fee.finalBalance) + ' credits';
    }
    else if (fee.initialBalance != null && fee.estimatedCredits != null && !fee.unknownRequests) {
        $('balance-label').textContent = '本次结束时余额估算';
        $('balance').textContent = numeric(fee.initialBalance - fee.estimatedCredits) + ' credits';
    }
    else {
        $('balance-label').textContent = '本次结束时余额';
        $('balance').textContent = '未取得';
    }
    renderReturned({...summary, ...fee}, captured);
    const expectedKinds = {'comments-both':['sent','received'],'comments-sent':['sent'],'comments-received':['received'],'post-comments':['post-comments']}[captured.mode];
    const noNew = complete && !issues.length && quick && summary.records === 0 && summary.addedRecords === 0 && expectedKinds?.every(kind=>summary.sources?.some(source=>source.kind===kind&&(source.update?.verifiedNoNew===true&&source.update?.timeOrderVerified===true)));
    status(noNew ? '读取完成 · 无新增' : complete ? localNotice ? '读取完成 · 有提示' : '读取完成' : done.state === 'interrupted' ? '已中断' : done.feedback?.saved ? '读取未完成 · 已保存' : '读取未完成', complete ? 'success' : 'warning');
    setProgress(noNew ? '检查完成，未发现新增' : complete ? '获取已完成' : '', complete ? 1 : null, '');
    $('task-card').classList.add('is-result');
    $('task-card').classList.remove('is-acquiring');
    if (coveredGap && result.taskId)
        $('result-gap-notice').dataset.taskId = result.taskId;
    renderResultGapNotice();
    const missing = $('result-missing-bodies');
    missing.hidden = !result.missingBodies.count;
    missing.textContent = missing.hidden ? '' : (result.missingBodies.atLeast ? '至少 ' : '') + numeric(result.missingBodies.count) + ' 个已知 ID 缺失正文';
    if (!complete)
        $('progress-track').hidden = true;
    $('progress-message').textContent = noNew ? '已核对所选方向，未发现新增。' : done.feedback?.detail || '保存结果待确认，请查看运行详情。';
    $('progress-message').hidden = false;
    if (showExplanation)
        $('progress-details').dataset.resultLabel = resultExplanationLabel(done);
    else if (issues.length)
        $('progress-message').hidden = true;
    if (hasSeparateContinuationNotice(captured,result)) {
        window.ReaderNotices?.reset($('progress-message'));
        $('progress-message').hidden = true;
    } else if (showExplanation) {
        window.ReaderNotices?.decorate($('progress-message'), {
            scope: ReaderTaskActivity.key(captured, state.workspace), key: result.taskId,
            ...window.taskPresentationOptions?.(captured,result.taskId,result), externalDismiss:true
        });
    }
    return true;
}
function syncTaskCard(q) { const key = ReaderDataQuery.key(q); if (!state.finishingTask && !progressActive() && state.cardFormKey !== key)
    resetTaskCard(q); syncProgressMotion(); }
function status(text, cls = '') { $('status-pill').textContent = text; $('status-pill').className = 'status-pill' + (cls ? ' ' + cls : ''); }
function setBusy({ accountOnly = false } = {}) { const projected = taskEvents.snapshot(); state.busy = projected.busy; state.starting = projected.starting; state.activeId = projected.activeId; const value = projected.busy, login = serviceLoginBusy(); $('active-task').hidden = !value; $('active-task').textContent = login ? (state.serviceLogin?.operation==='logout'?'正在退出登录':'登录进行中 · 返回账户设置') : '任务进行中 · 返回查看'; all('#query-form input,#query-form select,#query-form button,[data-category]').forEach(el => el.disabled = false); $('login').disabled = value; $('balance-login').disabled = value; $('service-logout').disabled = value || !state.serviceWorkspaceAccepted || state.serviceLoggedOut === true || !state.account && state.balanceQueryState !== 'error' || state.balanceQueryState === 'loading'; $('service-logout').textContent = login && state.serviceLogin?.operation === 'logout' ? '正在退出…' : '退出登录'; $('check-account').disabled = login || state.balanceQueryState === 'loading'; $('refresh-balance').disabled = login || state.balanceQueryState === 'loading'; $('choose-workspace').disabled = value; $('start').disabled = value && state.task === 'sync'; $('continue-update').disabled = value; $('start').hidden = value && state.task === 'sync' && !login; $('stop').hidden = !value || login; if (!accountOnly) { if (!value) syncProgressMotion(); updateForm(); } renderFavorites(); }
function renderEntityInventory() {
    const q={target:currentTarget(),mode:mode()}, previous=entityStatus.snapshot().key, request=entityStatus.enter(q,state.workspace,state.view==='create'&&!!state.workspace);
    if(previous!==entityStatus.snapshot().key)state.cardFormKey=null;
    if(request&&state.engineAvailable!==false)send({action:'localInventory',requestId:request.requestId,query:request.query});
    const value=entityStatus.snapshot(),box=$('entity-inventory');box.hidden=!value.key;
    if(box.hidden)return;
    window.ReaderNotices?.reset(box);
    if(value.error){box.textContent=value.error;window.ReaderNotices?.decorate(box,{scope:value.key,key:value.requestId});return;}
    box.textContent=value.summary?'本地已保存 '+numeric(value.summary.records)+' 条'+(value.summary.missingBodyCount>0?' · '+numeric(value.summary.missingBodyCount)+' 个已知 ID 缺少正文':'')+(value.summary.complete===false?' · 部分本地文件未能统计':''):'正在读取本地统计…';
    if(value.repair?.recovery&&(value.repair.state==='queued'||value.repair.state==='running'))box.textContent=(value.summary?box.textContent+'（待刷新） · ':'')+'数据已保存，正在重新统计';
    else if(value.repair?.state==='failed'){box.textContent=(value.summary?box.textContent+'（待刷新） · ':'')+'数据已保存，条数暂未更新；'+(value.repair.diagnostic?.code||'本地统计失败');window.ReaderNotices?.decorate(box,{scope:value.key,key:value.repair.id});}
    else if(value.repair?.recovery&&value.repair.state==='complete'&&value.summary)box.textContent+=' · 统计已恢复';
    box.title=value.summary?'仅统计本地已保存的独立记录；引用不计条数，缺少正文不代表已删除。'+(value.summary.warnings||[]).join('；'):'';
}
function renderTaskActivity() {
    window.ReaderEntityActions?.refreshContinuationChoices();
    renderEntityInventory();
    const current = { target: currentTarget(), mode: mode() }, key = ReaderTaskActivity.key(current, state.workspace);
    if (state.logDisplayKey !== key) {
        state.logDisplayKey = key;
        $('log-area').hidden = true;
        $('toggle-log').setAttribute('aria-expanded', 'false');
    }
    state.logs = taskActivity.lines(current, state.workspace);
    $('logs').textContent = state.logs.join('\n');
    $('log-count').textContent = state.logs.length + ' 条';
    $('run-activity').hidden = !state.logs.length;
    $('copy-log').disabled = !state.logs.length;
    const result = taskActivity.outcome(current, state.workspace), feedback = $('acquisition-feedback');
    const active = taskEvents.snapshot();
    window.ReaderNotices?.reset(feedback);
    const capturedResult=taskActivity.result(current,state.workspace),detailedResult=!!capturedResult&&!contentTaskBusy()&&!state.localGenerating&&!state.finishingTask&&state.task==='sync';
    feedback.hidden = !entityStatus.allows() || !result || state.view !== 'create' || active.busy && key === ReaderTaskActivity.key(active.query, state.workspace) || detailedResult || hasSeparateContinuationNotice(current,capturedResult);
    if (feedback.hidden)
        return;
    feedback.className = 'acquisition-feedback ' + (result.state === 'complete' || result.feedback?.goalComplete ? 'success' : 'warning');
    feedback.textContent = result.state === 'complete' ? '✓ 上次获取完成 · 覆盖 ' + numeric(result.records) + ' 条' + (result.addedRecords != null ? ' · 新保存 ' + numeric(result.addedRecords) + ' 条' : '') : result.state === 'interrupted' ? '已停止，已保存数据和续读位置保留' : result.state === 'failed' ? '获取未完成，已有数据和恢复证据保留' : result.state === 'partial' ? (result.pending ? '数据已保存，仍有新增待读取' : '数据已保存，部分内容仍待核实') : '获取结果尚未确认，请查看运行详情';
    const repair=entityStatus.snapshot().repair;if(repair&&result.feedback){const captured=taskActivity.result(current,state.workspace);if(captured)result.feedback=ReaderAcquisitionFeedback.describe({...captured.summary,inventoryRepair:repair},{partialFailures:result.partialFailures});}
    if(result.feedback){feedback.textContent=result.feedback.title;feedback.title=result.feedback.detail+' '+dateText(result.at);}else feedback.title = dateText(result.at);
    if (result.state !== 'complete') window.ReaderNotices?.decorate(feedback, {scope: key, key: 'outcome:' + result.at,...window.taskPresentationOptions?.(capturedResult?.query||current,capturedResult?.taskId,capturedResult)});
}
function hasSeparateContinuationNotice(query,result){
    return !!window.hasTaskContinuation?.(query,result?.taskId) &&
        !result?.outcome?.feedback?.middleGap &&
        !result?.outcome?.feedback?.issues.some(issue=>issue.code==='boundary'||issue.code.startsWith('source:'));
}
function renderResultGapNotice() {
    const notice = $('result-gap-notice'), taskId = notice.dataset.taskId;
    notice.hidden = !taskId || !entityStatus.allows(taskId) ||
        !window.ReaderEntityActions?.showsContinuation?.(state.selection?.kind, currentTarget(), taskId);
}
window.syncTaskNoticePresentation=()=>{
    const current={target:currentTarget(),mode:mode()},result=taskActivity.result(current,state.workspace);
    if(hasSeparateContinuationNotice(current,result)){
        const message=$('progress-message');
        window.ReaderNotices?.reset(message);
        message.hidden=true;
    }
    renderTaskActivity();
};
function log(text, owner) { taskActivity.append(owner, text, state.workspace); renderTaskActivity(); if (!$('log-area').hidden)
    $('logs').scrollTop = $('logs').scrollHeight; }
function topBalance(value, note = '', unknown = '暂不可用') { state.displayBalance = value; $('top-balance').textContent = value == null ? unknown : numeric(value) + ' credits'; $('top-balance-note').textContent = note; $('top-balance').classList.toggle('zero', value === 0); }
function credits(data) {
    state.credits = data;
    $('cost').textContent = data.estimatedCredits == null ? '待核对' : numeric(data.estimatedCredits);
    $('cost').classList.toggle('uncertain', data.estimatedCredits == null || data.unknownRequests > 0);
    if (data.unknownRequests > 0)
        $('cost').textContent = (data.estimatedCredits == null ? '' : numeric(data.estimatedCredits) + ' + ') + '待核对';
    let balance = null, label = '剩余余额';
    if (data.finalBalance != null) {
        balance = data.finalBalance;
        label = '服务端查询余额';
        state.account = { ...state.account, balance, checkedAt: Date.now() };
        topBalance(balance, '已核实');
    }
    else if (data.initialBalance != null && !data.unknownRequests && data.estimatedCredits != null) {
        balance = data.initialBalance - data.estimatedCredits;
        label = '余额估算';
        topBalance(balance, '估算');
    }
    else if (!data.offline && state.jobBalance != null && !data.unknownRequests && data.estimatedCredits != null) {
        balance = state.jobBalance - data.estimatedCredits;
        label = '余额估算';
        topBalance(balance, '估算');
    }
    else if (state.account?.balance != null) {
        balance = state.account.balance;
        label = '上次查询余额';
        if (data.unknownRequests)
            topBalance(balance, '上次查询 · 费用待核对');
    }
    $('balance-label').textContent = label;
    $('balance').textContent = balance == null ? (data.offline ? '离线，未查询' : '暂不可用') : numeric(balance) + ' credits';
    renderReturned(data);
}
function resetProgressPresentation() {
    window.ReaderNotices?.reset($('progress-message'));
    $('progress-message').hidden = false;
    $('result-missing-bodies').hidden = true;
    $('result-gap-notice').hidden = true;
    delete $('result-gap-notice').dataset.taskId;
    $('task-card').classList.remove('is-result');
    delete $('progress-details').dataset.resultLabel;
}
function setProgress(label, value, text) { resetProgressPresentation(); $('progress-stage').textContent = label; $('progress-ratio').textContent = text || ''; const finite = Number.isFinite(value), active = progressActive(); $('progress-track').hidden = !active && !finite; $('progress-track').classList.toggle('determinate', finite); $('progress-track').classList.toggle('is-running', active); $('progress-fill').style.width = finite ? Math.max(0, Math.min(100, value * 100)) + '%' : '32%'; if (finite)
    $('progress-track').setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Math.round(value * 100)))));
else
    $('progress-track').removeAttribute('aria-valuenow'); }
// Keep local report costs separate from CLI return counts.
function renderReturned(data = {}, q = state.runningQuery || query()) {
    const local = q?.task === 'report' || q?.policy === 'database';
    
    $('returned-label').textContent = local ? '数据来源' : '接口返回条数';
    $('returned').textContent = local ? '本地导出 · 0 credits' : numeric(data.returnedRecords ?? data.newRecords ?? 0) + ' 条';
}
function collection(event) {
    
    state.sources.set(event.kind, event);
    const steps = state.plan.length ? state.plan : [{ kind: event.kind, budget: event.budget }];
    const update = (state.runningQuery || state.lastQuery)?.policy === 'update';
    if (update && steps.every(p => p.budget != null)) {
        const total = steps.reduce((n, p) => n + p.budget, 0), returned = steps.reduce((n, p) => n + Math.min(state.sources.get(p.kind)?.newReturned || 0, p.budget), 0);
        setProgress('本次新增取数', total ? returned / total : null, `${numeric(returned)} / ${numeric(total)} 条`);
    }
    else if (update || event.phase === 'seek') {
        const done = steps.filter(p => state.sources.get(p.kind)?.done && !state.sources.get(p.kind)?.partial).length;
        const fetched = [...state.sources.values()].reduce((n, e) => n + (e.fetched || 0), 0);
        setProgress(event.phase === 'seek' ? '正在定位目标日期' : '核对新增区间', done ? done / steps.length : null, done ? `已衔接 ${done}/${steps.length} 个接口` : `已读取 ${numeric(fetched)} 条`);
    }
    else {
        const known = steps.every(p => p.budget != null), total = steps.reduce((n, p) => n + (p.budget || 0), 0), fetched = steps.reduce((n, p) => n + Math.min(state.sources.get(p.kind)?.fetched || 0, p.budget ?? Infinity), 0);
        setProgress('读取正式记录', known && total ? fetched / total : null, known ? `${numeric(fetched)} / ${numeric(total)} 条` : `已读取 ${numeric(fetched)} 条`);
    }
    if (event.gap) {
        const g = event.gap;
        if (!g.connected || g.unresolvedIds?.length || g.unidentifiedMissing) {
            const message = !g.connected ? '新旧记录之间仍有未读取区间' : `新增区间仍缺 ${g.unresolvedIds.length} 个已知 ID${g.restored ? `，已从本地补回 ${g.restored} 条` : ''}${g.unidentifiedMissing ? '；另有无法定位的缺失位置' : ''}`;
            if (!state.gapWarnings.includes(message))
                state.gapWarnings.push(message);
        }
    }
}
function availabilitySources() {
    return [...state.availability].filter(([, a]) => a.missingIds.length || a.scanEmptyPages || a.seekEmptyPages || a.invalidPages || a.unknownEmptyPages || a.anonymousReports);
}
function renderAvailability() {
    $('progress-details').classList.toggle('has-availability', availabilitySources().length > 0);
}
function taskAvailabilityDetails() {
    const sources = availabilitySources();
    if (!sources.length)
        return null;
    const root = node('section', 'task-availability-details'), workspace = state.workspace, formKey = state.cardFormKey;
    root.append(node('h3', '', '记录缺失检测'));
    for (const [kind, a] of sources) {
        const n = a.missingIds.length;
        const box = node('section', 'availability-source');
        const label = modes[internal[kind]] || kind;
        box.setAttribute('aria-label', label);
        box.append(markCommentDirection(node('strong', '', label), kind));
        if (n) {
            box.append(node('p', '', `本次未返回 ${n} 个已知 ID；本地有正文 ${a.locallySavedIds.length} 个，仍缺正文 ${a.missingBodyIds.length} 个。`));
            box.append(button('复制未返回 ID', 'text-button', () => {
                if (workspace === state.workspace && formKey === state.cardFormKey)
                    send({ action: 'copy', text: a.missingIds.join('\n') });
            }));
        }
        if (a.scanEmptyPages || a.seekEmptyPages)
            box.append(node('p', '', `采集空窗 ${a.scanEmptyPages} 个；定位空页 ${a.seekEmptyPages} 个（排除）。`));
        if (a.anonymousReports)
            box.append(node('p', '', '接口另有无法对应 ID 的缺失信息。'));
        if (a.invalidPages || a.unknownEmptyPages)
            box.append(node('p', '', '有边界依据不足的响应，未用于推断缺失。'));
        root.append(box);
    }
    root.append(node('p', 'availability-explainer', '仅分析本次联网正式采集；空窗或未返回不能直接认定为删除。补全正文不代表恢复可见。'));
    return root;
}
function selectUser(uid, report) { ReaderIdentity.selectUser(state, uid); if (state.busy)
    return; state.category = report?.category === 'posts' ? 'posts' : 'users'; $('target').value = uid; state.updateOperation = 'regular'; $('date-range-enabled').checked = !!report?.from; if (report?.mode && internal[report.mode] && report.category !== 'posts')
    $('mode').value = internal[report.mode]; if (report?.count && !report.merged) {
    $('limit').value = report.count;
    $('unlimited').checked = false;
} if (report?.from) {
    $('from').value = report.from;
    $('to').value = report.to;
} $('history-recovery').checked = true; if (report?.database) {
    state.task = 'report';
    $('view-range-enabled').checked = !!report.from;
} state.task = report?.database ? 'report' : 'sync'; if (report?.merged) {
    $('limit').value = '50';
    $('unlimited').checked = false;
} closePicker(); view('create'); updateForm(); $('target').focus(); }
function toggleFavorite(uid) { if (uid)
    send({ action: 'favorite', uid, on: !state.favorites.includes(uid) }); }
function renderFavorites() { const list = $('favorite-list'); list.replaceChildren(); const posts = state.postFavorites || []; $('favorite-count').textContent = state.favorites.length + posts.length; if (!state.favorites.length && !posts.length)
    list.append(node('p', 'favorite-empty', '在用户或博文旁点击 ☆，即可放在这里。')); for (const uid of state.favorites) {
    const u = window.userInfo?.(uid) || state.accounts.find(a => a.uid === uid) || { nickname: '用户 ' + uid };
    const pick = button('', 'favorite-pick', () => openUser(uid));
    pick.dataset.targetKind = 'user';
    pick.dataset.targetId = uid;
    pick.title = [u.nickname, 'UID '+uid].join(' · ');
    pick.append(window.entityAvatar?.('user', uid, 'favorite-avatar') || node('span', 'favorite-avatar', Array.from(u.nickname || '')[0] || '微'), node('span', 'favorite-name', window.ReaderEntityActions?.displayName(u,u.nickname)||u.nickname));
    list.append(pick);
} for (const id of posts) {
    const post = (state.posts || []).find(p => p.postId === id), pick = button('', 'favorite-pick', () => window.openPostPage?.(id)), original = post?.author ? post.author + ' · ' + (post.title || id) : post?.title || '微博 ' + id, label = window.ReaderEntityActions?.displayName(post,original)||original;
    pick.dataset.targetKind = 'post';
    pick.dataset.targetId = id;
    pick.append(window.entityAvatar?.('post', id, 'favorite-avatar') || node('span', 'favorite-avatar', '▤'), node('span', 'favorite-name', label));
    pick.title = original + ' · 微博 ID ' + id;
    list.append(pick);
} }
function renderPicker() {
    const term = $('user-search').value.normalize('NFKC').toLocaleLowerCase().trim(), users = state.accounts.filter(a => (!state.pickerFavorites || state.favorites.includes(a.uid)) && (!term || (a.nickname + ' ' + a.uid).normalize('NFKC').toLocaleLowerCase().includes(term))).sort((a, b) => Number(state.favorites.includes(b.uid)) - Number(state.favorites.includes(a.uid)) || a.nickname.localeCompare(b.nickname, 'zh-CN'));
    const root = $('user-results');
    root.replaceChildren();
    $('picker-empty').hidden = users.length > 0;
    for (const user of users) {
        const row = node('div', 'user-option'), select = button('', 'user-option-pick', () => selectUser(user.uid));
        select.setAttribute('role', 'option');
        select.append(node('strong', '', user.nickname), node('span', '', user.uid));
        const star = button(state.favorites.includes(user.uid) ? '★' : '☆', 'user-star', () => toggleFavorite(user.uid));
        star.classList.toggle('selected', state.favorites.includes(user.uid));
        star.setAttribute('aria-label', (state.favorites.includes(user.uid) ? '取消特别关注' : '特别关注') + user.nickname);
        row.append(select, star);
        root.append(row);
    }
}
function closePicker() { $('user-popover').hidden = true; $('choose-user').setAttribute('aria-expanded', 'false'); }
function openPicker() { $('user-popover').hidden = false; $('choose-user').setAttribute('aria-expanded', 'true'); renderPicker(); $('user-search').focus(); }
function dateText(time) { return ReaderDates.displayMinute(time); }
function reportRow(report, primary = false) { const row = node('div', 'version-row' + (primary ? ' primary-version' : '')), info = node('div', 'version-info'); info.append(node('strong', '', report.merged ? '互动总报告' : (report.category === 'post-comments' ? '评论 · ' : report.category === 'posts' ? '微博 · ' : '互动 · ') + (report.count == null ? '记录数量未识别' : numeric(report.count) + ' 条') + (report.partial ? ' · 未完成' : '')), node('span', '', dateText(report.modified) + ' · ' + (report.size > 1048576 ? (report.size / 1048576).toFixed(1) + ' MB' : Math.ceil(report.size / 1024) + ' KB'))); if (report.from || report.before)
    info.append(node('span', '', report.scope || report.from + ' — ' + report.to)); info.append(timeSpan(report.modified)); info.title = report.name; row.append(info, button('打开报告 ↗', primary ? 'button primary' : 'button secondary', () => readReport(report.id)), button('打开文件夹', 'button secondary', () => openReport(report.id, 'folder'))); return row; }
function renderLibrary() { window.renderContextReports?.(); }
function completeSync() { const data = state.summary; if (currentUser() && data.uid !== currentUser() || state.selection?.kind === 'post' && (data.mode !== 'post-comments' || ReaderUX.postId(currentTarget()) !== data.target)) {
    $('ready-shortcut').hidden = true;
    $('ready-shortcut').textContent = '其他用户的数据已保存 · 查看 ↗';
    return;
} state.database = [data, ...state.database.filter(e => !(e.target === data.target && e.mode === data.mode && e.category === data.category))]; $('completion-banner').hidden = true; $('ready-shortcut').hidden = true; $('completion-new').hidden = true; $('completion-read').textContent = '查看数据'; $('completion-title').textContent = data.incomplete ? '数据已保存，范围尚未完成' : '数据已更新'; $('completion-meta').textContent = '本次覆盖 ' + numeric(data.records) + ' 条 · 本地复用 ' + numeric(data.reusedRecords) + ' 条 · 新保存 ' + numeric(data.addedRecords) + ' 条 · 接口返回 ' + numeric(data.newRecords) + ' 条 · ' + ReaderDates.label(data.from,data.to,'最新更新') + ' · ' + dateText(Date.parse(data.updatedAt)); $('completion-banner').classList.toggle('completion-warning', !!data.incomplete); $('current-reports').replaceChildren(node('span', '', data.incomplete ? '未读完的范围已保留；报告只含实际取得的数据。' : '数据已保存；可按需要选择报告内容和条数。')); $('ready-shortcut').textContent = '资料已更新 · 生成报告 ↗'; $('continue-update').hidden = !state.continuation; }
function prepareReport() { setTask('report'); view('create'); updateForm(); $('local-results').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
function complete(reports, options = {}) {
    $('completion-new').hidden = true;
    $('completion-read').textContent = '阅读这份报告';
    state.currentReports = [...new Set(reports)];
    $('completion-banner').hidden = !state.currentReports.length;
    $('ready-shortcut').hidden = !state.currentReports.length;
    $('current-reports').replaceChildren();
    $('continue-update').hidden = !state.continuation || !state.lastTaskId;
    const partial = !!options.partial || state.gapWarnings.length > 0;
    $('completion-banner').classList.toggle('completion-warning', partial);
    $('completion-title').textContent = options.merge ? '互动总报告已整理完成' : state.continuation ? '已保存本次结果，可继续读取' : partial ? '报告已保存，请留意缺失提示' : state.policy === 'update' && state.summary?.newRecords === 0 ? '没有新增返回，已生成本地报告' : '报告已生成，可以开始阅读';
    $('ready-shortcut').textContent = partial ? '结果已保存 · 查看报告 ↗' : '报告已就绪 · 立即阅读 ↗';
    const s = state.summary;
    $('completion-meta').textContent = options.merge ? `合并 ${options.sourceCount} 份报告，去重后 ${numeric(options.count)} 条 · 本地完成，新增取数费用 0` : (s ? `${state.lastQuery?.policy === 'database' ? '本地范围 ' + ReaderDates.label(state.lastQuery.from,state.lastQuery.to,'全部已保存日期') : state.lastQuery?.before ? '截至 ' + state.lastQuery.before : '本次报告'}${s.records != null ? ' · 实际导出 ' + numeric(s.records) + ' 条' : ''}${state.lastQuery && !state.lastQuery.unlimited ? '（请求上限 ' + numeric(Number(state.lastQuery.limit)) + ' 条）' : ''} · 新返回 ${s.newRecords} 条 · API ${s.apiCalls} 次 · 缓存 ${s.cachedCalls} 次` : '已保存在本机') + (state.gapWarnings.length ? ' · ' + state.gapWarnings.join('；') : '');
    for (const id of state.currentReports) {
        const r = state.reports.find(r => r.id === id), entry = node('div', 'completion-report');
        entry.append(node('span', '', r?.merged ? '互动总报告' : id.split('/').at(-1).replace(/\.html$/, '')), button('所在文件夹', 'text-button', () => openReport(id, 'folder')));
        $('current-reports').append(entry);
    }
    if (state.view === 'create')
        $('completion-banner').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function start(preview) {
    if (state.engineAvailable === false) {
        toast('运行引擎已停止，请重新打开应用后重试。', true);
        return;
    }
    if (state.task === 'report') {
        exportLocal();
        return;
    }
    if (state.busy || state.starting)
        return;
    $('form-error').hidden = true;
    all('[aria-invalid=true]').forEach(el => el.removeAttribute('aria-invalid'));
    const input = query(preview);
    let error = ReaderUX.validate(input);
    if (error) {
        $('form-error').textContent = error.message;
        $('form-error').hidden = false;
        window.ReaderNotices?.decorate($('form-error'), {key: 'validation:' + crypto.randomUUID()});
        const field = $(error.field);
        field.setAttribute('aria-invalid', 'true');
        const advanced = field.closest('details');
        if (advanced)
            advanced.open = true;
        field.focus();
        field.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
    }
    state.cardFormKey = ReaderDataQuery.key(input);
    state.progressQuery = JSON.parse(JSON.stringify(input));
    const requestId = crypto.randomUUID();
    if (!taskEvents.begin(requestId, input))
        return;
    resetTaskCard(input);
    renderTaskParameters(input);
    state.gapWarnings = [];
    state.sources.clear();
    state.availability.clear();
    state.continuation = false;
    state.returnLimited = false;
    state.lastQuery = JSON.parse(JSON.stringify(input));
    state.jobBalance = state.displayBalance;
    renderAvailability();
    state.plan = [];
    state.summary = null;
    setBusy(true);
    setProgress('正在准备', null, '');
    send({ action: 'run', requestId, query: input });
}
window.weiboReceive = function (event) {
    if(window.ReaderFeedback?.receive(event))return;
    const keepHome=event.type==='library'&&retainsHomeSnapshot(event);
    if (!workspaceChannel.accept(event)) return;
    if (window.ReaderEntityActions?.resumeReceive(event)) return;
    if (window.dataExchangeReceive?.(event)) return;
    if (event.type==='engineStopped'||event.type==='engineTransportError'){homeSnapshots.reset();historySnapshots.reset();}
    if (event.type==='presentationSnapshotPart') {
        if (state.workspace&&event.workspace===state.workspace&&!state.homeBlocked&&event.bootstrapId===state.bootstrapId){
            if(event.snapshotType!=='updateHistory')homeSnapshots.receive(event);
            else if(ownsHistory(event,true))historySnapshots.receive(event);
        }
        return;
    }
    if (!homeLoadEvent(event,keepHome)) return;
    if(window.postAuthorAvatarReceive?.(event))return;
    if(event.type==='foregroundRejected'){toast(event.message||'这次操作未被接受，请稍后重试。',true);return;}
    if (event.type === 'quitting') {
        if (!$('quit-progress')) {
            const dialog=node('dialog','quit-progress');dialog.id='quit-progress';dialog.setAttribute('aria-labelledby','quit-progress-title');dialog.setAttribute('aria-describedby','quit-progress-message');
            const title=node('h2','','正在保存并退出');title.id='quit-progress-title';
            const message=node('p','',event.message||'当前响应保存完成后将自动退出，请稍候。');message.id='quit-progress-message';
            dialog.append(title,message);dialog.addEventListener('cancel',e=>e.preventDefault());document.body.append(dialog);dialog.showModal();
        }
        return;
    }
    if(event.type==='reportReadFailed'){toast(event.message,true);return;}
    if(event.type==='libraryState'){window.subscriptionReceive?.(event);window.followReceive?.(event);return;}
    if(event.type==='libraryData'){state.database=event.database||[];state.reports=event.reports||[];window.renderContextReports?.();if(state.task==='report'&&state.view==='create')scheduleLocal();return;}
    if(window.ReaderRecovery?.receive(event))return;
    if(event.type!=='library')window.ReaderInsights?.receive(event);
    if(event.type==='homeAvatars'){
        const changed=new Set(ReaderHomeAssets.apply(state,event));
        for(const box of document.querySelectorAll('[data-avatar-uid]'))if(changed.has(box.dataset.avatarUid)){
            const uid=box.dataset.avatarUid,info=state.homeUsers?.find(u=>u.uid===uid)||state.postAuthors?.[uid];
            if(info&&window.userAvatar){const fresh=window.userAvatar(info);box.replaceChildren(...fresh.childNodes);}
        }
        if(changed.has(ReaderIdentity.user(state)))window.renderUserProfile?.();
        return;
    }
    if(['homeUsers','postsHome'].includes(event.type))event=ReaderHomeAssets.snapshot(state,event);
    if(event.type==='inventoryRepair'){if(entityStatus.repair(event,state.workspace)){renderTaskActivity();renderRecentTaskCard();}return;}
    if(['localInventory','localInventoryError'].includes(event.type)){
        if(entityStatus.receive(event,state.workspace))renderEntityInventory();
        return;
    }
    if(['library','homeUsers','postsHome'].includes(event.type)){
        entityStatus.invalidate();queueMicrotask(()=>renderTaskActivity());
    }
    if(window.ReaderEntityActions?.gapChoiceReceive?.(event))return;
    const ownership = taskEvents.route(event);
    if (ownership.route === 'drop')
        return;
    if (serviceLoginEvent(event, ownership)) return;
    if (['account', 'accountError', 'accountLoading'].includes(event.type)) {
        if (!state.serviceWorkspaceAccepted) return;
        const request = state.serviceAccountRequest, active = taskEvents.snapshot();
        if(state.serviceLoggedOut&&!request)return;
        if (event.requestId ? !(request?.requestId === event.requestId && serviceScope.owns(request, event)) && !(active.requestId === event.requestId && !!active.query) : !!request)
            return;
    }
    if (ownership.route === 'automatic') {
        if (window.followReceive)
            window.followReceive(event);
        else
            (window.followQueue ||= []).push(event);
        return;
    }
    if (ownership.route === 'task' && ownership.task?.query) {
        state.progressQuery = ownership.task.query;
        taskActivity.receive(event, ownership.task.query, state.workspace);
        if(event.type==='started')entityStatus.begin(ownership.task.query,state.workspace);
        if(event.type==='finished'&&event.kind==='collect'&&!event.preview&&!ownership.task.query.preview){
            entityStatus.complete(ownership.task.query,state.workspace,event.taskId||event.id);
            entityStatus.invalidate();
        }
        renderTaskActivity();
    }
    if (event.type === 'userDeleted' && window.userDeletionReceiptAccepted && !window.userDeletionReceiptAccepted(event)) return;
    if (event.type === 'userDeleted')
        entityStatus.forget({target:event.uid,mode:'comments-both'},state.workspace);
    if (event.type === 'postDeleted')
        entityStatus.forget({target:event.postId,mode:'post-comments'},state.workspace);
    if (event.type === 'userDeleted')
        taskActivity.forget({ target: event.uid, mode: 'comments-both' }, state.workspace);
    if (event.type === 'postDeleted')
        taskActivity.forget({ target: event.postId, mode: 'post-comments' }, state.workspace);
    if(event.type==='userDeleted'||event.type==='postDeleted')ownerUnread.delete(event.type==='userDeleted'?'user:'+event.uid:'post:'+event.postId);
    if(['homeUsers','postsHome','followState','reportMarkedRead'].includes(event.type)){
        const changed=syncOwnerUnread(event);
        if(changed.size){
            if(event.type!=='homeUsers'&&[...changed].some(key=>key.startsWith('user:')))window.renderUserHome?.();
            if(event.type!=='postsHome'&&[...changed].some(key=>key.startsWith('post:')))window.renderPostHome?.();
        }
        if(event.type==='reportMarkedRead')event={...event,readingChanged:changed.size>0};
    }
    if (event.type === 'followState')
        state.subscriptions = event.entries || [];
    if (event.type === 'postsHome') {
        state.posts = event.posts || [];
        state.postAuthors = event.authors || {};
    }
    window.priceReferenceReceive?.(event);
    window.subscriptionReceive?.(event);
    window.managementReceive?.(event);
    window.postCenterReceive?.(event);
    window.userManagementReceive?.(event);
    window.userCenterReceive?.(event);
    if(['homeUsers','postsHome'].includes(event.type)&&state.view==='history'&&state.historyRequest){
        const {targetKind,target}=state.historyRequest;
        window.ReaderEntityActions?.renderHistoryContinuations(targetKind,target);
    }
    if (event.type === 'homeUsers'){noteStartupList();return;}
    if (event.type === 'userAdded')
        return;
    if (['followState', 'followError', 'followConfigured', 'userDeleted', 'postDeleted'].includes(event.type)) {
        if (window.followReceive)
            window.followReceive(event);
        else
            (window.followQueue ||= []).push(event);
        return;
    }
    if (handleReportEvent(event))
        return;
    switch (event.type) {
        case 'taskAlreadyConnected':
            taskActivity.resolvePending(event.id, state.workspace);
            setBusy();
            state.progressQuery = null;
            resetTaskCard(query());
            updateForm();
            toast('原新增区间已由另一轮完整接通，可直接查看本地数据。');
            break;
        case 'library': {
            if (event.version)
                $('app-version').textContent = event.version;
            window.followReceive?.(event);
            if(!event.partial||Object.hasOwn(event,'database'))state.database = event.database || [];
            if (event.reportKeep === null)
                $('report-keep').value = 'all';
            else if ([1].includes(event.reportKeep))
                $('report-keep').value = String(event.reportKeep);
            else if (event.reportKeep) {
                $('report-keep').value = 'custom';
                $('report-keep-custom').value = event.reportKeep;
                $('report-keep-custom').hidden = false;
            }
            const serviceWorkspaceChanged = serviceScope.observe(event);
            if (serviceWorkspaceChanged) {
                if (state.serviceLogin) taskEvents.forget(state.serviceLogin.requestId);
                state.serviceLogin = null; state.serviceAccountRequest = null;
                state.balanceQueryState = 'idle'; $('refresh-balance').disabled = false;
                topBalance(state.displayBalance ?? null, state.displayBalance == null ? '' : '上次显示值', '尚未查询');
                $('check-account').disabled = false; renderServiceLogin();
                window.ReaderNotices?.reset($('account-info'));
                $('account-info').hidden = false;
                $('account-info').textContent = '尚未查询账户信息。查询余额不会读取微博内容。';
                window.ReaderSettingsStatus?.serviceAccount(null, 'reset');
            }
            workspaceChannel.library(event);
            state.serviceWorkspaceAccepted = true;
            if (serviceWorkspaceChanged) setBusy();
            window.ReaderInsights?.receive(event);
            state.accounts = event.accounts || [];
            if(!event.partial||Object.hasOwn(event,'reports'))state.reports = event.reports || [];
            state.favorites = event.favorites || [];
            state.postFavorites = event.postFavorites || [];
            $('workspace-path').textContent = state.workspace;
            renderFavorites();
            if(!keepHome||!state.homeLoading.users.snapshot)window.renderUserHome?.();
            noteStartupList();
            if(!keepHome||!state.homeLoading.posts.snapshot)window.renderPostHome?.();
            renderLibrary();
            if (!$('user-popover').hidden)
                renderPicker();
            if (!state.busy)
                updateForm();
            if (!window.weiboSmoke && !state.accountStartupRequested) {
                state.accountStartupRequested = true;
                send({ action: 'account' });
            }
            break;
        }
        case 'accountLoading':
            $('refresh-balance').disabled = event.loading !== false;
            $('check-account').disabled = event.loading !== false;
            if (event.loading !== false) {
                state.balanceQueryState = 'loading';
                window.ReaderSettingsStatus?.serviceAccount(state.account, 'loading');
                topBalance(state.displayBalance ?? null, state.displayBalance == null ? '' : '查询中…', '查询中…');
            } else if (state.balanceQueryState === 'loading') {
                state.balanceQueryState = 'idle';
                window.ReaderSettingsStatus?.serviceAccount(state.account, 'idle');
                topBalance(state.displayBalance ?? null, state.displayBalance == null ? '' : '上次显示值', '尚未查询');
            }
            break;
        case 'account':
            window.ReaderNotices?.reset($('account-info'));
            $('account-info').hidden = false;
            state.account = event;
            state.serviceLoggedOut=false;
            state.balanceQueryState = 'ready';
            $('service-logout').disabled=state.busy;
            topBalance(event.balance, event.balance == null ? '' : '已核实', '余额未返回');
            $('balance-login').hidden = true;
            $('account-info').textContent = serviceAccountText(event);
            window.ReaderSettingsStatus?.serviceAccount(event, 'ready');
            if (state.serviceLogin && state.serviceLogin.requestId === state.serviceAccountRequest?.loginRequestId) {
                state.serviceLogin.heading = '已登录'; state.serviceLogin.message = '服务账户已核实，未读取微博内容。'; renderServiceLogin();
            }
            break;
        case 'accountError':
            state.balanceQueryState = 'error';
            $('service-logout').disabled=state.busy||state.serviceLoggedOut===true;
            topBalance(event.authenticationNeeded ? null : state.displayBalance ?? null, !event.authenticationNeeded && state.displayBalance != null ? '查询失败 · 上次显示值' : '', event.authenticationNeeded ? '未登录' : '查询失败');
            $('balance-login').hidden = !event.authenticationNeeded;
            $('account-info').textContent = event.message;
            $('account-info').hidden = false;
            window.ReaderSettingsStatus?.serviceAccount(null, 'error');
            window.ReaderNotices?.decorate($('account-info'), {scope: state.workspace + '|service-account', key: event.requestId || crypto.randomUUID()});
            if (state.serviceLogin && state.serviceLogin.requestId === state.serviceAccountRequest?.loginRequestId) {
                state.serviceLogin.heading = event.authenticationNeeded ? '登录未核实' : '授权已完成 · 账户暂未核实';
                state.serviceLogin.message = event.authenticationNeeded ? '服务尚未确认登录，请重新授权；未读取微博内容。' : '账户查询未完成，可单独重试查询；未读取微博内容。'; renderServiceLogin();
            }
            break;
        case 'manualQueued':
            setBusy();
            setProgress('等待当前自动请求保存', null, '手动任务优先');
            $('progress-message').textContent = '已暂停后续自动请求；当前响应保存后立即执行手动任务。';
            break;
        case 'preparing':
            setBusy();
            setProgress('检查登录授权', null, '免费查询');
            $('progress-message').textContent = '正在检查登录授权，不读取微博内容。';
            break;
        case 'started':
            if (!state.busy && !state.starting)
                resetTaskCard(query());
            state.lastTaskId = event.taskId || event.id;
            state.jobKind = event.kind;
            setBusy();
            status(event.kind === 'collect' ? (event.query?.preview ? '检查中' : '读取中') : '登录中', 'running');
            if (event.kind === 'collect') {
                renderTaskActivity();
                state.currentReports = [];
                $('completion-banner').hidden = true;
                $('ready-shortcut').hidden = true;
                $('cost').textContent = '—';
                $('returned').textContent = '—';
                renderTaskParameters(event.query);
                renderLiveAdded(0);
                $('progress-message').textContent = event.query.preview ? '只检查参数，不联网取数。' : '正在读取数据…';
                setProgress('准备读取', 0, '');
            }
            else
                $('progress-message').textContent = '请在浏览器完成登录授权。';
            break;
        case 'plan':
            state.plan = event.sources || [];
            break;
        case 'collection':
            collection(event);
            break;
        case 'phase':
            setProgress(event.message || '生成报告', null, '');
            $('progress-message').textContent = event.message || '正在生成报告…';
            break;
        case 'progress':
            if (event.message != null) $('progress-message').textContent = event.message;
            renderLiveAdded(event.addedRecords);
            break;
        case 'log':
            log(event.message, ownership.task?.query);
            break;
        case 'credits':
            credits(event);
            break;
        case 'summary':
            state.summary = event;
            renderReturned(event);
            if (event.persistence?.coreSaved) renderLiveAdded(event.addedRecords);
            $('progress-message').textContent = event.syncOnly ? '数据已保存，正在完成本次更新…' : event.incomplete ? '本次记录已保存，读取范围尚未完成。' : '数据已取得，正在整理报告…';
            break;
        case 'source':
            if (event.availability) {
                state.availability.set(event.kind, event.availability);
                const a = event.availability;
                if (a.missingIds.length && (!event.update?.gap || a.locallySavedIds.length || a.knownNotReturnedIds.length)) {
                    const message = (modes[internal[event.kind]] || event.kind) + '：' + a.missingIds.length + ' 个 ID 本次未返回（本地有正文 ' + a.locallySavedIds.length + ' 个）';
                    if (!state.gapWarnings.includes(message))
                        state.gapWarnings.push(message);
                }
                renderAvailability();
            }
            if (ReaderAcquisitionFeedback.hasContinuation(event))
                state.continuation = true;
            if (event.update?.pending && !event.update.caughtUp)
                state.returnLimited = state.returnLimited || !!event.update.limited;
            if (event.update?.gap)
                collection({ kind: event.kind, phase: 'update', fetched: event.fetched, budget: event.budget, done: true, partial: event.incomplete, newReturned: event.update.newReturned, returnLimit: event.update.returnLimit, gap: event.update.gap });
            if (event.incomplete)
                log(event.reason, ownership.task?.query);
            break;
        case 'report':
            if (event.auxiliary)
                break;
            if (!state.currentReports.includes(event.id))
                state.currentReports.push(event.id);
            break;
        case 'copied':
            toast(event.success ? '已复制到剪贴板' : '复制失败：内容过长或剪贴板暂不可用。', !event.success);
            break;
        case 'stopping':
            status('停止中', 'warning');
            $('stop').disabled = true;
            $('progress-stage').textContent = '正在保存当前响应';
            $('progress-message').textContent = '不再发起后续请求；当前请求返回后保存数据和位置。';
            break;
        case 'finished':
            if (event.kind === 'account')
                break;
            const ownsCard = taskMatchesForm(ownership.task?.query || state.progressQuery || state.lastQuery);
            state.finishingTask = true;
            setBusy();
            state.finishingTask = false;
            $('task-card').classList.remove('is-acquiring');
            $('stop').disabled = false;
            if (!ownsCard && event.kind === 'collect') {
                state.progressQuery = null;
                resetTaskCard(query());
                updateForm();
                break;
            }
            state.cardFormKey = ReaderDataQuery.key(query());
            if (event.cancelled || state.summary?.cancelled) {
                if (state.summary?.syncOnly)
                    completeSync();
                status('已中断', 'warning');
                setProgress('已停止', null, '');
                $('progress-track').hidden = true;
                $('progress-message').textContent = event.preparation ? '已取消准备；本次尚未开始取数。' : '已保存 ' + numeric(state.summary?.addedRecords ?? state.summary?.records ?? 0) + ' 条本次数据；正文、原始响应和未完成位置保留，可继续读取。';
                if (!event.preparation && !state.summary?.syncOnly && state.credits) {
                    state.credits.unknownRequests = Math.max(1, state.credits.unknownRequests || 0);
                    credits(state.credits);
                }
            }
            else if (event.code !== 0) {
                status(state.summary?.syncOnly ? '已保存 · 读取中断' : '未完成', state.summary?.syncOnly ? 'warning' : 'error');
                if (state.summary?.syncOnly)
                    completeSync();
                $('progress-stage').textContent = '读取中断';
                $('progress-track').hidden = true;
                $('progress-message').textContent = state.summary?.syncOnly ? '已返回数据已保存；读取中断，正文与续读位置保留。请查看运行详情。' : '读取中断，旧检查点和已有记录保留。请查看运行详情。';
                $('log-area').hidden = false;
                $('toggle-log').setAttribute('aria-expanded', 'true');
                if (event.reports?.length)
                    complete(event.reports, { partial: true });
            }
            else if (event.preview) {
                status('设置有效', 'success');
                setProgress('参数检查通过', 1, '未联网取数');
                $('cost').textContent = '0';
                $('progress-message').textContent = state.summary?.database ? '按当前设置可导出 ' + numeric(state.summary.records) + ' 条；生成报告不新增 credits。' : '检查通过，点击开始后才执行读取。';
            }
            else if (event.kind === 'collect' && state.summary?.syncOnly) {
                const warning = event.partial || event.coreFailed || event.partialFailures?.length;
                status(event.coreFailed ? '已保存 · 后续处理待完成' : event.partial ? '已保存 · 未完成' : warning ? '已更新 · 有提示' : '已更新', warning ? 'warning' : 'success');
                setProgress(warning ? '本次数据已保存' : '数据更新完成', warning ? null : 1, '');
                if (warning)
                    $('progress-track').hidden = true;
                $('progress-message').textContent = state.continuation ? '更新位置已保存，可以继续读取；也可先用已有数据生成报告。' : '数据已更新。生成报告是独立的本地操作，不新增 credits。';
                completeSync();
            }
            else if (event.kind === 'collect') {
                const warning = event.partial || event.coreFailed || event.partialFailures?.length || state.gapWarnings.length;
                status(state.continuation ? (state.returnLimited ? '已达上限 · 可继续' : '未读完 · 可继续') : warning ? '已保存 · 有提示' : '已完成', warning ? 'warning' : 'success');
                setProgress(warning ? '已保存当前结果' : '报告生成完成', warning ? null : 1, warning ? '请留意未完成区间' : '100%');
                $('progress-message').textContent = state.continuation ? '续取位置已保存；继续读取会沿用本次设置和取数上限。' : warning ? (state.summary?.reason || '已保存当前结果；请查看运行详情中的未完成原因。') : '报告已生成，可使用默认浏览器打开。';
                if (warning)
                    $('progress-track').hidden = true;
                complete(event.reports || state.currentReports, { partial: warning });
                if (!state.currentReports.length)
                    $('progress-message').textContent = '本次没有可导出的记录；可调整范围或先获取数据。';
                else if (state.autoRead) {
                    state.autoRead = false;
                    readReport(state.currentReports[0]);
                }
            }
            else {
                status('已登录', 'success');
                send({ action: 'account' });
            }
            if (event.partialFailures?.length) {
                for (const issue of event.partialFailures)
                    log((issue.stage || '后续处理') + '：' + issue.message, ownership.task?.query);
                $('progress-message').textContent += (event.coreFailed ? ' 必要的后续处理未完成，恢复证据保留。' : ' 部分后续处理未完成，已保存正文不受影响。');
            }
            state.progressQuery = null;
            syncProgressMotion();
            const recentRendered = renderRecentTaskCard(query());
            if (!recentRendered && (event.code != null && event.code !== 0 || event.cancelled || event.partial || event.coreFailed || event.partialFailures?.length)) window.ReaderNotices?.decorate($('progress-message'), {key: event.taskId || event.id});
            break;
        case 'updateHistory':
            if(!ownsHistory(event))break;
            renderHistory(event.records || []);
            break;
        case 'updateHistoryError':
            if(ownsHistory(event,true)){
                const {target,mode}=state.historyRequest;
                $('history-rows').replaceChildren(node('p','field-hint',event.message),button('重试读取','button secondary',()=>showHistory(target,mode)));
            }
            break;
        case 'cleanup':
            $('cleanup-result').textContent = '已清理 ' + event.removed + ' 份旧 HTML' + (event.skipped ? '；' + event.skipped + ' 份原文未确认保留，未删除' : '') + '。原始数据与续读进度保留。';
            if (event.removed)
                toast('已清理 ' + event.removed + ' 份旧报告，数据保留');
            break;
        case 'retentionSaved':
            toast('报告清理设置已保存');
            break;
        case 'engineTransportError':
        case 'engineStopped':
            state.finishingTask = true;
            setBusy();
            state.finishingTask = false;
            $('task-card').classList.remove('is-acquiring');
            state.progressQuery = null;
            state.runningQuery = null;
            state.runningId = null;
            $('running-owner').hidden = true;
            $('stop').disabled = false;
            status('运行已中断', 'warning');
            $('progress-track').hidden = true;
            $('progress-message').textContent = '运行引擎已停止；已保存的数据、报告和续读证据保留，请重新打开应用。';
            window.ReaderNotices?.decorate($('progress-message'), {key: event.type});
            toast(event.message || '运行引擎已停止', true);
            break;
        case 'error':
            if (ownership.release) {
                state.finishingTask = true;
                setBusy();
                state.finishingTask = false;
                syncProgressMotion();
            }
            if (ownership.route === 'task' && ownership.task?.query && !taskMatchesForm(ownership.task.query)) {
                log(event.message, ownership.task?.query);
                toast('原获取任务：' + event.message, true);
                break;
            }
            $('form-error').textContent = event.message;
            $('form-error').hidden = false;
            window.ReaderNotices?.decorate($('form-error'), {key: event.taskId || event.requestId || crypto.randomUUID()});
            log(event.message, ownership.task?.query);
            toast(event.message, true);
            if (event.needsLogin) {
                $('balance-login').hidden = false;
                topBalance(null, '', '未登录');
                status('需要登录', 'warning');
                $('progress-stage').textContent = '尚未开始取数';
                $('progress-track').hidden = true;
            }
            else if (ownership.release) {
                status('未开始', 'warning');
                $('progress-stage').textContent = '准备未完成';
                $('progress-track').hidden = true;
                $('progress-message').textContent = '本次未启动取数；请检查设置后重试。';
            }
            if (ownership.release)
                state.progressQuery = null;
            break;
    }
};
all('[data-view]').forEach(el => el.addEventListener('click', () => view(el.dataset.view)));
all('[data-category]').forEach(el => el.addEventListener('click', () => { rememberFilters(); const category = el.dataset.category; if (category === 'post') {
    window.openPost?.();
    return;
} if (!currentUser()) {
    view('home');
    toast('请先从用户列表选择用户');
    return;
} state.category = category; closePicker(); updateForm(); }));
all('[data-task]').forEach(el => el.addEventListener('click', () => setTask(el.dataset.task)));
$('quick-check').addEventListener('click', quickCheck);
all('#query-form input,#query-form select').forEach(el => el.addEventListener('input', updateForm));
$('target').addEventListener('input', () => { if (state.category === 'post') {
    ReaderIdentity.selectPost(state, $('target').value);
    updateForm();
} });
let formComposing=false;
$('query-form').addEventListener('compositionstart',()=>{formComposing=true;});
$('query-form').addEventListener('compositionend',()=>{formComposing=false;});
$('query-form').addEventListener('keydown',e=>{if(e.key==='Enter'&&(formComposing||e.isComposing||e.keyCode===229))e.preventDefault();});
$('query-form').addEventListener('submit', e => { e.preventDefault(); if(!formComposing)start(false); });
$('start').addEventListener('click', () => start(false));
$('preview').addEventListener('click', () => start(true));
$('stop').addEventListener('click', () => send({ action: 'stop' }));
$('service-login-cancel').addEventListener('click', () => { if (!serviceLoginBusy()) return; state.serviceLogin.cancelling = true; state.serviceLogin.heading = '正在取消登录'; state.serviceLogin.message = '正在等待登录进程退出，不会开始读取微博内容。'; renderServiceLogin(); send({ action: 'loginCancel', requestId: state.serviceLogin.requestId }); });
$('choose-user').addEventListener('click', () => { $('user-popover').hidden ? openPicker() : closePicker(); });
$('user-search').addEventListener('input', renderPicker);
$('picker-all').addEventListener('click', () => { state.pickerFavorites = false; $('picker-all').classList.add('active'); $('picker-favorites').classList.remove('active'); renderPicker(); });
$('picker-favorites').addEventListener('click', () => { state.pickerFavorites = true; $('picker-favorites').classList.add('active'); $('picker-all').classList.remove('active'); renderPicker(); });
$('favorite-target').addEventListener('click', () => toggleFavorite(currentUser()));
$('user-popover').addEventListener('keydown', event => { if (event.key === 'Escape') {
    closePicker();
    $('choose-user').focus();
    return;
} const picks = all('.user-option-pick'); if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const i = picks.indexOf(document.activeElement), next = event.key === 'ArrowDown' ? Math.min(picks.length - 1, i + 1) : Math.max(0, i - 1);
    picks[next]?.focus();
} if (event.key === 'Enter' && document.activeElement === $('user-search')) {
    event.preventDefault();
    picks[0]?.click();
} });
document.addEventListener('click', e => { if (!e.target.closest('.user-chooser'))
    closePicker(); });
$('service-website').addEventListener('click', () => send({ action: 'external', url: 'https://open.weibo.com/cli/plan' }));
for (const id of ['open-output', 'settings-open-output'])
    $(id).addEventListener('click', () => send({ action: 'output' }));
for (const id of ['login', 'balance-login'])
    $(id).addEventListener('click', () => send({ action: 'login' }));
$('service-logout').addEventListener('click', () => send({ action: 'logout' }));
for (const id of ['check-account', 'refresh-balance'])
    $(id).addEventListener('click', () => send({ action: 'account' }));
$('choose-workspace').addEventListener('click', () => send({ action: 'chooseWorkspace' }));
$('toggle-log').addEventListener('click', () => { const hidden = !$('log-area').hidden; $('log-area').hidden = hidden; $('toggle-log').setAttribute('aria-expanded', String(!hidden)); });
$('copy-log').addEventListener('click', () => send({ action: 'copy', text: state.logs.join('\n') }));
for (const id of ['completion-read', 'ready-shortcut'])
    $(id).addEventListener('click', () => { if (state.summary?.syncOnly) {
        if (state.summary.mode === 'post-comments')
            window.openPostPage?.(state.summary.target);
        else if (window.openUser)
            openUser(state.summary.uid);
        else
            prepareReport(false);
    }
    else if (state.currentReports[0])
        readReport(state.currentReports[0]); });
$('completion-new').addEventListener('click', () => prepareReport(true));
$('completion-library').addEventListener('click', () => { view('create'); $('context-reports').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
$('from').value = '';
$('to').value = '';
try {
    const saved = JSON.parse(localStorage.getItem('weibo-reader-query') || 'null');
    if (saved) {
        if (['users', 'post', 'posts'].includes(saved.category))
            state.category = saved.category;
        state.task = ReaderDataQuery.task(saved.task, saved.policy);
        for (const [key, id] of Object.entries({ target: 'target', limit: 'limit', pages: 'pages', pageSize: 'page-size', from: 'from', to: 'to', seekLimit: 'seek-limit', emptyWindowLimit: 'empty-limit' }))
            if (typeof saved[key] === 'string' && saved[key])
                $(id).value = saved[key];
        $('mode').value = ReaderIdentity.desktopMode(saved.mode);
        if (state.category === 'post')
            ReaderIdentity.selectPost(state, saved.target || '');
        else if (uidOf(saved.target))
            ReaderIdentity.selectUser(state, saved.target);
        state.updateOperation = 'regular';
        $('date-range-enabled').checked = !!saved.dateRange || saved.syncRange === 'range';
        if (saved.returnBudget)
            $('return-budget').value = saved.returnBudget;
        if (saved.localViewVersion && saved.filtersByUser)
            state.filtersByUser = ReaderDataQuery.dateDrafts(saved);
        if (!(saved.unreadDefaultVersion >= 1))
            for (const drafts of Object.values(state.filtersByUser || {}))
                if (drafts.report) drafts.report.markUnread = true;
        if (saved.taskDrafts)
            for (const task of ['sync', 'report']) {
                const d = saved.taskDrafts[task];
                if ((task === 'sync' || saved.localViewVersion) && d && Number.isSafeInteger(Number(d.limit)) && Number(d.limit) > 0)
                    state.taskDrafts[task] = { limit: String(d.limit), unlimited: !!d.unlimited };
            }
        if (state.task === 'report' && !saved.localViewVersion)
            $('limit').value = '200';
        $('unlimited').checked = !!saved.task && !!saved.unlimited;
        state.taskDrafts[state.task] = { limit: $('limit').value, unlimited: $('unlimited').checked };
    }
}
catch { }
updateForm();
send({ action: 'ready' });
$('active-task').addEventListener('click', () => view(serviceLoginBusy() ? 'settings' : 'create'));
$('continue-update').addEventListener('click', () => { const id = $('continue-update').dataset.taskId || state.lastTaskId; if (id)
    ReaderEntityActions.resumeTask(id); });
$('target').addEventListener('blur', () => { $('target').value = currentTarget(); updateForm(); });
document.addEventListener('keydown', e => { if (e.isComposing)
    return; if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && state.view === 'create') {
    e.preventDefault();
    start(false);
}
else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !state.busy) {
    e.preventDefault();
    if (window.userSearch)
        userSearch();
    else {
        view('create');
        document.querySelector('[data-category=users]').click();
        openPicker();
    }
} });
$('report-keep').addEventListener('change', () => { $('report-keep-custom').hidden = $('report-keep').value !== 'custom'; });
$('save-retention').addEventListener('click', () => { const value = $('report-keep').value, keep = value === 'all' ? null : Number(value === 'custom' ? $('report-keep-custom').value : value); if (keep !== null && (!Number.isSafeInteger(keep) || keep < 1)) {
    toast('请填写正整数保留份数',true);
    return;
} send({ action: 'retention', keep }); });
$('cleanup-reports').addEventListener('click', () => send({ action: 'cleanup' }));
setInterval(() => { for (const span of all('.relative-time'))
    span.textContent = relativeTime(/^\d+$/.test(span.dataset.timestamp) ? Number(span.dataset.timestamp) : span.dataset.timestamp); if (!state.busy)
    updateForm(); }, 30000);
function ownsHistory(event,requireKind=false){
    const owner=state.historyRequest;
    return state.view==='history'&&owner&&owner.workspace===state.workspace&&event.requestId===owner.requestId&&event.target===owner.target&&event.mode===owner.mode&&(!requireKind||event.workspace===owner.workspace)&&((!requireKind&&!event.targetKind)||event.targetKind===owner.targetKind);
}
function showHistory(target = currentTarget(), which = mode()) { if(state.view!=='history')state.historyReturn = state.view; view('history'); historySnapshots.reset();const requestId=crypto.randomUUID(),post=which==='post-comments';state.historyRequest={requestId,workspace:state.workspace,target:post?ReaderUX.postId(target):uidOf(target),targetKind:post?'post':'user',mode:which};window.ReaderEntityActions?.renderHistoryContinuations(state.historyRequest.targetKind,state.historyRequest.target);$('history-title').textContent = (state.accounts.find(a => a.uid === uidOf(target))?.nickname || target) + ' · 获取历史';$('history-summary').textContent='仅汇总当前数据的已保存获取记录';$('history-cost-summary').hidden=true; $('history-rows').textContent = '正在读取本地更新记录…'; send({ action: 'updateHistory', target, mode: which,requestId }); }
function renderHistoryCost(records){const total=ReaderHistoryCost.summarize(records),root=$('history-cost-summary');root.replaceChildren();root.hidden=false;const main=node('div','history-cost-main');main.append(node('span','','累计消耗估算'),node('strong','',total.estimatedOperations?numeric(total.estimatedCredits)+' credits':total.operations?'暂无法汇总':'0 credits'));root.append(main);const notes=[];if(total.verifiedOperations)notes.push('可核实实扣 '+numeric(total.verifiedCredits)+' credits（'+total.verifiedOperations+' 次操作）');if(total.unknownRequests)notes.push(total.unknownRequests+' 次请求费用待核对');if(total.unpricedOperations)notes.push(total.unpricedOperations+' 次操作缺少费用记录');if(total.reservedCredits)notes.push('待核对预算预留 '+numeric(total.reservedCredits)+' credits');notes.push('按返回量估算；仅当前获取历史，不含资料查询等其他操作');root.append(node('p','field-hint',notes.join(' · ')));}
function renderHistory(records) { renderHistoryCost(records); const root = $('history-rows'); root.replaceChildren(); $('history-summary').textContent = records.length + ' 次操作 · 账单信息与数据保存在本机'; if (!records.length) {
    root.append(node('p', 'field-hint', '暂无可用的更新账单。旧版本采集没有记录的实扣费用无法事后推算。'));
    return;
}
const batchSize=40,list=node('div');
root.append(list);
let cursor=0;
const more=node('button','button secondary');
more.type='button';
function appendBatch(){
    const end=Math.min(cursor+batchSize,records.length);
    list.append(...records.slice(cursor,end).map(historyEntry));
    cursor=end;
    more.hidden=cursor===records.length;
    if(!more.hidden)more.textContent='显示更多获取记录（剩余 '+numeric(records.length-cursor)+' 条）';
}
more.onclick=appendBatch;
appendBatch();
if(!more.hidden)root.append(more);
}
function historyEntry(entry){
    const interpretation=ReaderAcquisitionFeedback.describe({...entry,syncOnly:true,incomplete:entry.status!=='complete',persistence:entry.persistence},{cancelled:['cancelled','interrupted'].includes(entry.status),code:entry.status==='failed'?1:0});
    const box = node('details', 'history-entry'), heading = node('summary'), time = node('strong', '', dateText(Date.parse(entry.finishedAt))), label = interpretation.middleGap?'已完成 · 待补区间':interpretation.goalComplete&&!interpretation.pendingNew?'已完成':{ complete: '已完成', partial: '部分完成', failed: '失败', cancelled: '已中断', interrupted: '已中断', legacy: '旧版采集审计' }[entry.status] || entry.status;
    heading.append(time, timeSpan(entry.finishedAt), node('span', '', label));
    box.append(heading);
    const b = entry.billing || {}, cost = b.status === 'no-content-requests' ? '新增取数费用 0 credits（未发出内容请求）' : b.balanceDecrease != null && b.balanceDecrease >= 0 ? '余额减少 ' + numeric(b.balanceDecrease) + ' credits（余额观测）' : '实耗待核对';
    heading.append(node('span', 'history-cost', cost + (b.unknownRequests || b.status === 'unverified' ? ' · 费用待核实' : '')));
    const modeLine = node('p'), modeLabel = modes[internal[entry.mode] || entry.mode] || entry.mode || '更新';
    modeLine.append(markCommentDirection(node('span', '', modeLabel), entry.mode), ' · ' + (entry.from || entry.to ? ReaderDates.label(entry.from,entry.to) : entry.before ? '截至 ' + entry.before : ({ automatic: '订阅自动检查', latest: '快速检查更新', quick: '快速检查更新', regular: '常规获取', history: '常规获取', range: '常规获取 · 日期范围' }[entry.operation] || '旧版记录，范围详情见审计')));
    box.append(modeLine, node('p', '', `本次覆盖 ${numeric(entry.records)} 条 · 本地复用 ${numeric(entry.reusedRecords)} 条 · 新保存 ${numeric(entry.addedRecords)} 条 · 接口返回 ${numeric(entry.newReturned)} 条 · API ${numeric(entry.apiCalls)} 次 · 缓存 ${numeric(entry.cachedCalls)} 次`));
    const seconds = Math.max(0, Math.round((Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)) / 1000));
    box.append(node('p', 'field-hint', `开始 ${dateText(Date.parse(entry.startedAt))} · 耗时 ${Number.isFinite(seconds) ? seconds + ' 秒' : '未知'} · 按返回量估算 ${b.estimatedCredits == null ? '未知' : numeric(b.estimatedCredits) + ' credits'}`));
    if (b.balanceBefore != null || b.balanceAfter != null)
        box.append(node('p', 'field-hint', `余额查询 ${numeric(b.balanceBefore)} → ${numeric(b.balanceAfter)} credits`));
    if (entry.operation)
        box.append(node('p', 'field-hint', '读取条数上限：' + (entry.requestedLimit == null ? '不限' : numeric(entry.requestedLimit)) + ' · 每接口请求上限：' + (entry.requestLimit == null ? '不限' : numeric(entry.requestLimit))));
    for (const q of entry.autoRequests || []) {
        const request = node('p', 'field-hint'), direction = { sent: '发出', received: '收到', 'post-comments': '博文评论' }[q.kind];
        request.append(markCommentDirection(node('span', '', direction || q.kind || '方向未确认'), q.kind), ' · ' + dateText(Date.parse(q.at)) + ' · 请求 ' + numeric(q.count) + ' / 返回 ' + numeric(q.returned) + ' 条 · 单价 ' + numeric(q.unitPrice) + ' · ' + (q.status === 'estimated' ? '估算 ' + numeric(q.estimatedCredits) + ' credits' : '费用待核对，预留 ' + numeric(q.reservedCredits) + ' credits'));
        box.append(request);
    }
    box.append(node('p','',interpretation.title),node('p','field-hint',interpretation.detail));
    if (entry.reason)
        box.append(node('p', 'field-hint', entry.reason));
    return box;
}
$('database-history').addEventListener('click', () => { if (!currentTarget()) {
    toast('请先选择目标用户或微博',true);
    return;
} showHistory(); });
$('history-back').addEventListener('click', () => view(state.historyReturn || 'create'));
