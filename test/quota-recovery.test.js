import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {CodexError,quotaState} from '../src/codex.js';

function coolingFixture(t) {
  const f=fixture(t),clock={now:Date.now()};
  f.engine.now=()=>clock.now;
  const quota={known:true,blocked:true,until:clock.now+7*86400_000,observedAt:clock.now};
  f.store.set('quota',quota);
  return {...f,clock,quota};
}

test('early quota restoration is polled and resumes the saved review before the reset deadline',async t=>{
  const f=coolingFixture(t),task=f.add({phase:'review'});
  f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  let reads=0;
  f.runner.readQuota=async()=>{reads++;return {known:true,blocked:false,until:0,observedAt:f.clock.now};};
  await f.engine.tick();assert.equal(reads,0);assert.equal(f.runner.calls.length,0);
  f.clock.now+=f.config.quotaPollMs;
  await f.engine.tick();await Promise.all([...f.engine.active.values()]);
  assert.equal(reads,1);assert.equal(f.runner.calls.length,1);
  assert.equal(f.runner.calls[0].readOnly,true);
  assert.equal(f.store.task(task.id).phase,'integrate');
  assert.equal(f.store.task(task.id).checkpoint_sha,'sha-1');
  assert.equal(f.engine.modelAllowed(),true);assert.ok(f.clock.now<f.quota.until);
});

test('still-exhausted quota is rechecked on schedule without model execution',async t=>{
  const f=coolingFixture(t);f.add();let reads=0;
  f.runner.readQuota=async()=>{reads++;return {...f.quota,observedAt:f.clock.now};};
  f.clock.now+=f.config.quotaPollMs;
  await f.engine.tick();await f.engine.tick();
  assert.equal(reads,1);assert.equal(f.runner.calls.length,0);assert.equal(f.engine.modelAllowed(),false);
  f.clock.now+=f.config.quotaPollMs;await f.engine.tick();assert.equal(reads,2);
});

for(const mode of ['missing','error'])test(`${mode} telemetry preserves cooldown and retry cadence, including after restart`,async t=>{
  const f=coolingFixture(t);let reads=0;
  f.runner.readQuota=async()=>{reads++;if(mode==='error')throw new Error('offline');return {known:false};};
  f.clock.now+=f.config.quotaPollMs;
  await f.engine.refreshQuota();await f.engine.refreshQuota();
  assert.equal(reads,1);assert.equal(f.engine.modelAllowed(),false);
  assert.equal(f.store.get('quota').until,f.quota.until);
  const {Engine}=await import('../src/engine.js');
  const restarted=new Engine(f.store,f.config,{runner:f.runner,now:()=>f.clock.now});
  await restarted.refreshQuota();assert.equal(reads,1);assert.equal(restarted.modelAllowed(),false);
  // A recent polling attempt must not delay recovery at the actual deadline.
  f.clock.now=f.quota.until-1;await restarted.refreshQuota();assert.equal(reads,2);
  f.clock.now=f.quota.until;await restarted.refreshQuota();
  assert.equal(reads,3);assert.equal(restarted.modelAllowed(),true);
});

test('a repeated hard quota refusal restores durable backoff without consuming retries',async t=>{
  const f=coolingFixture(t),task=f.add();let reads=0,calls=0;
  f.runner.readQuota=async()=>{reads++;return {known:true,blocked:false,until:0,observedAt:f.clock.now};};
  f.runner.run=async()=>{calls++;throw new CodexError('Usage limit exceeded',{codexErrorInfo:'UsageLimitExceeded'});};
  f.clock.now+=f.config.quotaPollMs;
  await f.engine.tick();await Promise.all([...f.engine.active.values()]);
  assert.equal(f.store.task(task.id).attempts,0);assert.equal(f.engine.modelAllowed(),false);
  assert.equal(f.store.get('quota').until,f.clock.now+f.config.unknownQuotaBackoffMs);
  await f.engine.tick();assert.equal(calls,1);assert.equal(reads,2);
});

test('user pause prevents quota recovery from starting new work',async t=>{
  const f=coolingFixture(t);f.add();f.store.set('paused',true);f.clock.now+=f.config.quotaPollMs;
  f.runner.readQuota=async()=>{throw new Error('Must not poll while paused');};
  await f.engine.tick();assert.equal(f.runner.calls.length,0);assert.equal(f.engine.modelAllowed(),false);
});

test('absent or incomplete quota windows are unavailable telemetry, not restored quota',()=>{
  for(const rateLimits of [{primary:null,secondary:null},{primary:{usedPercent:null}},{primary:{usedPercent:0},secondary:{}}]) {
    assert.equal(quotaState({rateLimits}).known,false);
  }
  assert.equal(quotaState({rateLimits:{primary:{usedPercent:8},secondary:null}}).blocked,false);
});

test('an exhausted window remains authoritative when another window is unavailable',()=>{
  const now=1_000_000,exhausted={usedPercent:100,resetsAt:5000},unknown={usedPercent:null};
  for(const [primary,secondary] of [[exhausted,unknown],[unknown,exhausted]]) {
    const quota=quotaState({rateLimits:{primary,secondary}},now);
    assert.equal(quota.known,true);assert.equal(quota.blocked,true);assert.equal(quota.until,5_005_000);
    assert.equal(quota.complete,false);
  }
});

test('partial exhaustion cannot shorten a saved cooldown but can extend it',async t=>{
  const f=coolingFixture(t),shortReset=Math.floor((f.clock.now+3600_000)/1000);
  let reset=shortReset;
  f.runner.readQuota=async()=>quotaState({rateLimits:{primary:{usedPercent:100,resetsAt:reset},secondary:{usedPercent:null}}},f.clock.now);
  f.clock.now+=f.config.quotaPollMs;await f.engine.refreshQuota();
  assert.equal(f.store.get('quota').until,f.quota.until);assert.equal(f.engine.modelAllowed(),false);
  f.clock.now=shortReset*1000+5000;await f.engine.refreshQuota();
  assert.equal(f.store.get('quota').until,f.quota.until);assert.equal(f.engine.modelAllowed(),false);
  reset=Math.floor((f.quota.until+86400_000)/1000);
  f.clock.now+=f.config.quotaPollMs;await f.engine.refreshQuota();
  assert.equal(f.store.get('quota').until,reset*1000+5000);assert.equal(f.engine.modelAllowed(),false);
});
