'use strict';
const {runCli}=require('./api');
const {ENDPOINTS}=require('./config');
const {rawArray}=require('./core');
const number=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const display=value=>Number(value.toFixed(6)).toLocaleString('en-US',{maximumFractionDigits:6});
function createCreditMeter(options={},dependencies={}){
 const run=dependencies.run||((args)=>runCli(args,{timeout:10000})),log=dependencies.log||console.log;
 const emit=dependencies.emit||require('./events').emit,now=dependencies.now||(()=>require('node:perf_hooks').performance.now());
 const tty=dependencies.isTTY??!!process.stdout.isTTY,prices=new Map();
 let initial=null,final=null,service='',cost=0,unknown=0,calls=0,records=0,started=false,finished=false,accountAvailable=false;
 function publish(diagnostic={}){emit('credits',{estimatedCredits:cost,unknownRequests:unknown,returnedRecords:records,requests:calls,initialBalance:initial,finalBalance:final,finished,offline:!!options.offline,...diagnostic});}
 function account(phase){
  const startedAt=now();let code='CLI_ACCOUNT_QUERY_FAILED';
  const diagnostic=(reason,value)=>({phase,reason,code:value,durationMs:Math.max(0,Math.round(now()-startedAt))});
  try{
   const output=run(['me','--output','json']);code='CLI_ACCOUNT_JSON';const data=JSON.parse(output);code='CLI_ACCOUNT_SCHEMA';
   if(!data||typeof data!=='object'||Array.isArray(data)||!data.user||typeof data.user!=='object'||Array.isArray(data.user))throw Error();
   const value=data.user.balance;code='CLI_ACCOUNT_BALANCE_MISSING';if(value==null||typeof value==='string'&&!value.trim())throw Error();
   code='CLI_ACCOUNT_BALANCE_INVALID';if(typeof value!=='number'&&!(typeof value==='string'&&/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())))throw Error();const balance=number(value);if(balance==null)throw Error();
   return {balance,kind:typeof data.service_status?.kind==='string'?data.service_status.kind:'',diagnostic:diagnostic('ready','NONE')};
  }catch{
   const reasons={CLI_ACCOUNT_QUERY_FAILED:['query-failed','免费余额查询未成功，原因尚未核实'],CLI_ACCOUNT_JSON:['invalid-json','免费余额响应不是有效 JSON'],CLI_ACCOUNT_SCHEMA:['schema-invalid','免费余额响应缺少可识别的账户结构'],CLI_ACCOUNT_BALANCE_MISSING:['balance-missing','免费余额响应未返回余额'],CLI_ACCOUNT_BALANCE_INVALID:['balance-invalid','免费余额响应的余额类型或数值无效']},[reason,message]=reasons[code];
   throw Object.assign(Error(message),{code,accountDiagnostic:diagnostic(reason,code)});
  }
 }
 function start(){
  if(started||options.offline||options.dryRun)return;started=true;
  let diagnostic;
  try{const data=account('account-initial');initial=data.balance;service=data.kind;diagnostic=data.diagnostic;accountAvailable=initial!=null;if(accountAvailable)log(`账户余额：${display(initial)} credits（查询时）`);}
  catch(error){diagnostic=error.accountDiagnostic;if(options.verbose)log('余额暂不可用：'+error.message);}
  publish(diagnostic);
 }
 function prepare(kind){
  if(options.offline||options.dryRun||prices.has(kind))return;start();
  let price=null;
  try{
   const endpoint=ENDPOINTS[kind]?.command;if(!endpoint){prices.set(kind,null);return;}
   const supplied=options.endpointMetadata?.has(kind),raw=supplied?options.endpointMetadata.get(kind):JSON.parse(run(['commands','show',...endpoint,'--output','json']));
   price=require('./command-pricing').parse(raw,{group:endpoint[0],action:endpoint[1],types:['per_record'],serviceKind:service})?.unitPrice??null;
  }catch(error){if(options.verbose)log('计费定义暂不可用：'+require('./terminal-report').conciseError(error));}
  prices.set(kind,price);
 }
 function progress(){
  const remainder=initial!=null&&!unknown?initial-cost:null;
  return `累计估算 ${display(cost)} credits${unknown?' + 费用待核实':''}${remainder!=null?' · 估算余额 '+display(remainder):''}`;
 }
 function record(kind,raw,{billingUnverified=false}={}){
  const count=rawArray(raw,kind)?.items.length,price=prices.get(kind);calls++;if(Number.isSafeInteger(count))records+=count;
  if(price!=null&&count!=null)cost+=price*count;
  if(price==null||count==null||billingUnverified)unknown++;
  publish();if(!tty)log('  费用：'+progress());
 }
 function fail(){calls++;unknown++;publish();if(!tty)log('  费用：'+progress());}
 function finish({skipFinalBalanceIfLocal=false,skipFinalBalanceIfKnown=false}={}){
  if(finished||options.dryRun)return;finished=true;
  let diagnostic;
  const reused=!unknown&&(skipFinalBalanceIfLocal&&!calls||skipFinalBalanceIfKnown);
  if(!options.offline&&accountAvailable&&!reused){try{const data=account('account-final');final=data.balance;diagnostic=data.diagnostic;}catch(error){diagnostic=error.accountDiagnostic;if(options.verbose)log('结束余额暂不可用：'+error.message);}}
  log(unknown?`本次消耗：已知部分估算 ${display(cost)} credits；另有 ${unknown} 次请求费用待核实`:`本次总消耗：${display(cost)} credits${options.offline?'（离线，无新增取数请求）':'（按新返回记录估算，以服务端扣费为准）'}`);
  if(final!=null)log(`剩余余额：${display(final)} credits（服务端查询）`);
  else if(options.offline)log('剩余余额：离线模式未查询');
  else if(initial!=null&&reused)log(calls?`剩余余额：估算 ${display(initial-cost)} credits`:`上次查询余额：${display(initial)} credits`);
  else if(initial!=null&&!unknown)log(`剩余余额：估算 ${display(initial-cost)} credits；结束时未能重新查询`);
  else log('剩余余额：暂不可用，可运行 npx --no-install weibo-cli me 查看');
  publish(diagnostic);
 }
 return {start,prepare,unitPrice:kind=>prices.get(kind)??null,record,fail,uncertain(){unknown++;publish();},progress,finish,snapshot:()=>({estimatedCredits:cost,unknownRequests:unknown,requests:calls,returnedRecords:records,initialBalance:initial,finalBalance:final,serviceKind:service})};
}
module.exports={createCreditMeter};
