import { readFileSync,existsSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { RemoteBridge } from '../src/remote.js';
import { acquireLock } from '../src/service.js';
const {values}=parseArgs({options:{home:{type:'string'}}});
const home=path.resolve(values.home||'.darkfabric');
const lockRoot=path.join(home,'remote-worker');mkdirSync(lockRoot,{recursive:true});
const unlock=acquireLock(lockRoot);
const store=new Store(path.join(home,'factory.sqlite'));
const bridge=new RemoteBridge(store,loadConfig(home),JSON.parse(readFileSync(path.join(home,'remote.json'),'utf8')));
let stopped=false,timer,wake;
function stop(){stopped=true;clearTimeout(timer);wake?.();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
process.on('message',m=>{if(m==='shutdown')stop();});
let failures=0;
while(!stopped&&!existsSync(path.join(home,'remote.stop'))){
  let delay=10000;
  try{const result=await bridge.sync();failures=0;if(result.applied)delay=250;}
  catch(e){failures++;delay=Math.min(60000,5000*2**Math.min(failures-1,4));store.set('remote.status',{url:bridge.remote.url,at:Date.now(),ok:false,error:e.message});if(failures===1||failures%30===0)console.error(new Date().toISOString(),e.message);}
  if(process.connected)process.send({type:'heartbeat'},()=>{});
  if(!stopped)await new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,delay);});
}
store.close();unlock();process.exit(0);
