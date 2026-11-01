import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { applyRemoteCommand,remoteSnapshot,RemoteBridge,validateRemoteConfig } from '../src/remote.js';
const command=(kind,payload)=>({id:randomUUID(),kind,payload,createdAt:Date.now()});
test('remote answer and receipt are atomic; replay cannot duplicate or overwrite decisions',t=>{
  const f=fixture(t),task=f.add();f.store.patch(task.id,{status:'blocked'});
  const q=f.store.ask(task.id,{prompt:'Choose'}),cmd=command('answer',{id:q.id,answer:'Proceed'});
  const first=applyRemoteCommand(f.store,cmd);
  assert.equal(first.status,'applied');assert.equal(f.store.task(task.id).status,'pending');
  assert.deepEqual(applyRemoteCommand(f.store,cmd),first);
  assert.equal(f.store.rows("SELECT * FROM events WHERE type='question.answered'").length,1);
  assert.throws(()=>applyRemoteCommand(f.store,{...cmd,payload:{id:q.id,answer:'Different'}}),/conflict/);
  assert.equal(applyRemoteCommand(f.store,command('answer',{id:q.id,answer:'Different'})).status,'rejected');
  assert.equal(f.store.answers(task.id)[0].answer,'Proceed');
});
test('remote controls cannot change checks or execute arbitrary commands and expire after seven days',t=>{
  const f=fixture(t);
  assert.equal(applyRemoteCommand(f.store,command('checks',{command:['evil']})).status,'rejected');
  assert.equal(applyRemoteCommand(f.store,command('pause',{paused:true})).status,'applied');
  assert.equal(f.store.get('paused'),true);
  const old={...command('pause',{paused:false}),createdAt:Date.now()-8*86400000};
  assert.equal(applyRemoteCommand(f.store,old).status,'rejected');assert.equal(f.store.get('paused'),true);
});
test('projection excludes raw command output and quality command configuration',t=>{
  const f=fixture(t),task=f.add();f.store.event('tool',task.id,{stdout:'SECRET',command:'SECRET'});
  const run=f.store.startRun(task);f.store.finishRun(run,'done',{stdout:'SECRET'});
  const s=remoteSnapshot(f.store,f.config);assert.ok(!JSON.stringify(s).includes('SECRET'));assert.equal(s.projects[0].checks,undefined);
});
test('bridge retries commands after a lost acknowledgement and process restart exactly once',async t=>{
  const f=fixture(t),cmd=command('pause',{paused:true});f.store.set('heartbeat',{pid:1,at:Date.now()});
  const settings={url:'https://fixture.chatgpt.site',serviceToken:'s'.repeat(40),bridgeToken:'b'.repeat(40)};
  let request,fail=false;
  const fetcher=async(url,options)=>{request={url,options,body:JSON.parse(options.body)};if(fail)throw new Error('offline');return Response.json({commands:[cmd]});};
  const first=new RemoteBridge(f.store,f.config,settings,{fetcher});await first.sync();
  fail=true;await assert.rejects(first.sync(),/offline/);assert.equal(first.receipts.length,1);
  fail=false;const second=new RemoteBridge(f.store,f.config,settings,{fetcher});await second.sync();await second.sync();
  assert.equal(request.body.receipts[0].status,'applied');assert.equal(request.options.redirect,'error');
  assert.equal(f.store.rows("SELECT * FROM events WHERE type='factory.paused'").length,1);
  f.store.set('heartbeat',{pid:null,stopped:true,at:Date.now()});const idle=new RemoteBridge(f.store,f.config,settings,{fetcher});await idle.sync();assert.equal(idle.receipts.length,0);
  assert.throws(()=>validateRemoteConfig({...settings,url:'http://fixture.chatgpt.site'}),/HTTPS/);
  assert.throws(()=>validateRemoteConfig({...settings,url:'https://unrelated.example'}),/Sites/);
});
test('long histories remain bounded without losing total task counts',t=>{
  const f=fixture(t),long='Я'.repeat(6000);
  for(let i=0;i<180;i++){
    if(i<40)assert.equal(applyRemoteCommand(f.store,command('input',{missionId:f.mission.id,body:long})).status,'applied');
    const task=f.add({instructions:long,criteria:Array(15).fill(long)});
    f.store.patch(task.id,{feedback:long,result:{summary:long}});
    if(i<30){const run=f.store.startRun(task);f.store.db.prepare('INSERT INTO run_agents VALUES (?,?)').run(run,JSON.stringify({agent:long,reason:long,brief:{criteria:['Я'.repeat(100000)]},profile:{focus:long}}));}
    if(i<50)f.store.ask(task.id,{prompt:long,context:long,choices:Array(8).fill(long)});
  }
  const s=remoteSnapshot(f.store,f.config);assert.ok(Buffer.byteLength(JSON.stringify(s))<1200000);
  assert.equal(s.taskCounts.pending,181);assert.equal(s.totalQuestions,50);assert.ok(s.tasks.length<=150);
  assert.equal(s.inputCount,40);assert.equal(s.inputs.length,30);assert.ok(s.inputs[0].truncated);
  assert.equal(s.usage.assignments.length,30);assert.equal(s.usage.assignments[0].brief,undefined);assert.ok(s.usage.assignments[0].agent.length<=300);
});
test('command expiry uses server time even when the factory clock differs',async t=>{
  const f=fixture(t);f.store.set('heartbeat',{pid:1,at:Date.now()});
  const serverTime=Date.now()+86400000,cmd={...command('pause',{paused:true}),createdAt:serverTime};
  const remote={url:'https://fixture.chatgpt.site',serviceToken:'s'.repeat(40),bridgeToken:'b'.repeat(40)};
  const bridge=new RemoteBridge(f.store,f.config,remote,{fetcher:async()=>Response.json({storedAt:serverTime,commands:[cmd]})});
  await bridge.sync();assert.equal(bridge.receipts[0].status,'applied');assert.equal(f.store.get('paused'),true);
});
