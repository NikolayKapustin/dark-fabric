import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {executable} from '../src/executable.js';
import {startBackground,stopBackground,servicePids} from '../src/lifecycle.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {diagnose} from '../src/doctor.js';
import {fixture} from './helpers.js';

test('Windows npm Codex entry point preserves spaces and shell characters without a shell',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df cli space '));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const entry=path.join(root,'node_modules/@openai/codex/bin/codex.js');mkdirSync(path.dirname(entry),{recursive:true});writeFileSync(entry,'');
  const args=['--config','literal & $(unchanged)'];
  assert.deepEqual(executable(['codex',...args],{platform:'win32',env:{Path:root},node:'node'}),['node',entry,...args]);
  assert.deepEqual(executable([path.join(root,'codex.cmd'),...args],{platform:'win32',env:{},node:'node'}),['node',entry,...args]);
  writeFileSync(path.join(root,'codex.exe'),'');
  assert.deepEqual(executable(['codex',...args],{platform:'win32',env:{PATH:root},node:'node'}),[path.join(root,'codex.exe'),...args]);
  assert.throws(()=>executable(['codex'],{platform:'win32',env:{},node:'node'}),/Cannot resolve/);
  assert.deepEqual(executable(['codex',...args],{platform:'darwin'}),['codex',...args]);
});

test('doctor reports missing prerequisites as failure, but exhausted quota is a valid connection',async t=>{
  const f=fixture(t);
  const runner={readQuota:async()=>({known:true,blocked:true})};
  const ok=await diagnose(f.config,f.store,{runner,command:async()=>({code:0,stdout:'ok',stderr:''})});
  assert.equal(ok.ok,true);assert.equal(ok.quota.blocked,true);
  const bad=await diagnose(f.config,f.store,{runner,command:async argv=>({code:argv[0]==='git'?1:0,stdout:'',stderr:'not found'})});
  assert.equal(bad.ok,false);assert.match(bad.checks[0].hint,/Git/);
});

test('existing usage buckets retain their timezone on upgrade; fresh stores use UTC',t=>{
  const f=fixture(t);assert.equal(f.store.get('usage:timeZone'),'UTC');
  const filename=path.join(f.root,'legacy.sqlite'),legacy=new Store(filename);
  legacy.db.prepare("DELETE FROM meta WHERE key='usage:timeZone'").run();legacy.close();
  const upgraded=new Store(filename);assert.equal(upgraded.get('usage:timeZone'),'Europe/Moscow');upgraded.close();
});

test('background start, duplicate start, stop, logon-stop preservation and explicit restart',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df lifecycle space '));
  const config={...loadConfig(root),port:await freePort()};
  writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
  const db=new Store(path.join(root,'factory.sqlite'));db.set('paused',true);db.close();
  // Paused fixture needs no Codex account and consumes no model calls.
  t.after(async()=>{await stopBackground(root);rmSync(root,{recursive:true,force:true});});
  const first=await startBackground(root);assert.ok(first.pids.length>=2);
  const second=await startBackground(root);assert.deepEqual(second.pids,first.pids);
  const shutdown=stopBackground(root),restart=startBackground(root);
  await shutdown;const replaced=await restart;
  assert.ok(replaced.pids.length>=2);assert.notDeepEqual(replaced.pids,first.pids);
  assert.deepEqual(servicePids(root),replaced.pids);
  await stopBackground(root);assert.deepEqual(servicePids(root),[]);
  const stoppedDb=new Store(path.join(root,'factory.sqlite'));assert.equal(stoppedDb.get('heartbeat').stopped,true);assert.equal(stoppedDb.get('paused'),true);stoppedDb.close();
  assert.equal((await startBackground(root,{respectStop:true})).stopped,true);assert.deepEqual(servicePids(root),[]);
  const again=await startBackground(root);assert.ok(again.pids.length>=2);
  assert.equal(existsSync(path.join(root,'stop')),false);
});

test('foreground serve honors stop markers and does not silently resume',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df foreground '));
  const config={...loadConfig(root),port:await freePort()};writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
  const db=new Store(path.join(root,'factory.sqlite'));db.set('paused',true);db.close();
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  const child=spawn(process.execPath,[cli,'--home',root,'serve'],{windowsHide:true,stdio:'ignore'});
  const closed=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{await stopBackground(root);child.kill();await closed;rmSync(root,{recursive:true,force:true});});
  for(let i=0;i<100&&!existsSync(path.join(root,'service.lock'));i++)await sleep(50);
  assert.ok(existsSync(path.join(root,'service.lock')));
  await stopBackground(root);assert.equal(await closed,0);
  const blocked=spawn(process.execPath,[cli,'--home',root,'serve'],{windowsHide:true,stdio:'ignore'});
  assert.equal(await new Promise(resolve=>blocked.once('close',resolve)),1);
  assert.deepEqual(servicePids(root),[]);
});

async function freePort(){
  const {createServer}=await import('node:net'),server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));return port;
}

test('failed startup does not report success from a transient lock or leave a restart loop',async t=>{
  const {createServer}=await import('node:net'),occupied=createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  const root=mkdtempSync(path.join(os.tmpdir(),'df occupied '));
  t.after(async()=>{await stopBackground(root);await new Promise(resolve=>occupied.close(resolve));rmSync(root,{recursive:true,force:true});});
  writeFileSync(path.join(root,'config.json'),JSON.stringify({...loadConfig(root),port:occupied.address().port}));
  await assert.rejects(startBackground(root,{timeoutMs:1200}),/Start timed out/);
  assert.deepEqual(servicePids(root),[]);assert.ok(existsSync(path.join(root,'stop')));
});
