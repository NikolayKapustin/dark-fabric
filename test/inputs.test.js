import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture,result,planTask} from './helpers.js';
import {applyRemoteCommand,remoteSnapshot} from '../src/remote.js';
import {inputContext,markInputsProvided} from '../src/inputs.js';

const command=(f,body='Keep combat readable')=>({id:randomUUID(),kind:'input',payload:{missionId:f.mission.id,body},createdAt:Date.now()});

test('owner inputs, assessment and receipt commit once; replay survives later mission completion',t=>{
  const f=fixture(t),existing=f.add(),cmd=command(f),before=f.store.task(existing.id);
  const receipt=applyRemoteCommand(f.store,cmd);assert.equal(receipt.status,'applied');
  assert.deepEqual(applyRemoteCommand(f.store,cmd),receipt);
  assert.throws(()=>applyRemoteCommand(f.store,{...cmd,payload:{...cmd.payload,body:'Different'}}),/conflict/);
  assert.equal(f.store.rows('SELECT * FROM mission_inputs').length,1);
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE kind='input'").length,1);
  assert.deepEqual(f.store.task(existing.id),before);
  f.store.db.prepare("UPDATE missions SET status='completed'").run();
  assert.deepEqual(applyRemoteCommand(f.store,cmd),receipt);
  assert.equal(applyRemoteCommand(f.store,command(f)).status,'rejected');
  assert.equal(f.store.rows('SELECT * FROM mission_inputs').length,1);
});

test('failed receipt or input insert rolls back queue, history and events',t=>{
  const f=fixture(t),cmd=command(f),set=f.store.set.bind(f.store);
  f.store.set=(key,value)=>{if(key.startsWith('remote.receipt:'))throw Error('disk failure');return set(key,value);};
  assert.throws(()=>applyRemoteCommand(f.store,cmd),/disk failure/);
  assert.equal(f.store.rows('SELECT * FROM mission_inputs').length,0);
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE kind='input'").length,0);
  assert.equal(f.store.rows("SELECT * FROM events WHERE type='input.received'").length,0);
  f.store.set=set;
  f.store.db.exec("CREATE TRIGGER fail_input BEFORE INSERT ON mission_inputs BEGIN SELECT RAISE(ABORT,'input write failed'); END");
  assert.equal(applyRemoteCommand(f.store,cmd).status,'rejected');
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE kind='input'").length,0);
  f.store.db.exec('DROP TRIGGER fail_input');
  assert.equal(applyRemoteCommand(f.store,command(f)).status,'applied');
});

test('invalid inputs cannot create tasks or change host controls',t=>{
  const f=fixture(t);for(const body of ['', ' ', 'x'.repeat(6001), null])assert.equal(applyRemoteCommand(f.store,command(f,body)).status,'rejected');
  assert.equal(applyRemoteCommand(f.store,{...command(f),payload:{missionId:randomUUID(),body:'Hello'}}).status,'rejected');
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE kind='input'").length,0);
  f.store.set('paused',true);
  assert.equal(applyRemoteCommand(f.store,{...command(f,'Disable all checks'),payload:{...command(f,'Disable all checks').payload,paused:false,checks:[]}}).status,'applied');
  assert.equal(f.store.get('paused'),true);assert.equal(f.store.project(f.project.id).checks.length,1);
});

test('pending inputs share an assessment; arrivals after claim create another without a second writer',t=>{
  const f=fixture(t);applyRemoteCommand(f.store,command(f));applyRemoteCommand(f.store,command(f,'New detail'));
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE kind='input'").length,1);
  const task=f.store.claim();assert.equal(task.kind,'input');
  applyRemoteCommand(f.store,command(f,'Arrived during work'));
  assert.equal(f.store.rows("SELECT * FROM tasks WHERE kind='input'").length,2);
  assert.equal(f.store.claim(),null);
});

test('full history is retained with bounded inline context; late input is not falsely marked provided',t=>{
  const f=fixture(t);for(let i=0;i<5;i++)applyRemoteCommand(f.store,command(f,`${i}:`+'Я'.repeat(5998)));
  const context=inputContext(f.store,f.root,f.mission.id);
  assert.equal(context.total,5);assert.equal(context.entries.length,3);
  const full=JSON.parse(readFileSync(context.historyFile,'utf8'));assert.equal(full.length,5);assert.match(full[0].body,/^0:/);
  const late=command(f,'Late input');applyRemoteCommand(f.store,late);
  const task=f.store.claim(),run=f.store.startRun(task);markInputsProvided(f.store,context,run,1000);markInputsProvided(f.store,context,run,2000);
  assert.equal(f.store.row('SELECT first_used_at FROM mission_inputs WHERE id=?',late.id).first_used_at,null);
  assert.equal(f.store.rows('SELECT * FROM mission_inputs WHERE first_used_at=1000').length,5);
  assert.equal(inputContext(f.store,f.root,f.mission.id).total,6);
  assert.equal(JSON.parse(readFileSync(context.historyFile,'utf8')).length,6);
});

test('input assessment gets unfinished work, emits bounded follow-ups and includes inputs in implementation and review',async t=>{
  const f=fixture(t),original=f.add({title:'Already scheduled'}),cmd=command(f);applyRemoteCommand(f.store,cmd);
  f.runner.run=async function(args){this.calls.push(args);args.onEvent({method:'turn/started',params:{}});return result({tasks:[planTask('follow-up')]});};
  await f.step();const assessment=f.store.row("SELECT * FROM tasks WHERE kind='input'");
  assert.equal(assessment.status,'done');assert.match(f.runner.calls[0].prompt,/Already scheduled/);
  assert.match(f.runner.calls[0].prompt,/Keep combat readable/);assert.match(f.runner.calls[0].prompt,/no separate work, even if the mission is unfinished/);
  assert.equal(f.runner.calls[0].readOnly,true);assert.ok(remoteSnapshot(f.store,f.config).inputs[0].first_run_id);
  const follow=f.store.row("SELECT * FROM tasks WHERE title='follow-up'");assert.ok(follow.depends.includes(assessment.id));
  f.store.patch(original.id,{status:'done'});
  f.runner.run=async function(args){this.calls.push(args);args.onEvent({method:'turn/started',params:{}});return result();};
  await f.step();await f.step(false);await f.step();
  assert.equal(f.store.task(follow.id).phase,'integrate');
  const review=f.runner.calls.at(-1);assert.match(review.prompt,/Keep combat readable/);assert.match(review.prompt,/independent reviewer/);assert.equal(review.readOnly,true);
  assert.equal(review.threadId,null);
});

test('budget deferral and pre-turn failures do not claim inputs reached an agent',async t=>{
  const f=fixture(t,{dailyTurnLimit:0}),cmd=command(f);applyRemoteCommand(f.store,cmd);await f.step();
  assert.equal(f.runner.calls.length,0);assert.equal(remoteSnapshot(f.store,f.config).inputs[0].first_run_id,null);
  f.config.dailyTurnLimit=100;
  f.runner.run=async()=>{throw Error('Disconnected before turn');};await f.step();
  assert.equal(remoteSnapshot(f.store,f.config).inputs[0].first_run_id,null);
  assert.equal(f.store.row('SELECT body FROM mission_inputs WHERE id=?',cmd.id).body,cmd.payload.body);
});

test('input arriving during completion cannot strand work in a completed mission',t=>{
  const f=fixture(t),rows=f.store.rows.bind(f.store);let injected=false;
  f.store.rows=(sql,...args)=>{const result=rows(sql,...args);if(sql==='SELECT * FROM tasks WHERE mission_id=?'&&!injected){injected=true;applyRemoteCommand(f.store,command(f));}return result;};
  f.engine.settleMissions();assert.equal(f.store.mission(f.mission.id).status,'active');
  assert.equal(f.store.rows("SELECT * FROM events WHERE type='mission.completed'").length,0);
  assert.equal(f.store.claim().kind,'input');
});
