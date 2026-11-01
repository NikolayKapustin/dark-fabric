import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fixture,result,planTask} from './helpers.js';
import {quotaState} from '../src/codex.js';
import {Engine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {factorySettings,updateSettings,quotaReserve} from '../src/settings.js';
import {scheduleTokenAnalysis,tokenAnalysisSnapshot} from '../src/token-analysis.js';
import {recordUsage} from '../src/telemetry.js';
import {createServer} from '../src/server.js';
import {remoteSnapshot} from '../src/remote.js';
import {restrictiveQuota} from '../src/settings.js';

const sample=(used,now=Date.now(),secondary=null)=>quotaState({rateLimits:{primary:{usedPercent:used,resetsAt:Math.floor(now/1000)+60},secondary}},now);

test('reserve includes the 10% boundary in either window, remains distinct from hard exhaustion and allows local gates',async t=>{
  const f=fixture(t),settings=factorySettings(f.store,f.config);
  assert.equal(settings.quotaReservePercent,10);
  assert.equal(quotaReserve(sample(89),settings).blocked,false);
  assert.equal(quotaReserve(sample(90),settings).blocked,true);
  assert.equal(quotaReserve(sample(5,Date.now(),{usedPercent:93}),settings).blocked,true);
  const incomplete=quotaState({rateLimits:{primary:{usedPercent:90},secondary:{usedPercent:null}}});
  assert.equal(incomplete.known,false);assert.equal(quotaReserve(incomplete,settings).blocked,true);
  f.store.set('quota',sample(90));assert.equal(f.store.get('quota').blocked,false);assert.equal(f.engine.modelAllowed(),false);
  const model=f.add(),local=f.add({phase:'verify',priority:10});f.store.patch(local.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  await f.engine.tick();await Promise.all([...f.engine.active.values()]);
  assert.equal(f.store.task(local.id).phase,'review');assert.equal(f.store.task(model.id).status,'pending');assert.equal(f.runner.calls.length,0);
});

test('reserve survives failed and incomplete polling beyond reset and restart; complete recovery actually resumes the saved stage',async t=>{
  const f=fixture(t),task=f.add({phase:'review'});f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  let now=Date.now(),reads=0;f.engine.now=()=>now;f.store.set('quota',{...sample(90,now),checkedAt:now});
  f.runner.readQuota=async()=>{reads++;throw Error('offline');};
  now+=f.config.quotaPollMs;await f.engine.tick();await f.engine.tick();
  assert.equal(reads,1);assert.equal(f.engine.modelAllowed(),false);assert.equal(f.runner.calls.length,0);
  const restarted=new Engine(f.store,f.config,{runner:f.runner,workspaces:f.workspaces,now:()=>now});
  await restarted.refreshQuota();assert.equal(reads,1);assert.equal(restarted.modelAllowed(),false);
  f.runner.readQuota=async()=>{reads++;return sample(0,now,{usedPercent:null});};
  now+=f.config.quotaPollMs;await restarted.refreshQuota();assert.equal(restarted.modelAllowed(),false);
  f.runner.readQuota=async()=>{reads++;return sample(80,now);};now+=f.config.quotaPollMs;
  await restarted.tick();await Promise.all([...restarted.active.values()]);
  assert.equal(f.runner.calls.length,1);assert.equal(f.runner.calls[0].readOnly,true);assert.equal(f.store.task(task.id).phase,'integrate');assert.equal(f.store.task(task.id).checkpoint_sha,'sha-1');
});

test('live reserve notification interrupts Codex, preserves partial work and resumes without retry penalties',async t=>{
  const f=fixture(t),task=f.add(),file=path.join(f.root,'partial.txt');
  f.runner.run=async args=>{
    args.onThread('saved-thread');writeFileSync(file,'partial result');
    args.onEvent({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:90}}}});
    assert.equal(args.signal.aborted,true);throw Error('Worker interrupted');
  };
  await f.step();const waiting=f.store.task(task.id);
  assert.equal(waiting.status,'pending');assert.equal(waiting.phase,'implement');assert.equal(waiting.attempts,0);assert.equal(waiting.repairs,0);assert.equal(waiting.thread_id,'saved-thread');
  assert.equal(readFileSync(file,'utf8'),'partial result');assert.equal(f.store.row('SELECT status FROM runs').status,'deferred');assert.equal(f.engine.modelControllers.size,0);
  f.runner.readQuota=async()=>sample(1);await f.engine.refreshQuota(true);
  f.runner.run=async args=>{assert.equal(args.threadId,'saved-thread');return result();};
  await f.step();assert.equal(f.store.task(task.id).phase,'verify');assert.equal(readFileSync(file,'utf8'),'partial result');
});

test('reserve settings apply to live model controllers without overriding a human pause or a hard limit',async t=>{
  const f=fixture(t);f.store.set('quota',sample(85));f.store.set('paused',true);
  const controller=new AbortController();f.engine.modelControllers.set('active-test',controller);
  updateSettings(f.store,f.config,{quotaReservePercent:20});await f.engine.tick();assert.equal(controller.signal.aborted,true);assert.equal(f.store.get('paused'),true);assert.equal(f.runner.calls.length,0);
  updateSettings(f.store,f.config,{quotaReservePercent:0});f.store.set('quota',sample(100));assert.equal(f.engine.modelAllowed(),false);
});

test('an older in-flight quota poll cannot clear a reserve established by a live notification',async t=>{
  const f=fixture(t);f.add();f.store.set('quota',sample(80));let resolvePoll;
  f.runner.readQuota=()=>new Promise(resolve=>{resolvePoll=resolve;});
  const polling=f.engine.refreshQuota(true);
  f.runner.run=async args=>{
    args.onEvent({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:90}}}});
    throw Error('Worker interrupted');
  };
  await f.step();assert.equal(f.engine.modelAllowed(),false);
  resolvePoll(sample(80));await polling;assert.equal(f.engine.modelAllowed(),false);assert.equal(f.store.get('quota').primary.usedPercent,90);
  f.runner.readQuota=async()=>sample(80);await f.engine.refreshQuota(true);assert.equal(f.engine.modelAllowed(),true);
});

test('partial notifications preserve a hard exhausted window even when the operator disables the reserve',t=>{
  const f=fixture(t),now=Date.now(),hard=sample(30,now,{usedPercent:100,resetsAt:Math.floor(now/1000)+3600});
  const partial=quotaState({rateLimits:{primary:{usedPercent:90},secondary:{usedPercent:null}}},now);
  f.store.set('quota',restrictiveQuota(hard,partial,now));
  updateSettings(f.store,f.config,{quotaReservePercent:0});
  assert.equal(f.engine.modelAllowed(),false);assert.equal(f.store.get('quota').blocked,true);assert.equal(f.store.get('quota').secondary.usedPercent,100);
});

test('concurrent forced quota refreshes share one official request and a later fresh read can establish reserve',async t=>{
  const f=fixture(t);let reads=0,resolve;
  f.runner.readQuota=()=>{reads++;return new Promise(r=>{resolve=r;});};
  const first=f.engine.refreshQuota(true),second=f.engine.refreshQuota(true);assert.equal(reads,1);
  resolve(sample(80));await Promise.all([first,second]);assert.equal(f.engine.modelAllowed(),true);
  f.runner.readQuota=async()=>{reads++;return sample(90);};await f.engine.refreshQuota(true);
  assert.equal(reads,2);assert.equal(f.engine.modelAllowed(),false);
});

test('remote activity projects the reserve and live UI override without exposing raw session logs',t=>{
  const f=fixture(t);f.add();f.store.set('quota',sample(85));updateSettings(f.store,f.config,{quotaReservePercent:20});
  const snapshot=remoteSnapshot(f.store,f.config);assert.equal(snapshot.activity.state,'quota');assert.equal(snapshot.quotaReserve.blocked,true);assert.equal(snapshot.settings.quotaReservePercent,20);assert.equal(snapshot.projects[0].activity.state,'quota');
});

function finishedUsage(f,{status='done',tokens=1200,thread='session',finish=true,improvement=false}={}){
  const task=f.add({improvement});f.store.patch(task.id,{status:'done'});const run=f.store.startRun(task);
  if(finish)f.store.finishRun(run,status);
  recordUsage(f.store,run,{method:'thread/tokenUsage/updated',params:{threadId:thread,tokenUsage:{total:{totalTokens:tokens,inputTokens:tokens-200,cachedInputTokens:500,outputTokens:200,reasoningOutputTokens:100}}}});
  return {task,run};
}

test('daily analysis is bounded, persistent, transactional and does not turn its own work into endless new analysis',async t=>{
  const f=fixture(t),settings=factorySettings(f.store,f.config);finishedUsage(f,{status:'failed'});
  const now=Date.now();assert.equal(scheduleTokenAnalysis(f.store,settings,now),1);scheduleTokenAnalysis(f.store,settings,now);
  let snapshot=tokenAnalysisSnapshot(f.store,settings);assert.equal(snapshot.reports.length,1);assert.equal(snapshot.nextAt,now+86400000);
  const report=snapshot.reports[0];assert.equal(report.report.totals.totalTokens,1200);assert.equal(report.report.uncachedInputTokens,500);assert.equal(report.report.failedRuns,1);
  const analysis=f.store.task(report.task_id);assert.equal(analysis.kind,'token_analysis');assert.equal(analysis.phase,'retrospective');
  const pending=f.add({title:'Existing queued optimization',priority:-10,criteria:Array(20).fill('x'.repeat(2000))});
  f.runner.run=async args=>{assert.equal(args.readOnly,true);assert.ok(args.prompt.length<16000);assert.match(args.prompt,/Existing queued optimization/);assert.match(args.prompt,/at most ONE/);return result({tasks:[planTask('reduce-output')]});};
  await f.step();const improvement=f.store.row("SELECT * FROM tasks WHERE title='reduce-output'");assert.equal(improvement.improvement,1);assert.equal(improvement.phase,'implement');
  assert.ok(improvement.depends.includes(analysis.id));
  f.store.patch(pending.id,{status:'done'});finishedUsage(f,{thread:'new-normal-run'});
  finishedUsage(f,{thread:'optimization',improvement:true});
  const reopened=new Store(path.join(f.root,'test.sqlite'));
  try{
    assert.equal(scheduleTokenAnalysis(reopened,settings,now+86400000),0);assert.equal(tokenAnalysisSnapshot(reopened,settings).reports.length,1);
    reopened.patch(improvement.id,{status:'done'});assert.equal(scheduleTokenAnalysis(reopened,settings,now+2*86400000),1);
    assert.equal(tokenAnalysisSnapshot(reopened,settings).reports.length,2);
  }finally{reopened.close();}
});

test('analysis respects pauses, does not skip late-finishing sessions and retries atomically after failure',t=>{
  const f=fixture(t),settings=factorySettings(f.store,f.config),slow=finishedUsage(f,{finish:false}),now=Date.now();
  finishedUsage(f,{thread:'other'});f.store.set('paused',true);scheduleTokenAnalysis(f.store,settings,now);assert.equal(f.store.rows('SELECT * FROM token_reports').length,0);
  f.store.set('paused',false);const add=f.store.addTask.bind(f.store);f.store.addTask=()=>{throw Error('disk simulation');};
  assert.throws(()=>scheduleTokenAnalysis(f.store,settings,now),/disk simulation/);assert.equal(f.store.rows('SELECT * FROM token_analysis_runs').length,0);assert.equal(f.store.get('tokenAnalysis:lastAt'),null);
  f.store.addTask=add;scheduleTokenAnalysis(f.store,settings,now);
  assert.equal(f.store.rows('SELECT * FROM token_analysis_runs').length,1);
  f.store.db.prepare("UPDATE tasks SET status='done' WHERE kind='token_analysis'").run();f.store.finishRun(slow.run,'done');
  assert.equal(scheduleTokenAnalysis(f.store,settings,now+86400000),1);assert.equal(f.store.rows('SELECT * FROM token_analysis_runs').length,2);
  scheduleTokenAnalysis(f.store,{...settings,tokenAnalysisEnabled:false},now+2*86400000);assert.equal(f.store.rows('SELECT * FROM token_reports').length,2);
});

test('settings API authenticates, rejects unrelated policy keys and persists validated changes across reopening',async t=>{
  const f=fixture(t),server=createServer(f.store,f.config,'test-token');await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,headers={'Content-Type':'application/json','X-Dark-Fabric-Token':'test-token'};
  const post=(value,h=headers)=>fetch(base+'/api/settings',{method:'POST',headers:h,body:JSON.stringify(value)});
  try{
    assert.equal((await post({quotaReservePercent:5},{'Content-Type':'application/json'})).status,401);
    assert.equal((await post({quotaReservePercent:5},{...headers,Origin:'https://evil.example'})).status,403);
    for(const value of [{quotaReservePercent:-1},{quotaReservePercent:100},{quotaReservePercent:'10'},{tokenAnalysisIntervalHours:0},{tokenAnalysisEnabled:'false'},{executionAccess:'full'}])assert.equal((await post(value)).status,400);
    assert.equal(factorySettings(f.store,f.config).quotaReservePercent,10);
    assert.equal((await post({quotaReservePercent:15,tokenAnalysisIntervalHours:12,tokenAnalysisEnabled:false})).status,200);
    const state=await (await fetch(base+'/api/state',{headers})).json();assert.equal(state.settings.quotaReservePercent,15);assert.equal(state.tokenAnalysis.enabled,false);
    const reopened=new Store(path.join(f.root,'test.sqlite'));try{assert.equal(factorySettings(reopened,f.config).tokenAnalysisIntervalHours,12);}finally{reopened.close();}
    assert.equal(f.store.get('paused',false),false);
  }finally{await new Promise(r=>server.close(r));}
});
