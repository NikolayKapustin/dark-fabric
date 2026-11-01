import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,result,planTask } from './helpers.js';
import { CodexError } from '../src/codex.js';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {pinChecks} from '../src/service.js';
import {IntegrationError} from '../src/git.js';

test('implementation -> real host gate -> independent review -> exact checkpoint integration',async t=>{
  const f=fixture(t);const task=f.add();
  await f.step();assert.equal(f.store.task(task.id).phase,'verify');
  await f.step(false);assert.equal(f.store.task(task.id).phase,'review');
  await f.step();assert.equal(f.store.task(task.id).phase,'integrate');
  assert.equal(f.runner.calls[0].readOnly,false);assert.equal(f.runner.calls[1].readOnly,true);assert.equal(f.runner.calls[1].threadId,null);
  await f.step(false);assert.equal(f.store.task(task.id).status,'done');assert.equal(f.runner.calls.length,2);
});
test('a hard quota error survives restart and does not consume task retries; local checks continue',async t=>{
  const f=fixture(t);const task=f.add({priority:5});
  f.runner.run=async()=>{throw new CodexError('Usage limit exceeded',{codexErrorInfo:'UsageLimitExceeded'});};
  await f.step();assert.equal(f.store.task(task.id).attempts,0);assert.equal(f.engine.modelAllowed(),false);assert.ok(f.store.get('quota').until>Date.now());
  const local=f.add({phase:'verify',priority:10});f.store.patch(local.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  await f.step(false);assert.equal(f.store.task(local.id).phase,'review');
});
test('expired quota with unavailable telemetry allows a bounded recovery probe',async t=>{
  const f=fixture(t);f.store.set('quota',{known:true,blocked:true,until:Date.now()-1,observedAt:0});
  f.runner.readQuota=async()=>({known:false});await f.engine.refreshQuota();assert.equal(f.engine.modelAllowed(),true);
});
test('unanswered input parks just one task and its partial work is preserved',async t=>{
  const f=fixture(t);const a=f.add({priority:2}),b=f.add();
  f.runner.run=async()=>result({status:'blocked',questions:[{prompt:'Product direction?',context:'Two incompatible paths',choices:['A','B']}]});
  await f.step();assert.equal(f.store.task(a.id).status,'blocked');assert.equal(f.store.task(a.id).workspace,f.root);assert.equal(f.store.claim().id,b.id);
});
test('failed tests return to implementation and never reach integration',async t=>{
  const f=fixture(t);const task=f.add();await f.step();
  f.engine.command=async()=>({code:1,stdout:'regression failed',stderr:''});await f.step();
  assert.equal(f.store.task(task.id).phase,'implement');assert.equal(f.store.task(task.id).repairs,1);assert.match(f.store.task(task.id).feedback,/regression failed/);
});
test('a reviewer requesting changes triggers another implementation/check/review cycle',async t=>{
  const f=fixture(t);const task=f.add({phase:'review'});f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  f.runner.run=async()=>result({status:'changes_requested',summary:'Missing edge-case validation'});await f.step();
  assert.equal(f.store.task(task.id).phase,'implement');assert.match(f.store.task(task.id).feedback,/Missing edge/);
});
test('review cannot bless a mutated checkpoint',async t=>{
  const f=fixture(t);const task=f.add({phase:'review'});f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});f.workspaces.cleanAt=async()=>false;
  await f.step();assert.equal(f.store.task(task.id).phase,'implement');
});
test('planner DAG creation is atomic and invalid plans cannot leave partial tasks',async t=>{
  const f=fixture(t);const planner=f.add({kind:'plan',phase:'plan'});
  f.runner.run=async()=>result({tasks:[planTask('one'),planTask('two',['missing'])]});await f.step();
  assert.equal(f.store.rows('SELECT * FROM tasks').length,3);assert.equal(f.store.task(planner.id).attempts,1);
  f.store.patch(planner.id,{available_at:0});f.runner.run=async()=>result({tasks:[planTask('one'),planTask('two',['one'])]});await f.step();
  const one=f.store.row("SELECT * FROM tasks WHERE title='one'"),two=f.store.row("SELECT * FROM tasks WHERE title='two'");assert.ok(two.depends.includes(one.id));assert.ok(one.depends.includes(planner.id));
});
test('repair loop is bounded and human response resumes implementation',async t=>{
  const f=fixture(t,{maxRepairCycles:1,technicalRecovery:false});const task=f.add({phase:'review'});f.runner.run=async()=>result({status:'changes_requested'});await f.step();
  assert.equal(f.store.task(task.id).status,'blocked');assert.equal(f.store.task(task.id).phase,'implement');
  f.store.answer(f.store.row('SELECT * FROM questions').id,'Use the alternate algorithm');assert.equal(f.store.task(task.id).status,'pending');
  assert.equal(f.store.get(`recovery:${task.id}`).count,1);
  f.runner.run=async args=>{f.runner.calls.push(args);return result();};await f.step();
  assert.match(f.runner.calls.at(-1).prompt,/HOST REPAIR ASSIGNMENT/);
  assert.match(f.runner.calls.at(-1).prompt,/Use the alternate algorithm/);
});
test('stale integration returns through all quality gates',async t=>{
  const f=fixture(t);const task=f.add({phase:'integrate'});f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});f.workspaces.integrate=async()=>({stale:true});await f.step(false);assert.equal(f.store.task(task.id).phase,'implement');
});

test('operational integration failures preserve the reviewed checkpoint and allow independent work before replay',async t=>{
  const f=fixture(t,{maxAttempts:2}),task=f.add({phase:'integrate',priority:10}),independent=f.add();
  f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  f.workspaces.integrate=async()=>{throw new IntegrationError(Error('git merge: index.lock already exists'));};
  await f.step(false);const waiting=f.store.task(task.id);
  assert.equal(waiting.phase,'integrate');assert.equal(waiting.status,'pending');assert.equal(waiting.repairs,0);
  assert.equal(waiting.checkpoint_sha,'sha-1');assert.ok(waiting.available_at>Date.now());assert.match(waiting.feedback,/index\.lock/);
  assert.equal(f.store.rows("SELECT * FROM events WHERE type='task.repair'").length,0);
  assert.match(f.store.row("SELECT result_json FROM runs WHERE task_id=?",task.id).result.message,/index\.lock/);
  assert.equal((await f.step()).id,independent.id);assert.equal(f.store.task(independent.id).phase,'verify');
  for(let i=0;i<4;i++){
    f.store.patch(task.id,{available_at:0});await f.step(false);
    assert.equal(f.store.task(task.id).phase,'integrate');assert.equal(f.store.task(task.id).checkpoint_sha,'sha-1');
  }
  assert.equal(f.store.get(`incident:${task.id}`).kind,'integration');assert.equal(f.store.get(`incident:${task.id}`).status,'retrying');
  f.workspaces.integrate=async()=>({integrated:true});f.store.patch(task.id,{available_at:0});await f.step(false);
  assert.equal(f.store.task(task.id).status,'done');assert.equal(f.runner.calls.length,1);
  assert.equal(f.store.get(`incident:${task.id}`).status,'resolved');
});

test('a changed checkpoint at integration still returns through implementation and quality gates',async t=>{
  const f=fixture(t,{maxAttempts:1}),task=f.add({phase:'integrate'});
  f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  f.workspaces.integrate=async()=>{throw Error('Reviewed checkpoint changed; verification must run again');};
  await f.step(false);assert.equal(f.store.task(task.id).phase,'implement');assert.equal(f.runner.calls.length,0);
});
test('missing trusted checks blocks integration and asks a concrete configuration question',async t=>{
  const f=fixture(t,{technicalRecovery:false});f.store.db.prepare("UPDATE projects SET checks_json='[]'").run();const task=f.add({phase:'verify'});await f.step(false);assert.equal(f.store.task(task.id).status,'blocked');assert.match(f.store.row('SELECT * FROM questions').context,/No trusted quality/);
});
test('bounded retrospective generates improvement tasks only once',async t=>{
  const f=fixture(t,{autoImprove:true,retrospectiveEvery:1});const done=f.add();f.store.patch(done.id,{status:'done'});f.engine.settleMissions();f.engine.settleMissions();
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE kind='retrospective'").length,1);
  f.runner.run=async()=>result({tasks:[planTask('improve')]});await f.step();
  const improvement=f.store.row("SELECT * FROM tasks WHERE title='improve'");assert.equal(improvement.improvement,1);assert.equal(improvement.phase,'implement');
});
test('continuous missions reassess the roadmap and finish only on an empty justified next batch',async t=>{
  const f=fixture(t);f.store.db.prepare('UPDATE missions SET continuous=1 WHERE id=?').run(f.mission.id);
  const initial=f.add();f.store.patch(initial.id,{status:'done'});f.engine.settleMissions();
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE phase='assess'").length,1);
  f.engine.settleMissions();assert.equal(f.store.rows("SELECT * FROM tasks WHERE phase='assess'").length,1);
  f.runner.run=async()=>result({tasks:[planTask('next-batch')]});await f.step();
  const next=f.store.row("SELECT * FROM tasks WHERE title='next-batch'");f.store.patch(next.id,{status:'done'});f.engine.settleMissions();
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE phase='assess'").length,2);
  f.runner.run=async()=>result();await f.step();f.engine.settleMissions();assert.equal(f.store.mission(f.mission.id).status,'completed');
});
test('a modified pinned regression cannot pass even when the check exits zero',async t=>{
  const f=fixture(t),file=path.join(f.root,'gate.js');writeFileSync(file,'real assertions');
  const checks=pinChecks([{name:'trusted',command:['node','gate.js'],protectedFiles:['gate.js']}],f.root);
  f.store.db.prepare('UPDATE projects SET checks_json=? WHERE id=?').run(JSON.stringify(checks),f.project.id);
  writeFileSync(file,'process.exit(0)');const task=f.add({phase:'verify'});f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  await f.step();assert.equal(f.store.task(task.id).phase,'implement');assert.match(f.store.task(task.id).feedback,/Trusted regression/);
});

test('technical failures clear stale threads, persist cooldowns and leave other work runnable',async t=>{
  const f=fixture(t);const a=f.add({priority:2}),b=f.add();
  f.runner.run=async()=>result({status:'blocked',questions:[{category:'product',prompt:'Provide host executor?',context:'Win32 error 5: exec_command failed',choices:[]}]});
  await f.step();const current=f.store.task(a.id);
  assert.equal(current.status,'pending');assert.equal(current.thread_id,null);assert.ok(current.available_at>Date.now());
  assert.equal(f.store.rows('SELECT * FROM questions').length,0);assert.equal(f.store.get(`incident:${a.id}`).status,'retrying');
  assert.equal(f.store.claim().id,b.id);
});

test('automatic quality recovery never bypasses checks and resolves only after a passing gate',async t=>{
  const f=fixture(t,{maxRepairCycles:1});const task=f.add();await f.step();
  f.engine.command=async()=>({code:1,stdout:'regression failed',stderr:''});await f.step(false);
  assert.equal(f.store.rows('SELECT * FROM questions').length,0);assert.equal(f.store.task(task.id).phase,'implement');
  f.store.patch(task.id,{available_at:0});await f.step();
  assert.equal(f.store.get(`incident:${task.id}`).status,'retrying');
  f.engine.command=async()=>({code:0,stdout:'passed',stderr:''});await f.step(false);
  assert.equal(f.store.task(task.id).phase,'review');assert.equal(f.store.get(`incident:${task.id}`).status,'resolved');
});

test('host explains accepted CRLF pins to the worker and executes the same protected gate',async t=>{
  const f=fixture(t),file=path.join(f.root,'gate.js');writeFileSync(file,'assert(true);\n');
  const checks=pinChecks([{name:'trusted',command:['node','gate.js'],protectedFiles:['gate.js']}],f.root);
  f.store.db.prepare('UPDATE projects SET checks_json=? WHERE id=?').run(JSON.stringify(checks),f.project.id);
  writeFileSync(file,'assert(true);\r\n');const task=f.add();await f.step();
  assert.match(f.runner.calls[0].prompt,/"matched":true/);assert.match(f.runner.calls[0].prompt,/"lineEndingOnly":true/);
  let ran=false;f.engine.command=async command=>{ran=true;assert.deepEqual(command,['node','gate.js']);return {code:0,stdout:'passed',stderr:''};};
  await f.step(false);assert.equal(ran,true);assert.equal(f.store.task(task.id).phase,'review');assert.equal(f.store.rows('SELECT * FROM questions').length,0);
});

test('a review-only task becomes an explicit repair assignment and repeats retain diagnostic history across repair resets',async t=>{
  const f=fixture(t,{maxRepairCycles:2}),task=f.add({instructions:'Only review and report defects; return changes_requested.'});
  let calls=0;
  f.runner.run=async args=>{f.runner.calls.push(args);calls++;return result(calls<=2?{status:'changes_requested',summary:`Auditor fails on another checkout, attempt ${calls}`}:{status:'done'});};
  await f.step();assert.equal(f.store.get(`recovery:${task.id}`).count,1);
  await f.step();assert.equal(f.store.get(`recovery:${task.id}`).count,2);assert.equal(f.store.task(task.id).repairs,0);
  assert.equal(f.store.rows('SELECT * FROM questions').length,0);
  assert.equal(f.store.rows("SELECT * FROM events WHERE type='task.diagnosis_required'").length,1);
  f.store.patch(task.id,{available_at:0});await f.step();
  const prompt=f.runner.calls[2].prompt;
  assert.match(prompt,/HOST REPAIR ASSIGNMENT/);assert.match(prompt,/REPEATED FAILURE/);
  assert.match(prompt,/attempt 1/);assert.match(prompt,/attempt 2/);
  assert.equal(f.runner.calls[2].readOnly,false);assert.equal(f.runner.calls[2].threadId,null);
  assert.equal(f.store.task(task.id).phase,'verify');
  await f.step(false);await f.step();assert.equal(f.runner.calls.at(-1).readOnly,true);
  assert.doesNotMatch(f.runner.calls.at(-1).prompt,/HOST REPAIR ASSIGNMENT/);
  await f.step(false);assert.equal(f.store.task(task.id).status,'done');
});

test('scheduler acknowledges watchdog while paused without claiming work',async t=>{
  const f=fixture(t),task=f.add();let beats=0;
  f.engine.onHeartbeat=()=>beats++;f.store.set('paused',true);
  await f.engine.tick();assert.equal(beats,1);assert.equal(f.store.task(task.id).status,'pending');assert.equal(f.runner.calls.length,0);
});
