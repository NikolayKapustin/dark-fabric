import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync,unlinkSync,existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspaces,git,inspectRepository,IntegrationError } from '../src/git.js';
import { uid } from '../src/store.js';

test('Windows repository and replay identities accept canonical path aliases but reject subdirectories and wrong branches',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df-path-identity-')),repo=path.join(root,'MixedCaseSource');mkdirSync(repo);
  try{
    writeFileSync(path.join(repo,'base.txt'),'base');await git(repo,['init','-b','main']);await git(repo,['add','.']);await git(repo,['-c','user.name=Test','-c','user.email=test@local','commit','-m','base']);
    const canonical=await inspectRepository(repo);
    for(const alias of [repo.replace(/^[A-Z]:/,drive=>drive.toLowerCase()),repo.toUpperCase()])assert.deepEqual(await inspectRepository(alias),canonical);
    const subdirectory=path.join(repo,'child');mkdirSync(subdirectory);
    await assert.rejects(inspectRepository(subdirectory.toUpperCase()),/repository root, not a subdirectory/);
    const ws=new Workspaces(path.join(root,'factory')),mission=await ws.mission(repo.toUpperCase(),uid());
    await ws.create(repo,mission.branch,mission.workspace.toUpperCase(),mission.baseSha);
    await assert.rejects(ws.create(repo,'wrong-branch',mission.workspace.toUpperCase(),mission.baseSha),/unexpected identity/);
    const child=path.join(mission.workspace,'child');mkdirSync(child);
    await assert.rejects(ws.create(repo,mission.branch,child.toUpperCase(),mission.baseSha),/unexpected identity/);
    assert.equal(await ws.readOnlyHead(mission.workspace),canonical.sha);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('real Git worktrees preserve source, isolate blocked work, and integrate replayably',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df-git-')),repo=path.join(root,'source');mkdirSync(repo);
  try{
    writeFileSync(path.join(repo,'base.txt'),'base');await git(repo,['init','-b','main']);await git(repo,['add','.']);await git(repo,['-c','user.name=Test','-c','user.email=test@local','commit','-m','base']);
    const ws=new Workspaces(path.join(root,'factory'));const mission=await ws.mission(repo,uid());
    const a={id:uid(),title:'A'},b={id:uid(),title:'B'};
    Object.assign(a,await ws.task({path:repo},mission,a));Object.assign(b,await ws.task({path:repo},mission,b));
    writeFileSync(path.join(a.workspace,'blocked.txt'),'partial');writeFileSync(path.join(b.workspace,'ready.txt'),'ready');
    b.checkpoint_sha=await ws.checkpoint(b);assert.equal(await ws.cleanAt(b),true);
    assert.deepEqual(await ws.integrate(mission,b),{integrated:true});assert.deepEqual(await ws.integrate(mission,b),{alreadyIntegrated:true});
    assert.equal((await git(repo,['status','--porcelain'])).stdout,'');assert.equal(readFileSync(path.join(a.workspace,'blocked.txt'),'utf8'),'partial');
    a.checkpoint_sha=await ws.checkpoint(a);assert.deepEqual(await ws.integrate(mission,a),{stale:true});
    assert.equal(await ws.sync(a,mission),'');a.checkpoint_sha=await ws.checkpoint(a);assert.deepEqual(await ws.integrate(mission,a),{integrated:true});
    writeFileSync(path.join(a.workspace,'new.txt'),'mutation');await assert.rejects(ws.integrate(mission,a),/checkpoint changed/);
    writeFileSync(path.join(mission.workspace,'human.txt'),'human');await assert.rejects(ws.integrate(mission,b),/external changes/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('integration reports operational Git failures and safely retries the same reviewed checkpoint',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df-merge-error-')),repo=path.join(root,'source');mkdirSync(repo);
  try{
    writeFileSync(path.join(repo,'base.txt'),'base');await git(repo,['init','-b','main']);await git(repo,['add','.']);await git(repo,['-c','user.name=Test','-c','user.email=test@local','commit','-m','base']);
    const ws=new Workspaces(path.join(root,'factory')),mission=await ws.mission(repo,uid()),task={id:uid(),title:'Ready'};
    Object.assign(task,await ws.task({path:repo},mission,task));writeFileSync(path.join(task.workspace,'ready.txt'),'reviewed bytes');task.checkpoint_sha=await ws.checkpoint(task);
    const before=await ws.readOnlyHead(mission.workspace),lock=(await git(mission.workspace,['rev-parse','--git-path','index.lock'])).stdout.trim();
    writeFileSync(lock,'another Git operation');
    await assert.rejects(ws.integrate(mission,task),error=>error instanceof IntegrationError&&/index\.lock/.test(error.message));
    assert.equal(await ws.readOnlyHead(mission.workspace),before);assert.equal(await ws.cleanAt(task),true);
    unlinkSync(lock);assert.deepEqual(await ws.integrate(mission,task),{integrated:true});
    assert.equal(readFileSync(path.join(mission.workspace,'ready.txt'),'utf8'),'reviewed bytes');
    assert.deepEqual(await ws.integrate(mission,task),{alreadyIntegrated:true});
    const external=path.join(mission.workspace,'external.txt');writeFileSync(external,'preserve host changes');
    await assert.rejects(ws.integrate(mission,task),error=>error instanceof IntegrationError&&/external changes/.test(error.message));
    assert.equal(readFileSync(external,'utf8'),'preserve host changes');unlinkSync(external);
    assert.deepEqual(await ws.integrate(mission,task),{alreadyIntegrated:true});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Windows integration handles reports that exceed MAX_PATH only in the longer mission checkout',{skip:process.platform!=='win32'},async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df-longpath-')),repo=path.join(root,'source');mkdirSync(repo);
  try{
    writeFileSync(path.join(repo,'base.txt'),'base');await git(repo,['init','-b','main']);await git(repo,['config','core.longpaths','false']);await git(repo,['add','.']);await git(repo,['-c','user.name=Test','-c','user.email=test@local','commit','-m','base']);
    const ws=new Workspaces(path.join(root,'factory')),mission=await ws.mission(repo,uid()),task={id:uid(),title:'Retained report'};
    Object.assign(task,await ws.task({path:repo},mission,task));
    const relative='e'.repeat(259-task.workspace.length-1-'/latest.txt'.length)+'/latest.txt';
    const report=path.join(task.workspace,relative),destination=path.join(mission.workspace,relative);
    assert.equal(report.length,259);assert.equal(destination.length,262);
    mkdirSync(path.dirname(report),{recursive:true});writeFileSync(report,'retained evidence');task.checkpoint_sha=await ws.checkpoint(task);
    assert.deepEqual(await ws.integrate(mission,task),{integrated:true});
    assert.equal(readFileSync(destination,'utf8'),'retained evidence');assert.equal(await ws.readOnlyHead(mission.workspace),task.checkpoint_sha);
    assert.deepEqual(await ws.integrate(mission,task),{alreadyIntegrated:true});
    assert.equal((await git(repo,['config','--local','--get','core.longpaths'])).stdout.trim(),'false');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('review runtime outputs stay outside the checkpoint while new reports and retained-evidence edits still fail the gate',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df-review-output-')),repo=path.join(root,'source');mkdirSync(path.join(repo,'qa'),{recursive:true});
  try{
    writeFileSync(path.join(repo,'.gitignore'),'/qa/local-runs/\n');
    writeFileSync(path.join(repo,'qa','retained.json'),'{"passed":true}\n');
    await git(repo,['init','-b','main']);await git(repo,['add','.']);await git(repo,['-c','user.name=Test','-c','user.email=test@local','commit','-m','base']);
    const ws=new Workspaces(path.join(root,'factory')),mission=await ws.mission(repo,uid()),task={id:uid(),title:'review output'};
    Object.assign(task,await ws.task({path:repo},mission,task));task.checkpoint_sha=await ws.checkpoint(task);
    const runtime=path.join(task.workspace,'qa','local-runs');mkdirSync(runtime);writeFileSync(path.join(runtime,'fresh.json'),'{"passed":true}');
    assert.equal(await ws.cleanAt(task),true);await ws.integrate(mission,task);
    assert.equal(existsSync(path.join(mission.workspace,'qa','local-runs','fresh.json')),false);
    const newReport=path.join(task.workspace,'qa','new-review.json');writeFileSync(newReport,'new evidence');
    assert.equal(await ws.cleanAt(task),false);await assert.rejects(ws.integrate(mission,task),/checkpoint changed/);
    unlinkSync(newReport);
    writeFileSync(path.join(task.workspace,'qa','retained.json'),'{"passed":false}\n');
    assert.equal(await ws.cleanAt(task),false);await assert.rejects(ws.integrate(mission,task),/checkpoint changed/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('discovery persists its original pin and preserves dirty or committed attempts in isolated checkouts across recovery',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df-discovery-')),repo=path.join(root,'source');mkdirSync(repo);
  try{
    writeFileSync(path.join(repo,'base.txt'),'base');await git(repo,['init','-b','main']);await git(repo,['add','.']);await git(repo,['-c','user.name=Test','-c','user.email=test@local','commit','-m','base']);
    const ws=new Workspaces(path.join(root,'factory')),mission=await ws.mission(repo,uid());let task={id:uid(),title:'Discovery'};
    const save=fields=>{task={...task,...fields};return task;};task=await ws.discovery({path:repo},mission,task,save);const baseline=task.checkpoint_sha,first=task.workspace;
    writeFileSync(path.join(first,'base.txt'),'accidental committed change');await ws.checkpoint(task);
    task=await new Workspaces(path.join(root,'factory')).discovery({path:repo},mission,task,save);
    assert.notEqual(task.workspace,first);assert.equal(task.checkpoint_sha,baseline);assert.equal(readFileSync(path.join(first,'base.txt'),'utf8'),'accidental committed change');assert.equal(await ws.cleanAt(task),true);
    const second=task.workspace;writeFileSync(path.join(second,'partial.txt'),'uncommitted evidence');
    task=await ws.discovery({path:repo},mission,task,save);assert.notEqual(task.workspace,second);assert.equal(readFileSync(path.join(second,'partial.txt'),'utf8'),'uncommitted evidence');assert.equal(await ws.cleanAt(task),true);
    assert.equal(await ws.readOnlyHead(mission.workspace),baseline);assert.equal(await ws.readOnlyHead(repo),baseline);
  }finally{rmSync(root,{recursive:true,force:true});}
});
