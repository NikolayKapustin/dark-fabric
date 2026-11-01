import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runCommand } from '../src/process.js';

test('trusted local command times out rather than occupying the worker forever',async()=>{
  const r=await runCommand([process.execPath,'-e','setInterval(()=>{},1000)'],{timeoutMs:100});
  assert.equal(r.timedOut,true);assert.notEqual(r.code,0);
});
test('supervised commands drain their output before exiting',async()=>{
  const r=await runCommand([process.execPath,'-e',"process.stdout.write('x'.repeat(200000))"],{maxOutput:300000});
  assert.equal(r.code,0);assert.equal(r.stdout.length,200000);
});
test('process host kills orphaned Codex tree on stdin EOF and releases workspace lock',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df-host-')),workspace=path.join(root,'workspace');mkdirSync(workspace);
  const script=path.join(root,'fake.js');writeFileSync(script,"console.log('READY');setInterval(()=>{},1000);\n");
  const host=spawn(process.execPath,[fileURLToPath(new URL('../src/process-host.js',import.meta.url)),root,workspace,process.execPath,script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('host timeout')),5000);host.stdout.once('data',()=>{clearTimeout(timer);resolve();});host.once('error',reject);});
    const key=createHash('sha256').update(workspace.toLowerCase()).digest('hex'),lock=path.join(root,'worker-locks',key,'service.lock');assert.equal(existsSync(lock),true);
    host.stdin.end();await new Promise(r=>host.once('close',r));assert.equal(existsSync(lock),false);
  }finally{host.kill();rmSync(root,{recursive:true,force:true});}
});
