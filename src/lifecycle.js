import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from './sqlite.js';
import { acquireLock } from './service.js';

export const stateHome = value => path.resolve(value||process.env.DARK_FABRIC_HOME||'.darkfabric');
export function runningPid(file) {
  let lock;
  try{lock=readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const {pid}=JSON.parse(lock);
  if(!Number.isSafeInteger(pid)||pid<1)throw new Error(`Invalid process lock: ${file}`);
  try{process.kill(pid,0);return pid;}catch(e){if(e.code==='ESRCH')return null;throw e;}
}
export function servicePids(home) {
  return ['service.lock','supervisor/service.lock','remote-supervisor/service.lock','remote-worker/service.lock']
    .map(file=>runningPid(path.join(home,file))).filter(Boolean);
}
function ready(home,roles){
  const pid=runningPid(path.join(home,'service.lock'));
  if(!pid||!existsSync(path.join(home,'factory.sqlite')))return false;
  let db;
  try{
    db=new Database(path.join(home,'factory.sqlite'),{readonly:true,fileMustExist:true});
    const heartbeat=JSON.parse(db.prepare("SELECT value FROM meta WHERE key='heartbeat'").get()?.value||'null');
    return heartbeat?.pid===pid&&!heartbeat.stopped&&Date.now()-heartbeat.at<60000
      &&roles.every(role=>role==='factory'||runningPid(path.join(home,'remote-worker/service.lock')));
  }catch{return false;}finally{db?.close();}
}
async function operation(home,action){
  home=stateHome(home);const root=path.join(home,'lifecycle');mkdirSync(root,{recursive:true});
  const deadline=Date.now()+60000;let release;
  while(!release){
    try{release=acquireLock(root);}catch(e){
      if(!/already running/.test(e.message)||Date.now()>=deadline)throw e;
      await sleep(100);
    }
  }
  try{return await action(home);}finally{release();}
}
export const startBackground=(home,options)=>operation(home,h=>start(h,options));
export const stopBackground=(home,options)=>operation(home,h=>stop(h,options));

async function start(home,{respectStop=false,timeoutMs=20000}={}) {
  home=stateHome(home);mkdirSync(home,{recursive:true});
  if(respectStop&&existsSync(path.join(home,'stop')))return {stopped:true,home};
  const owner=runningPid(path.join(home,'service.lock'));
  const supervisor=runningPid(path.join(home,'supervisor/service.lock'));
  if(owner&&!supervisor)throw new Error('A foreground factory is already running; stop it before starting a supervisor.');
  // Only an explicit start clears a persisted operator stop. Logon never does.
  for(const name of ['stop','remote.stop'])rmSync(path.join(home,name),{force:true});
  const roles=['factory',...(existsSync(path.join(home,'remote.json'))?['remote']:[])];
  const hadServices=servicePids(home).length>0;
  for(const role of roles){
    const dir=path.join(home,role==='remote'?'remote-supervisor':'supervisor');mkdirSync(dir,{recursive:true});
    if(runningPid(path.join(dir,'service.lock')))continue;
    const fd=openSync(path.join(dir,'launcher.log'),'a',0o600);
    try{
      const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/supervisor.js',import.meta.url)),'--home',home,'--role',role],{
        cwd:fileURLToPath(new URL('..',import.meta.url)),detached:true,windowsHide:true,stdio:['ignore',fd,fd],
      });
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    }finally{closeSync(fd);}
  }
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(ready(home,roles))return {home,pids:servicePids(home)};
    await sleep(100);
  }
  if(!hadServices)await stop(home);
  throw new Error(`Start timed out. Inspect ${home}/supervisor/ and ${home}/remote-supervisor/ logs.`);
}
async function stop(home,{timeoutMs=25000}={}) {
  home=stateHome(home);mkdirSync(home,{recursive:true});
  for(const file of ['stop','remote.stop'])writeFileSync(path.join(home,file),'Operator requested stop\n');
  const deadline=Date.now()+timeoutMs;
  while(servicePids(home).length&&Date.now()<deadline)await sleep(100);
  const pids=servicePids(home);
  if(pids.length)throw new Error(`Shutdown still pending for PID(s) ${pids.join(', ')}. Stop markers remain; do not start another writer.`);
  return {home,stopped:true};
}
