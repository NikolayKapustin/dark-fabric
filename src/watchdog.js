import { stopTree } from './process.js';

export function workerHeartbeatTimeout({pollMs,rpcTimeoutMs}) {
  // A tick can wait for initialize + quota RPCs and process shutdown. Include
  // the configured poll interval, including when the operator has paused work.
  return Math.min(2_147_483_647,Math.max(120_000,pollMs*2+rpcTimeoutMs*2+15_000));
}

// The parent owns this timer: a blocked worker event loop cannot keep it alive.
// A replacement is started by the supervisor only after the old child closes.
export function watchWorker(child,{timeoutMs=120_000,graceMs=15_000,onStall=()=>{},terminate=stopTree,readConfig}={}) {
  // Read on every replacement, just as the new worker does. Invalid config is
  // reported by that worker; retain a default watchdog while it exits/retries.
  if(readConfig)try{timeoutMs=workerHeartbeatTimeout(readConfig());}catch{ /* keep the default deadline */ }
  let timer,killTimer,stalled=false,closed=false;
  const cancel=()=>{closed=true;clearTimeout(timer);clearTimeout(killTimer);child.off('message',heartbeat);child.off('close',cancel);};
  const arm=()=>{
    clearTimeout(timer);
    timer=setTimeout(()=>{
      if(closed||stalled)return;
      stalled=true;onStall();
      if(child.connected)child.send('shutdown',()=>{});
      killTimer=setTimeout(()=>{if(!closed)terminate(child);},graceMs);
    },timeoutMs);
  };
  const heartbeat=message=>{if(!closed&&!stalled&&message?.type==='heartbeat')arm();};
  child.on('message',heartbeat);child.once('close',cancel);arm();
  return cancel;
}
