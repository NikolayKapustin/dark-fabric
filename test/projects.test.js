import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {fixture,result,planTask} from './helpers.js';
import {requestProject,updateProject,queueDiscovery,provisionProject,processProjectIntake,recordProjectMetrics,metricHash} from '../src/projects.js';
import {applyRemoteCommand,remoteSnapshot} from '../src/remote.js';
import {validateStageResult} from '../src/contracts.js';
import {Store} from '../src/store.js';

export const profile={domain:'data',theme:'ocean',tagline:'Reliable signals',problem:'Understand customer demand',audience:'Analysts',scope:['Daily analysis'],outOfScope:['Trading'],constraints:['Local data'],risks:['Missing data'],alternatives:[{name:'Existing database',tradeoff:'Less setup',decision:'Preferred'},{name:'Custom store',tradeoff:'High cost',decision:'Rejected'}],metrics:[{id:'coverage',label:'Coverage',unit:'%',target:'95',method:'Count covered records in fixture'},{id:'latency',label:'Latency',unit:'ms',target:'100',method:'Measure representative query latency'}],milestones:[{title:'Baseline',outcome:'Validated fixture'},{title:'Delivery',outcome:'Acceptance passes'}]};
const payload={name:'New analytics',goal:'Measure demand with reproducible data checks',priority:4};
const command=(kind,payload)=>({id:randomUUID(),kind,payload,createdAt:Date.now()});
function other(f,priority=1){const p=f.store.addProject({name:'Other',path:path.join(f.root,randomUUID()),priority});const m=f.store.addMission({projectId:p.id,goal:'Other goal',workspace:f.root,branch:'other',baseSha:'base'});f.store.db.prepare("UPDATE tasks SET status='done' WHERE mission_id=?").run(m.id);return {p,m,t:f.store.addTask({missionId:m.id,title:'Other work',instructions:'Implement',criteria:['Test']})};}

test('weighted priorities share runnable slots without starving lower priorities; pauses preserve active work',t=>{
  const f=fixture(t),a=f.add(),b=other(f,1);updateProject(f.store,{id:f.project.id,priority:5});
  const counts={[a.id]:0,[b.t.id]:0};for(let i=0;i<60;i++){const task=f.store.claim();counts[task.id]++;f.store.patch(task.id,{status:'pending',lease:null});}
  assert.equal(counts[a.id],50);assert.equal(counts[b.t.id],10);
  const active=f.store.claim();updateProject(f.store,{id:f.store.mission(active.mission_id).project_id,paused:true});assert.equal(f.store.task(active.id).status,'running');
  const next=f.store.claim();assert.ok(next&&next.mission_id!==active.mission_id);
  f.store.patch(active.id,{status:'pending',lease:null});assert.equal(f.store.claim(),null);
});

test('blocked, cooling or dependency-limited high priority projects do not monopolize the factory',t=>{
  const f=fixture(t),a=f.add(),b=other(f);updateProject(f.store,{id:f.project.id,priority:5});
  f.store.patch(a.id,{available_at:Date.now()+60000});assert.equal(f.store.claim().id,b.t.id);
  f.store.patch(b.t.id,{status:'done'});f.store.patch(a.id,{available_at:0,status:'blocked'});assert.equal(f.store.claim(),null);
});

test('new, resumed and newly runnable projects share the current clock instead of catching up stale idle projects',t=>{
  const f=fixture(t),a=f.add(),idle=other(f,3);f.store.patch(idle.t.id,{status:'done'});
  for(let i=0;i<120;i++){const claimed=f.store.claim();assert.equal(claimed.id,a.id);f.store.patch(a.id,{status:'pending',lease:null});}
  const fresh=other(f,3),counts={};
  for(let i=0;i<20;i++){const c=f.store.claim();counts[c.id]=(counts[c.id]||0)+1;f.store.patch(c.id,{status:'pending',lease:null});}
  assert.equal(counts[a.id],10);assert.equal(counts[fresh.t.id],10);
  f.store.patch(fresh.t.id,{status:'done'});f.store.patch(idle.t.id,{status:'pending'});
  const recovered={};for(let i=0;i<20;i++){const c=f.store.claim();recovered[c.id]=(recovered[c.id]||0)+1;f.store.patch(c.id,{status:'pending',lease:null});}
  assert.equal(recovered[a.id],10);assert.equal(recovered[idle.t.id],10);
  updateProject(f.store,{id:idle.p.id,paused:true});for(let i=0;i<40;i++){f.store.claim();f.store.patch(a.id,{status:'pending',lease:null});}
  updateProject(f.store,{id:idle.p.id,paused:false});const resumed={};for(let i=0;i<20;i++){const c=f.store.claim();resumed[c.id]=(resumed[c.id]||0)+1;f.store.patch(c.id,{status:'pending',lease:null});}
  assert.equal(resumed[a.id],10);assert.equal(resumed[idle.t.id],10);
});

test('project requests and receipts are atomic, idempotent and do not allow remote commands or paths',t=>{
  const f=fixture(t),cmd=command('project.create',{...payload,path:'C:/Windows',checks:[{command:['evil']}]});
  assert.equal(applyRemoteCommand(f.store,cmd).status,'applied');applyRemoteCommand(f.store,cmd);
  const intake=f.store.row('SELECT * FROM project_intakes');assert.equal(intake.payload.path,undefined);assert.equal(intake.payload.checks,undefined);
  assert.equal(f.store.rows('SELECT * FROM project_intakes').length,1);assert.equal(f.store.rows('SELECT * FROM projects').length,1);
  assert.throws(()=>applyRemoteCommand(f.store,{...cmd,payload:{...payload,priority:1}}),/conflict/);
  assert.equal(applyRemoteCommand(f.store,command('project.create',{...payload,priority:0})).status,'rejected');
  const set=f.store.set.bind(f.store);f.store.set=(key,value)=>{if(key.startsWith('remote.receipt:'))throw Error('disk');set(key,value);};
  assert.throws(()=>applyRemoteCommand(f.store,command('project.create',payload)),/disk/);assert.equal(f.store.rows('SELECT * FROM project_intakes').length,1);
});

test('provisioning replays Git effects after DB failure and creates exactly one project and discovery pipeline',async t=>{
  const f=fixture(t),id=randomUUID();requestProject(f.store,id,payload);const intake=f.store.row('SELECT * FROM project_intakes WHERE id=?',id);
  const original=f.store.addMission.bind(f.store);f.store.addMission=()=>{throw Error('simulated crash before mission commit');};
  await assert.rejects(provisionProject(f.store,f.config,intake),/simulated crash/);assert.equal(f.store.project(id),undefined);
  f.store.addMission=original;await provisionProject(f.store,f.config,intake);await provisionProject(f.store,f.config,intake);
  const p=f.store.project(id),tasks=f.store.rows('SELECT * FROM tasks WHERE mission_id=?',intake.mission_id);
  assert.equal(p.priority,4);assert.equal(tasks.length,2);assert.equal(tasks[0].phase,'discover');assert.deepEqual(tasks[1].depends,[tasks[0].id]);
  assert.equal(f.store.mission(intake.mission_id).continuous,1);assert.equal(p.checks.length,2);
  assert.equal(readFileSync(path.join(p.path,'PROJECT_BRIEF.md'),'utf8').includes(payload.goal),true);
});

test('unowned directories are preserved and intake failures back off without creating half projects',async t=>{
  const f=fixture(t),id=randomUUID();requestProject(f.store,id,payload);const dir=path.join(f.root,'projects',id);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'keep.txt'),'keep');
  await processProjectIntake(f.store,f.config);const intake=f.store.row('SELECT * FROM project_intakes WHERE id=?',id);
  assert.equal(intake.status,'retrying');assert.equal(intake.attempts,1);assert.ok(intake.available_at>Date.now());
  assert.equal(readFileSync(path.join(dir,'keep.txt'),'utf8'),'keep');assert.equal(f.store.project(id),undefined);
});

test('discovery requires fresh independent review before enabling planning and preserves trusted checks',async t=>{
  const f=fixture(t),checks=f.store.project(f.project.id).checks,task=queueDiscovery(f.store,f.project.id);assert.equal(queueDiscovery(f.store,f.project.id).id,task.id);
  f.runner.run=async function(args){this.calls.push(args);args.onThread('research-thread');return result({profile});};
  await f.step();assert.equal(f.store.task(task.id).phase,'discovery_review');assert.deepEqual(f.store.project(f.project.id).profile,{});
  f.runner.run=async function(args){this.calls.push(args);return result({status:'changes_requested',summary:'Clarify the measurement method'});};
  await f.step();assert.equal(f.store.task(task.id).phase,'discover');assert.equal(f.runner.calls.at(-1).threadId,null);
  f.store.patch(task.id,{available_at:0});f.runner.run=async()=>result({profile});await f.step();
  f.runner.run=async()=>result();await f.step();assert.equal(f.store.task(task.id).status,'done');assert.equal(f.store.project(f.project.id).profile.domain,'data');
  assert.deepEqual(f.store.project(f.project.id).checks,checks);
});

test('discovery schemas reject executable styles, missing research evidence and fabricated metric IDs',t=>{
  const f=fixture(t),task={phase:'discover'};
  assert.throws(()=>validateStageResult(result({profile:{...profile,theme:'javascript:evil'}}),task,f.project),/Invalid discovery/);
  assert.throws(()=>validateStageResult(result({profile,evidence:[]}),task,f.project),/primary-source/);
  assert.throws(()=>validateStageResult(result({measurements:[{id:'unknown',value:5,source:'test',note:'measured'}]}),{phase:'review'},{...f.project,profile}),/Unknown/);
});

test('blocked initial discovery cannot be bypassed by owner-input assessments or other new work',t=>{
  const f=fixture(t),task=queueDiscovery(f.store,f.project.id),b=other(f);f.store.block(task,[{prompt:'Choose audience'}]);
  const cmd=command('input',{missionId:f.mission.id,body:'Add a new feature'});applyRemoteCommand(f.store,cmd);f.add({priority:1000});
  assert.equal(f.store.claim().id,b.t.id);f.store.patch(b.t.id,{status:'done'});assert.equal(f.store.claim(),null);
  f.store.answer(f.store.row('SELECT id FROM questions WHERE task_id=?',task.id).id,'Analysts');assert.equal(f.store.claim().id,task.id);
});

test('domain measurements become visible only after reviewed checkpoint integration and are project scoped',async t=>{
  const f=fixture(t);f.store.db.prepare('UPDATE projects SET profile_json=? WHERE id=?').run(JSON.stringify({...profile,reviewedAt:1}),f.project.id);const b=other(f);
  f.store.patch(b.t.id,{status:'done'});const task=f.add({phase:'review'});f.store.patch(task.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  f.runner.run=async()=>result({measurements:[{id:'coverage',value:97,source:'qa/coverage.json',note:'Measured fixture'}]});
  await f.step();assert.equal(f.store.rows('SELECT * FROM project_metrics').length,0);
  await f.step(false);const snapshot=remoteSnapshot(f.store,f.config),a=snapshot.projects.find(p=>p.id===f.project.id),otherProject=snapshot.projects.find(p=>p.id===b.p.id);
  assert.equal(a.measurements[0].value,97);assert.equal(a.measurements[0].checkpoint,'sha-1');assert.equal(otherProject.measurements.length,0);
  assert.equal(a.roadmap.title,'fixture');assert.equal(a.roadmap.roots.includes('world'),false);
});

test('additive migration preserves existing projects and pins',t=>{
  const f=fixture(t),before=f.store.project(f.project.id);for(const column of ['priority','paused','virtual_time','profile_json','discovery_json'])f.store.db.exec('ALTER TABLE projects DROP COLUMN '+column);
  const reopened=new Store(path.join(f.root,'test.sqlite'));try{const p=reopened.project(f.project.id);assert.equal(p.name,before.name);assert.deepEqual(p.checks,before.checks);assert.equal(p.priority,3);assert.equal(p.paused,0);}finally{reopened.close();}
});

test('rediscovery cannot relabel existing or in-flight measurements with new units or methods',async t=>{
  const f=fixture(t),setProfile=p=>f.store.db.prepare('UPDATE projects SET profile_json=? WHERE id=?').run(JSON.stringify({...p,reviewedAt:1}),f.project.id);
  setProfile(profile);const first=f.add({phase:'review'});f.store.patch(first.id,{workspace:f.root,checkpoint_sha:'sha-1'});
  f.runner.run=async()=>result({measurements:[{id:'latency',value:97,source:'qa/latency.json',note:'Original measurement'}]});
  await f.step();await f.step(false);assert.equal(remoteSnapshot(f.store,f.config).projects[0].measurements.length,1);
  const second=f.add({phase:'review'});f.store.patch(second.id,{workspace:f.root,checkpoint_sha:'sha-2'});await f.step();
  setProfile({...profile,metrics:profile.metrics.map(m=>m.id==='latency'?{...m,unit:'s',method:'Another data set'}:m)});
  assert.equal(remoteSnapshot(f.store,f.config).projects[0].measurements.length,0);
  await f.step(false);assert.equal(remoteSnapshot(f.store,f.config).projects[0].measurements.length,0);
  assert.equal(f.store.row('SELECT * FROM project_metrics').checkpoint,'sha-1');
});

test('twenty large project roadmaps fit the relay byte budget and retain every active task and navigation root',t=>{
  const f=fixture(t);const projects=[{p:f.project,m:f.mission},...Array.from({length:19},()=>other(f,3))];
  for(const {p,m} of projects){f.store.db.prepare('UPDATE projects SET profile_json=? WHERE id=?').run(JSON.stringify({...profile,reviewedAt:1}),p.id);
    for(let i=0;i<40;i++){const task=f.store.addTask({missionId:m.id,title:'Я'.repeat(300),instructions:'Я'.repeat(6000),criteria:Array(5).fill('Я'.repeat(500))});f.store.patch(task.id,{status:i===0?'running':'pending',result:{summary:'Я'.repeat(6000)}});}
  }
  const snapshot=remoteSnapshot(f.store,f.config);assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=1100000);assert.equal(snapshot.projects.length,20);
  for(const p of snapshot.projects){assert.equal(Object.values(p.roadmap.nodes).filter(n=>n.status==='running').length,1);for(const id of p.roadmap.roots)assert.ok(p.roadmap.nodes[id]);assert.ok(p.roadmap.excerpt);assert.ok(p.roadmap.shownQueue<p.roadmap.totalQueue);
    assert.ok(snapshot.tasks.some(t=>t.id===p.activity.current.id));
    for(const node of Object.values(p.roadmap.nodes))for(const child of node.children||[])assert.ok(p.roadmap.nodes[child]);}
});

test('fully populated CJK profiles and accepted metric evidence share the global byte budget',t=>{
  const f=fixture(t),long='界'.repeat(600),expanded={...profile,tagline:long,problem:long,audience:long,summary:long,reviewedAt:1};
  for(const k of ['scope','outOfScope','constraints','risks'])expanded[k]=Array(8).fill(long);
  expanded.alternatives=Array.from({length:4},()=>({name:long,tradeoff:long,decision:long}));
  expanded.milestones=Array.from({length:8},()=>({title:long,outcome:long}));
  expanded.metrics=Array.from({length:8},(_,i)=>({id:'metric_with_valid_long_identifier_'+i,label:long,unit:long,target:long,method:long}));
  expanded.evidence=Array.from({length:8},()=>({source:long,finding:long}));
  for(const {p,m} of [{p:f.project,m:f.mission},...Array.from({length:19},()=>other(f,3))]){
    f.store.db.prepare('UPDATE projects SET profile_json=? WHERE id=?').run(JSON.stringify(expanded),p.id);
    const task=f.store.addTask({missionId:m.id,title:long,instructions:long});f.store.patch(task.id,{checkpoint_sha:'sha'});
    recordProjectMetrics(f.store,f.store.project(p.id),f.store.task(task.id),{measurements:expanded.metrics.map(d=>({id:d.id,value:99,source:long,note:long})),metricDefinitions:Object.fromEntries(expanded.metrics.map(d=>[d.id,metricHash(d)]))});
    for(let i=0;i<3;i++){
      const blocked=f.store.addTask({missionId:m.id,title:long,instructions:long.repeat(10),criteria:Array(15).fill(long)});
      f.store.patch(blocked.id,{feedback:long.repeat(10),result:{summary:long.repeat(10)}});
      f.store.block(blocked,[{prompt:long.repeat(3),context:long,choices:Array(8).fill(long)}]);
    }
  }
  const s=remoteSnapshot(f.store,f.config);assert.ok(Buffer.byteLength(JSON.stringify(s))<=1100000);
  assert.equal(s.questions.length,50);
  for(const p of s.projects){assert.equal(p.profile.metrics.length,8);assert.equal(p.measurements.length,8);assert.equal(p.measurements[0].value,99);assert.ok(p.excerpt);assert.deepEqual(p.profile.metrics.map(m=>m.id),expanded.metrics.map(m=>m.id));assert.ok(s.tasks.some(t=>t.id===p.activity.current.id));}
});
