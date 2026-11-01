import { mkdirSync,writeFileSync,renameSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateRemoteConfig } from '../src/remote.js';
// Provision only from hidden stdin, never credentials in command-line arguments.
process.stdin.setEncoding('utf8');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('Ready for remote configuration JSON (input hidden).');
let input='';
process.stdin.on('data',chunk=>{
  input+=chunk;
  if(input.length>30000){console.error('Configuration too large');process.exit(1);}
  if(input.includes('\u0003'))process.exit(1);
  if(!/[\r\n]/.test(input))return;
  try{
    const config=validateRemoteConfig(JSON.parse(input.trim()));
    const home=path.resolve(process.argv[2]||'.darkfabric');mkdirSync(home,{recursive:true});
    const target=path.join(home,'remote.json'),temp=target+'.tmp';
    writeFileSync(temp,JSON.stringify(config,null,2),{mode:0o600});
    if(process.platform==='win32'){
      const account=spawnSync('whoami.exe',[],{encoding:'utf8',windowsHide:true});
      if(account.status!==0)throw new Error('Cannot determine owner');
      const acl=spawnSync('icacls.exe',[temp,'/inheritance:r','/grant:r',`${account.stdout.trim()}:(F)`,'SYSTEM:(F)'],{windowsHide:true,stdio:'ignore'});
      if(acl.status!==0)throw new Error('Cannot protect credentials');
    }
    renameSync(temp,target);
    console.log('Remote configuration saved.');process.exit(0);
  }catch{console.error('Invalid remote configuration');process.exit(1);}
});
