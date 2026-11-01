import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    killer.on('error',()=>child.kill());
  } else {
    try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function runCommand(argv, { cwd, timeoutMs = 120_000, signal, maxOutput = 120_000, env = process.env, stateRoot=process.cwd(), workspaceLock='' } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(v=>typeof v!=='string')) throw new Error('Command must be an argv array');
  return new Promise((resolve,reject)=> {
    const child=spawn(process.execPath,[fileURLToPath(new URL('./process-host.js',import.meta.url)),stateRoot,workspaceLock,...argv],{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],shell:false});
    let stdout='',stderr='',timedOut=false,aborted=false;
    let forceKill;
    const terminate=()=>{child.stdin.end();forceKill=setTimeout(()=>stopTree(child),5000);};
    child.stdin.on('error',()=>{});
    child.stdout.on('data',d=>{ stdout=(stdout+d).slice(-maxOutput); });
    child.stderr.on('data',d=>{ stderr=(stderr+d).slice(-maxOutput); });
    const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
    const abort=()=>{aborted=true;terminate();};
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    const cleanup=()=>{clearTimeout(timer);clearTimeout(forceKill);signal?.removeEventListener('abort',abort);};
    child.once('error',e=>{cleanup();reject(e);});
    child.once('close',(code)=>{cleanup();resolve({code,stdout,stderr,timedOut,aborted});});
  });
}
