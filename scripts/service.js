import { parseArgs } from 'node:util';
import { startBackground, stopBackground, stateHome, servicePids } from '../src/lifecycle.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{home:{type:'string'},'respect-stop':{type:'boolean'}}});
const home=stateHome(values.home);
try {
  const action=positionals[0];
  if(action==='start')console.log(JSON.stringify(await startBackground(home,{respectStop:values['respect-stop']})));
  else if(action==='stop')console.log(JSON.stringify(await stopBackground(home)));
  else if(action==='status')console.log(JSON.stringify({home,pids:servicePids(home)}));
  else throw new Error('Usage: node scripts/service.js start|stop|status [--home PATH] [--respect-stop]');
}catch(e){console.error(e.message);process.exitCode=1;}
