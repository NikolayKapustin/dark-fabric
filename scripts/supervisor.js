import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFileSync,existsSync,mkdirSync,statSync,renameSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { acquireLock } from '../src/service.js';
import { stopTree } from '../src/process.js';
import { watchWorker } from '../src/watchdog.js';
import { loadConfig } from '../src/config.js';

const {values}=parseArgs({options:{home:{type:'string'},role:{type:'string',default:'factory'}}});
if(!['factory','remote'].includes(values.role))throw new Error('Unknown supervisor role');
const remote=values.role==='remote';
const home=path.resolve(values.home||'.darkfabric');
const lockRoot=path.join(home,remote?'remote-supervisor':'supervisor');mkdirSync(lockRoot,{recursive:true});
let unlock;
try{unlock=acquireLock(lockRoot);}catch(e){console.error(e.message);process.exit(1);}
const cli=fileURLToPath(new URL(remote?'./remote-worker.js':'../src/cli.js',import.meta.url));
const logFile=path.join(lockRoot,'supervisor.log'),stopFile=path.join(home,remote?'remote.stop':'stop');
let child,stopping=false,restarts=0,timer,killTimer,cancelWatchdog;
function log(text){
  if(existsSync(logFile)&&statSync(logFile).size>5_000_000)renameSync(logFile,path.join(lockRoot,`supervisor-${Date.now()}.log`));
  appendFileSync(logFile,text);
}
function finish(){clearInterval(poll);clearTimeout(timer);clearTimeout(killTimer);unlock();process.exit(0);}
function shutdown(){
  if(stopping)return;stopping=true;clearTimeout(timer);cancelWatchdog?.();
  if(child&&child.exitCode===null){if(child.connected)child.send('shutdown');killTimer=setTimeout(()=>stopTree(child),15000);}
  else finish();
}
function launch(){
  if(stopping||existsSync(stopFile)){shutdown();return;}
  const started=Date.now();log(`\n${new Date().toISOString()} starting worker\n`);
  child=spawn(process.execPath,[cli,'--home',home,...(remote?[]:['serve'])],{cwd:path.dirname(path.dirname(cli)),windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc']});
  cancelWatchdog=watchWorker(child,{readConfig:remote?undefined:()=>loadConfig(home),onStall:()=>log(`${new Date().toISOString()} worker heartbeat stalled; stopping before recovery restart\n`)});
  child.stdout.on('data',d=>log(d));child.stderr.on('data',d=>log(d));
  child.on('error',e=>log(`spawn failed: ${e.message}\n`));
  child.on('close',code=>{
    if(stopping){finish();return;}
    if(Date.now()-started>300000)restarts=0;
    const delay=Math.min(60000,2000*2**Math.min(restarts++,5));
    log(`${new Date().toISOString()} worker exited ${code}; restart in ${delay}ms\n`);
    timer=setTimeout(launch,delay);
  });
}
const poll=setInterval(()=>{if(existsSync(stopFile))shutdown();},1000);
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
launch();
