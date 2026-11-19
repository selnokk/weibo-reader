const test=require('node:test'),assert=require('node:assert/strict');
const {createCreditMeter}=require('../lib/credits');
function fixture({balance=1000,after=968,trial=false,price=3,failAccount=false,invalidPrice=false}={}){
 const calls=[],logs=[];let accounts=0;
 const meter=createCreditMeter({}, {isTTY:false,log:s=>logs.push(s),run:args=>{calls.push(args);if(args[0]==='me'){if(failAccount)throw Error('余额查询失败');return JSON.stringify({user:{balance:accounts++?after:balance},service_status:{kind:trial?'trial_active':'formal_active'}});}return JSON.stringify({command:{group:args[2],action:args[3],method:'GET',trial_enabled:true,price_type:invalidPrice?'unknown':'per_record',pricing:{configured:true,currency:'credit',unit_price:price}}});}});
 return {meter,calls,logs};
}
test('credits accumulate from new returned records, retain endpoint rates once, and show server balance separately from the estimate',()=>{
 const {meter,calls,logs}=fixture();meter.start();meter.prepare('sent');meter.record('sent',{comments:[{},{}]});meter.prepare('sent');meter.record('sent',{comments:Array(8).fill({})});meter.finish();meter.finish();
 assert.equal(meter.snapshot().estimatedCredits,30);assert.equal(meter.snapshot().returnedRecords,10);assert.equal(calls.filter(a=>a[0]==='me').length,2);assert.equal(calls.filter(a=>a[0]==='commands').length,1);
 assert.ok(logs.some(s=>s.includes('累计估算 6 credits')));assert.ok(logs.some(s=>s.includes('累计估算 30 credits')));assert.ok(logs.some(s=>s.includes('剩余余额：968 credits（服务端查询）')));
 assert.ok(logs.some(s=>s.includes('本次总消耗：30 credits')));assert.ok(!logs.some(s=>s.includes('本次总消耗：32')));
});
test('cost follows returned top-level records rather than unique exports, quote count or local filtering',()=>{
 const {meter}=fixture();meter.prepare('sent');meter.record('sent',{comments:[{idstr:'1',reply_comment:{}},{idstr:'1'},{idstr:'1'}]});assert.equal(meter.snapshot().estimatedCredits,9);
});
test('a known subscription estimate avoids the ending balance request without inventing a final or actual balance',()=>{
 const {meter,calls,logs}=fixture();meter.prepare('sent');meter.record('sent',{comments:[{},{}]});meter.finish({skipFinalBalanceIfKnown:true});
 assert.equal(calls.filter(a=>a[0]==='me').length,1);assert.equal(meter.snapshot().estimatedCredits,6);assert.equal(meter.snapshot().initialBalance,1000);assert.equal(meter.snapshot().finalBalance,null);assert.match(logs.join('\n'),/剩余余额：估算 994 credits/);assert.doesNotMatch(logs.join('\n'),/服务端查询/);
});
test('subscription balance optimization retains the ending query for any unknown request or billing result',()=>{
 for(const uncertain of [false,true]){const {meter,calls}=fixture();meter.prepare('sent');if(uncertain)meter.record('sent',{comments:[]},{billingUnverified:true});else meter.fail();meter.finish({skipFinalBalanceIfKnown:true});assert.equal(calls.filter(a=>a[0]==='me').length,2);assert.equal(meter.snapshot().unknownRequests,1);assert.equal(meter.snapshot().finalBalance,968);}
});
test('unknown prices and failed requests cannot become a confirmed zero consumption or reliable balance estimate',()=>{
 const {meter,logs}=fixture({invalidPrice:true});meter.prepare('received');meter.record('received',{comments:[{}]});meter.fail();meter.finish();assert.equal(meter.snapshot().unknownRequests,2);
 assert.match(logs.join('\n'),/费用待核实/);assert.doesNotMatch(logs.join('\n'),/本次总消耗：0/);assert.ok(!meter.progress().includes('估算余额'));
});
test('trial service quotes zero only when the endpoint is explicitly trial-enabled',()=>{
 const {meter}=fixture({trial:true,balance:0,after:0});meter.prepare('sent');meter.record('sent',{comments:[{},{}]});assert.equal(meter.snapshot().estimatedCredits,0);meter.finish();assert.equal(meter.snapshot().finalBalance,0);
});
test('offline and dry-run credit meters perform no account or metadata requests',()=>{
 for(const options of [{offline:true},{dryRun:true}]){
  const meter=createCreditMeter(options,{log:()=>{},run:()=>{throw Error('must not run');}});meter.start();meter.prepare('sent');meter.finish();assert.equal(meter.snapshot().requests,0);assert.equal(meter.snapshot().estimatedCredits,0);
 }
});
test('account lookup failures do not prevent price estimation or trigger repeated balance queries',()=>{
 const {meter,calls,logs}=fixture({failAccount:true});meter.start();meter.prepare('sent');meter.record('sent',{comments:[{}]});meter.finish();assert.equal(meter.snapshot().estimatedCredits,3);assert.equal(calls.filter(a=>a[0]==='me').length,1);assert.match(logs.join('\n'),/剩余余额：暂不可用/);
});
test('a local-only reuse makes one balance observation, with a final query for actual or uncertain requests',()=>{
 const reused=fixture();
 reused.meter.start();reused.meter.finish({skipFinalBalanceIfLocal:true});
 assert.equal(reused.calls.filter(args=>args[0]==='me').length,1);
 assert.equal(reused.meter.snapshot().finalBalance,null);
 assert.match(reused.logs.join('\n'),/上次查询余额：1,000 credits/);
 const failed=fixture();
 failed.meter.start();failed.meter.uncertain();failed.meter.finish({skipFinalBalanceIfLocal:true});
 assert.equal(failed.calls.filter(args=>args[0]==='me').length,2);
 assert.equal(failed.meter.snapshot().finalBalance,968);
});
