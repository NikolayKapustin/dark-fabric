import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watchWorker, workerHeartbeatTimeout } from '../src/watchdog.js';
import { stopTree } from '../src/process.js';
import { EventEmitter } from 'node:events';

const childProcess=code=>spawn(process.execPath,['-e',code],{windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','ignore','ignore','ipc']});
const closed=child=>new Promise(resolve=>child.once('exit',resolve));

test('watchdog kills an unresponsive worker tree after a grace period',async()=>{
  const child=childProcess("process.on('message',()=>{});setInterval(()=>{},1000)");
  const done=closed(child);let stalled=0;
  const cancel=watchWorker(child,{timeoutMs:150,graceMs:100,onStall:()=>stalled++});
  try {await done;assert.equal(stalled,1);assert.ok(child.exitCode!==null||child.signalCode!==null);}
  finally {cancel();stopTree(child);}
});

test('healthy idle or paused workers survive; cancelled watchdog does not restart an intentional stop',async()=>{
  const child=childProcess("setInterval(()=>{if(process.connected)process.send({type:'heartbeat'},()=>{})},20)");
  const done=closed(child);let stalled=0;
  const cancel=watchWorker(child,{timeoutMs:500,graceMs:50,onStall:()=>stalled++});
  try {
    await new Promise(r=>setTimeout(r,700));assert.equal(stalled,0);assert.equal(child.exitCode,null);
    cancel();child.disconnect();await new Promise(r=>setTimeout(r,550));assert.equal(stalled,0);
  } finally {cancel();stopTree(child);await done;}
});

test('long configured polling and quota RPC waits do not kill a healthy paused worker',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const config={pollMs:180_000,rpcTimeoutMs:90_000},timeoutMs=workerHeartbeatTimeout(config);
  assert.equal(workerHeartbeatTimeout({pollMs:3000,rpcTimeoutMs:30000}),120_000);
  const child=new EventEmitter();child.connected=true;const messages=[];child.send=message=>messages.push(message);
  let stalled=0;const cancel=watchWorker(child,{timeoutMs,onStall:()=>stalled++,terminate:()=>{}});
  try {
    for(let n=0;n<3;n++){
      t.mock.timers.tick(config.pollMs+config.rpcTimeoutMs*2+5000);
      assert.equal(stalled,0);child.emit('message',{type:'heartbeat'});
    }
    t.mock.timers.tick(timeoutMs);assert.equal(stalled,1);assert.deepEqual(messages,['shutdown']);
  }finally{cancel();}
});

test('a replacement worker reloads watchdog timing after configuration changes',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let config={pollMs:3000,rpcTimeoutMs:30000},reads=0,stalled=0;
  const launch=()=>{
    const child=new EventEmitter();child.connected=false;
    const cancel=watchWorker(child,{readConfig:()=>{reads++;return config;},onStall:()=>stalled++,terminate:()=>{}});
    return {child,cancel};
  };
  const old=launch();t.mock.timers.tick(120000);assert.equal(stalled,1);old.child.emit('close');
  config={...config,pollMs:180000};const replacement=launch();
  try {
    t.mock.timers.tick(180000);assert.equal(stalled,1);assert.equal(reads,2);
    replacement.child.emit('message',{type:'heartbeat'});
    t.mock.timers.tick(workerHeartbeatTimeout(config));assert.equal(stalled,2);
  }finally{old.cancel();replacement.cancel();}
});
