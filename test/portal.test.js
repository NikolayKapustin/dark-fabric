import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer as netServer} from 'node:net';
import {Store} from '../src/store.js';
import {loadConfig} from '../src/config.js';
import {startPortal} from '../src/portal.js';
import {startBackground,stopBackground,servicePids} from '../src/lifecycle.js';
import {projectRequests} from '../public/project-request.js';

async function setup(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'df portal space '));
  const socket=netServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config={...loadConfig(root),port,codexPath:'missing-codex-must-not-run'};
  writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
  const store=new Store(path.join(root,'factory.sqlite'));store.set('paused',true);store.set('heartbeat',{at:1,pid:123,stopped:true,active:[]});store.close();
  writeFileSync(path.join(root,'stop'),'user stop');writeFileSync(path.join(root,'remote.stop'),'user bridge stop');
  let cleanup=async()=>{};t.after(async()=>{await cleanup();await stopBackground(root);rmSync(root,{recursive:true,force:true});});return {root,config,setCleanup:fn=>{cleanup=fn;}};
}
const request=(portal,token,route,data,headers={})=>fetch(portal.url+route,{method:data===undefined?'GET':'POST',headers:{'X-Dark-Fabric-Token':token,'Content-Type':'application/json',Connection:'close',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});

test('portal-only keeps stopped work untouched, rejects a second owner and preserves pause',async t=>{
  const {root,config,setCleanup}=await setup(t),db=new Store(path.join(root,'factory.sqlite'));
  const project=db.addProject({name:'Example',path:root}),mission=db.addMission({projectId:project.id,goal:'Example',branch:'mission',workspace:root,baseSha:'base'});
  const task=db.rows('SELECT * FROM tasks WHERE mission_id=?',mission.id)[0];
  db.db.prepare("UPDATE tasks SET status='running',lease='old-lease' WHERE id=?").run(task.id);db.close();
  const portal=await startPortal(config);setCleanup(()=>portal.close());
  const token=readFileSync(path.join(root,'operator.token'),'utf8');
  assert.equal(portal.server.address().address,'127.0.0.1');
  const before=await (await request(portal,token,'/api/state')).json();
  assert.equal(before.portal.mode,'portal');assert.equal(before.paused,true);assert.equal(before.heartbeat.at,1);
  assert.equal(before.tasks[0].status,'running');assert.equal(before.tasks[0].lease,'old-lease');
  assert.equal((await request(portal,token,'/api/pause',{paused:false})).status,400);
  assert.equal((await request(portal,token,'/api/settings',{quotaReservePercent:15})).status,200);
  await assert.rejects(startPortal(config),/already running/);
  assert.equal(readFileSync(path.join(root,'stop'),'utf8'),'user stop');
  assert.equal(readFileSync(path.join(root,'remote.stop'),'utf8'),'user bridge stop');
  const after=await (await request(portal,token,'/api/state')).json();assert.equal(after.paused,true);assert.deepEqual(after.runs,before.runs);assert.equal(after.heartbeat.at,1);
  await portal.close();assert.deepEqual(servicePids(root),[]);
});

test('portal bind failure and live supervisors fail closed; retry releases all locks',async t=>{
  const {root,config,setCleanup}=await setup(t),occupied=netServer();await new Promise(r=>occupied.listen(config.port,'127.0.0.1',r));
  try{await assert.rejects(startPortal(config),/EADDRINUSE/);}finally{await new Promise(r=>occupied.close(r));}
  assert.deepEqual(servicePids(root),[]);assert.equal(existsSync(path.join(root,'lifecycle/service.lock')),false);
  const dir=path.join(root,'remote-supervisor');mkdirSync(dir);writeFileSync(path.join(dir,'service.lock'),JSON.stringify({pid:process.pid}));
  await assert.rejects(startPortal(config),/supervisor is running/);rmSync(path.join(dir,'service.lock'));
  const portal=await startPortal(config);await portal.close();
  assert.equal(readFileSync(path.join(root,'stop'),'utf8'),'user stop');assert.deepEqual(servicePids(root),[]);
});

test('local project intake authenticates, validates and replays exactly once across restart',async t=>{
  const {root,config,setCleanup}=await setup(t);let portal=await startPortal(config);setCleanup(()=>portal.close());
  const token=readFileSync(path.join(root,'operator.token'),'utf8');
  const payload={id:randomUUID(),name:'Local project',goal:'Build a local tool',priority:3};
  const memory=new Map(),storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  const browser=projectRequests(storage,'installation');assert.deepEqual(browser.prepare(payload),payload);
  assert.equal((await request(portal,'bad','/api/projects',payload)).status,401);
  assert.equal((await request(portal,token,'/api/projects',payload,{Origin:'https://example.org'})).status,403);
  assert.equal((await request(portal,token,'/api/projects',{...payload,checks:[]})).status,400);
  assert.equal((await request(portal,token,'/api/projects',{...payload,priority:0})).status,400);
  assert.equal((await request(portal,token,'/api/projects',payload)).status,201);
  assert.equal((await request(portal,token,'/api/projects',payload)).status,201);
  assert.equal((await request(portal,token,'/api/projects',{...payload,goal:'different'})).status,400);
  let state=await (await request(portal,token,'/api/state')).json();
  assert.equal(state.intakes.length,1);assert.equal(state.projects.length,0);assert.equal(state.tasks.length,0);assert.equal(state.intakes[0].status,'pending');
  assert.equal(state.events.filter(e=>e.type==='project.requested').length,1);
  await portal.close();portal=await startPortal(config);
  const reloaded=projectRequests(storage,'installation');
  assert.deepEqual(reloaded.prepare({...payload,id:randomUUID(),name:'edited'}),payload);
  assert.equal((await request(portal,token,'/api/projects',reloaded.read())).status,201);
  reloaded.acknowledge(payload.id);assert.equal(reloaded.read(),null);
  state=await (await request(portal,token,'/api/state')).json();assert.equal(state.intakes.length,1);assert.equal(state.paused,true);
  // A failed event write must roll back the intake with it.
  const db=new Store(path.join(root,'factory.sqlite'));
  db.db.exec("CREATE TRIGGER reject_project_event BEFORE INSERT ON events WHEN NEW.type='project.requested' BEGIN SELECT RAISE(ABORT,'disk fixture'); END");db.close();
  assert.equal((await request(portal,token,'/api/projects',{...payload,id:randomUUID()})).status,400);
  state=await (await request(portal,token,'/api/state')).json();assert.equal(state.intakes.length,1);
});

test('CLI portal stops through normal shutdown; explicit factory start remains separate',async t=>{
  const {root,config,setCleanup}=await setup(t),cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  const child=spawn(process.execPath,[cli,'--home',root,'portal'],{windowsHide:true,stdio:'ignore'});
  const closed=new Promise(resolve=>child.once('close',resolve));
  setCleanup(async()=>{await stopBackground(root);if(child.exitCode===null)child.kill();await closed;});
  for(let i=0;i<100;i++){
    try{if((await (await fetch(`http://127.0.0.1:${config.port}/health`)).json()).mode==='portal')break;}catch{}
    await sleep(50);
  }
  assert.equal((await (await fetch(`http://127.0.0.1:${config.port}/health`)).json()).mode,'portal');
  await assert.rejects(startBackground(root),/foreground/);
  assert.equal(readFileSync(path.join(root,'stop'),'utf8'),'user stop');
  await stopBackground(root);assert.equal(await closed,0);assert.deepEqual(servicePids(root),[]);
  assert.equal((await startBackground(root,{respectStop:true})).stopped,true);
  await startBackground(root);
  assert.equal((await (await fetch(`http://127.0.0.1:${config.port}/health`)).json()).mode,'factory');
  const db=new Store(path.join(root,'factory.sqlite'));assert.equal(db.get('paused'),true);assert.ok(!db.get('heartbeat').stopped);db.close();
  await stopBackground(root);
});
