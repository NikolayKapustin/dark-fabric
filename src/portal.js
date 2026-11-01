import path from 'node:path';
import {existsSync,rmSync,mkdirSync,readFileSync} from 'node:fs';
import {Store} from './store.js';
import {acquireLock,getToken} from './service.js';
import {createServer} from './server.js';

// The portal owns the same lock as the executor. It never recovers/claims work,
// reads Codex quota, starts a bridge, or clears an operator stop/pause.
export async function startPortal(config) {
  // Serialize against background start/stop, including a supervisor between
  // workers. A live bridge must not apply commands using an old heartbeat.
  const lifecycleRoot=path.join(config.root,'lifecycle');mkdirSync(lifecycleRoot,{recursive:true});
  const releaseLifecycle=acquireLock(lifecycleRoot);
  let unlock=()=>{};
  let store,server,timer,closing;
  const stopFile=path.join(config.root,'portal.stop');
  const close=()=>closing??=(async()=>{
    clearInterval(timer);
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    try{store?.close();}finally{unlock();}
  })();
  try {
    for(const role of ['supervisor','remote-supervisor','remote-worker']) {
      const file=path.join(config.root,role,'service.lock');
      if(!existsSync(file))continue;
      const {pid}=JSON.parse(readFileSync(file,'utf8'));
      if(!Number.isSafeInteger(pid)||pid<1)throw new Error('Invalid service lock');
      try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')continue;throw error;}
      throw new Error('A factory or bridge supervisor is running. Use its local portal, or stop it before portal-only mode.');
    }
    unlock=acquireLock(config.root);
    store=new Store(path.join(config.root,'factory.sqlite'));
    server=createServer(store,config,getToken(config.root),{mode:'portal'});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
    rmSync(stopFile,{force:true});
    timer=setInterval(()=>{if(existsSync(stopFile))void close();},250);
    return {server,close,url:`http://127.0.0.1:${server.address().port}`};
  } catch(error) {await close();throw error;}finally{releaseLifecycle();}
}
