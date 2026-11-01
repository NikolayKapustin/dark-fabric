import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fixture} from './helpers.js';
import {Store} from '../src/store.js';
import {recordUsage,usageSnapshot,backfillUsage} from '../src/telemetry.js';
const event=(n,threadId='thread',at=Date.now())=>({method:'thread/tokenUsage/updated',emittedAtMs:at,params:{threadId,tokenUsage:{total:{totalTokens:n,inputTokens:n-10,cachedInputTokens:n-20,outputTokens:10,reasoningOutputTokens:4}}}});

test('usage and bridge writes serialize before reading their transaction snapshots',t=>{
 const f=fixture(t),run=f.store.startRun(f.add()),bridge=new Store(path.join(f.root,'test.sqlite'));
 bridge.db.pragma('busy_timeout = 0');
 const row=f.store.row.bind(f.store);let attempted=false,contended=false;
 f.store.row=(sql,...args)=>{
  const value=row(sql,...args);
  if(!attempted&&sql.includes('FROM usage_baselines')){
   attempted=true;
   try{bridge.set('remote.status',{ok:true});}
   catch(e){assert.match(e.code,/^SQLITE_BUSY/);contended=true;}
  }
  return value;
 };
 try{
  // With a deferred transaction the other connection commits here, invalidating
  // the reader's WAL snapshot; recordUsage then throws instead of waiting.
  recordUsage(f.store,run,event(100));
  assert.equal(attempted,true);assert.equal(contended,true);
  bridge.set('remote.status',{ok:true});
  recordUsage(f.store,run,event(150));recordUsage(f.store,run,event(150));
  assert.equal(usageSnapshot(f.store).total.totalTokens,150);
  assert.equal(usageSnapshot(f.store).today.totalTokens,150);
  assert.deepEqual(f.store.get('remote.status'),{ok:true});
 }finally{f.store.row=row;bridge.close();}
});

test('failed usage update retains the event, rolls back totals and resumes without double counting',async t=>{
 const f=fixture(t),task=f.add(),sample=event(200);
 f.store.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage_days BEGIN SELECT RAISE(ABORT,'test usage failure'); END");
 f.runner.run=async args=>{args.onThread('thread');args.onEvent(sample);throw new Error('after telemetry');};
 await f.step();
 const failed=f.store.row('SELECT * FROM runs WHERE task_id=?',task.id);
 assert.equal(failed.status,'failed');assert.equal(f.store.task(task.id).status,'pending');
 assert.equal(f.store.task(task.id).thread_id,'thread');
 assert.equal(f.store.rows('SELECT * FROM usage_baselines').length,0);
 assert.equal(f.store.rows('SELECT * FROM run_usage').length,0);
 assert.equal(f.store.rows('SELECT * FROM usage_days').length,0);
 const retained=readFileSync(path.join(f.root,'logs',failed.id+'.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(retained.at(-1),sample);
 f.store.db.exec('DROP TRIGGER fail_usage');
 recordUsage(f.store,failed.id,retained.at(-1));recordUsage(f.store,failed.id,retained.at(-1));
 f.store.patch(task.id,{available_at:0});
 await f.step();
 const snapshot=usageSnapshot(f.store);
 assert.equal(snapshot.total.totalTokens,200);assert.equal(snapshot.today.totalTokens,200);
 assert.equal(snapshot.runs.find(r=>r.runId===failed.id).totalTokens,200);
 assert.equal(snapshot.runs.find(r=>r.runId!==failed.id).totalTokens,0);
});
test('cumulative usage is durable and replay-safe across retries and failed runs',t=>{
 const f=fixture(t),task=f.add(),a=f.store.startRun(task);recordUsage(f.store,a,event(100));recordUsage(f.store,a,event(100));recordUsage(f.store,a,event(200));f.store.finishRun(a,'failed');
 const b=f.store.startRun(task);recordUsage(f.store,b,event(250));recordUsage(f.store,b,event(250));
 const s=usageSnapshot(f.store);assert.equal(s.total.totalTokens,250);assert.equal(s.runs.find(r=>r.runId===b).totalTokens,50);assert.equal(s.total.cachedInputTokens,230);assert.equal(s.total.outputTokens,10);
});
test('daily token increments use UTC day boundaries and missing telemetry stays unknown',t=>{
 const f=fixture(t),r=f.store.startRun(f.add());assert.equal(usageSnapshot(f.store).known,false);
 recordUsage(f.store,r,event(100,'t',Date.parse('2026-10-25T23:59:00Z')));recordUsage(f.store,r,event(150,'t',Date.parse('2026-10-26T00:01:00Z')));
 assert.equal(usageSnapshot(f.store,Date.parse('2026-10-26T00:02:00Z')).today.totalTokens,50);
});
test('out of order or reset counters cannot inflate usage and are marked partial',t=>{
 const f=fixture(t),r=f.store.startRun(f.add());recordUsage(f.store,r,event(200));recordUsage(f.store,r,event(150));
 assert.equal(usageSnapshot(f.store).total.totalTokens,200);assert.equal(usageSnapshot(f.store).coverage.partialRuns,1);
 recordUsage(f.store,r,{method:'thread/tokenUsage/updated',params:{threadId:'t',tokenUsage:{total:{totalTokens:-1}}}});assert.equal(usageSnapshot(f.store).total.totalTokens,200);
});
test('historical import is transactional and idempotent, including partial lines',t=>{
 const f=fixture(t),r=f.store.startRun(f.add());f.store.db.prepare("DELETE FROM meta WHERE key='usage:imported:v1'").run();
 writeFileSync(path.join(f.root,'logs',r+'.jsonl'),JSON.stringify(event(100))+'\n'+JSON.stringify(event(200))+'\n{unfinished');
 backfillUsage(f.store,f.root);backfillUsage(f.store,f.root);recordUsage(f.store,r,event(250));
 const s=usageSnapshot(f.store);assert.equal(s.total.totalTokens,250);assert.equal(s.coverage.historicalRuns,1);assert.equal(s.coverage.partialRuns,1);
});
test('telemetry persists beyond the raw log size cap',async t=>{
 const f=fixture(t);f.add();f.runner.run=async args=>{args.onThread('t');args.onEvent({method:'test/log',params:{text:'x'.repeat(10_000_000)}});args.onEvent(event(300));throw new Error('process crashed');};await f.step();
 const s=usageSnapshot(f.store);assert.equal(s.total.totalTokens,300);assert.equal(s.runs.length,1);
});

test('rerouting preserves totals without falsely assigning earlier tokens to the last model',async t=>{
 const f=fixture(t);f.add();f.runner.run=async args=>{
  args.onEvent({method:'factory/modelSelected',params:{model:'model-a'}});args.onEvent(event(100));
  args.onEvent({method:'model/rerouted',params:{toModel:'model-b'}});args.onEvent(event(150));throw new Error('interrupted');
 };await f.step();const s=usageSnapshot(f.store);assert.equal(s.total.totalTokens,150);
 assert.equal(s.byModel[0].model,'Несколько моделей (без разделения)');assert.equal(s.assignments[0].actualModel,'model-b');assert.equal(s.assignments[0].mixedModels,true);
});
